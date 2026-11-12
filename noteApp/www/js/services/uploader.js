import { waitUntilOnline } from './network.js';

const PENDING_UPLOAD_KEY = 'mboaflash.pendingUpload.v1';
const FILE_DATABASE = 'mboaflash-uploads';
const FILE_STORE = 'sources';
const UPLOAD_TIMEOUT_MS = 120000;
// Délai minimal entre deux envois de morceaux (ms).
// Laisse le moteur JS et la pile réseau du WebView Android respirer entre deux
// requêtes PUT, évitant les protections anti-abus du navigateur mobile.
const INTER_CHUNK_DELAY_MS = 30;
// Taille de morceau proposée au backend : doit correspondre à UPLOAD_CHUNK_MAX_BYTES côté serveur.
// Le backend valide strictement que chaque morceau (sauf le dernier) a exactement cette taille.
const UPLOAD_CHUNK_BYTES = 1048576; // 1 MiB — identique à la valeur par défaut du backend

// ─────────────────────────────────────────────────────────────────────────────
// NOTE ARCHITECTURE — Pourquoi on n'utilise PLUS l'API Cordova File pour les vidéos
// ─────────────────────────────────────────────────────────────────────────────
// Sur Android WebView (Cordova), le fichier sélectionné via <input type="file">
// est accessible par un URI content:// ou file:// accordé par le système.
// Ce grant d'accès est ÉPHÉMÈRE et LIMITÉ :
//
//   • Appeler blob.slice() en boucle sur ce File objet (ex. pour le copier dans
//     l'API Cordova File) consomme plusieurs accès natifs et déclenche rapidement :
//     "It was determined that certain files are unsafe for access within a Web
//      application, or that too many calls are being made on file resources."
//
//   • Un File retourné par entry.file() (Cordova File Plugin) est également
//     backed par un path natif et souffre du même problème lors d'appels
//     répétés à arrayBuffer() ou FileReader.
//
// SOLUTION : lire le fichier UNE SEULE FOIS en ArrayBuffer via FileReader
// immédiatement après la sélection (tant que le grant d'accès est fresh),
// puis persister le Blob résultant dans IndexedDB — stockage browser, sans
// aucune restriction d'accès natif. Toute la suite se fait en RAM pure.
// ─────────────────────────────────────────────────────────────────────────────

export function getPendingUpload() {
  try {
    const saved = window.localStorage.getItem(PENDING_UPLOAD_KEY);
    if (!saved) return null;
    const pending = JSON.parse(saved);
    return pending && typeof pending.sourceId === 'string' ? pending : null;
  } catch (error) {
    console.error('État de reprise de l\u2019envoi illisible.', error);
    return null;
  }
}

export async function uploadVideo(file, fields, api, onProgress = () => {}) {
  if (getPendingUpload()) {
    throw new Error('Une vid\u00e9o pr\u00e9c\u00e9dente est encore en attente. Reprenez-la avant un nouvel envoi.');
  }
  if (!file || !Number.isSafeInteger(file.size) || file.size < 1) {
    throw new Error('Le fichier vid\u00e9o est vide ou trop volumineux pour cet appareil.');
  }

  const pending = {
    sourceId: createId(),
    // sourceKind est toujours 'indexeddb' : on ne passe JAMAIS par l'API
    // Cordova File pour les vidéos (voir note architecture ci-dessus).
    sourceKind: 'indexeddb',
    fileName: String(file.name || 'video'),
    mimeType: file.type || 'video/mp4',
    totalSize: file.size,
    fields,
    uploadId: null,
    totalChunks: 0,
    chunkSize: 0,
  };
  savePendingUpload(pending);

  // ── Lecture unique du fichier pendant que le grant d'accès est encore valide ──
  // On lit l'intégralité du fichier en ArrayBuffer MAINTENANT, en un seul appel
  // FileReader, avant toute opération asynchrone supplémentaire qui pourrait
  // invalider le grant d'accès Android. Zéro slice(), zéro boucle sur le File original.
  onProgress(0, 1, 'Pr\u00e9paration de la vid\u00e9o...');
  let rawBuffer;
  try {
    rawBuffer = await readFileAsArrayBuffer(file);
  } catch (error) {
    await clearPendingUpload(pending);
    throw new Error(`Impossible de lire la vid\u00e9o s\u00e9lectionn\u00e9e. ${error.message}`);
  }

  // Convertir l'ArrayBuffer en Blob pour le stocker dans IndexedDB.
  // Un Blob IndexedDB n'a aucune restriction d'accès native — on peut appeler
  // .arrayBuffer() ou .slice() dessus autant de fois que nécessaire.
  const sourceBlob = new Blob([rawBuffer], { type: pending.mimeType });
  rawBuffer = null; // libérer la référence pour le GC

  try {
    await writeIndexedDbFile(sourceBlob, pending.sourceId);
  } catch (error) {
    await clearPendingUpload(pending);
    throw error;
  }
  return transferPendingUpload(pending, api, onProgress);
}

export async function resumePendingVideo(api, onProgress = () => {}) {
  const pending = getPendingUpload();
  if (!pending) return null;
  const status = pending.uploadId
    ? await api(`/api/media/uploads/${encodeURIComponent(pending.uploadId)}`, {
      timeoutMs: UPLOAD_TIMEOUT_MS,
    }, true)
    : null;
  let file;
  try {
    // readSourceFile lit depuis IndexedDB — aucune restriction d'accès natif.
    file = await readSourceFile(pending);
  } catch (error) {
    await clearPendingUpload(pending);
    throw new Error(`Le fichier vid\u00e9o local est introuvable. S\u00e9lectionnez-le \u00e0 nouveau. ${error.message}`);
  }
  if (file.size !== pending.totalSize) {
    await clearPendingUpload(pending);
    throw new Error('Le fichier vid\u00e9o enregistr\u00e9 est incomplet. S\u00e9lectionnez-le \u00e0 nouveau pour reprendre.');
  }
  return transferPendingUpload(pending, api, onProgress, status);
}

async function transferPendingUpload(pending, api, onProgress, resumedStatus = null) {
  if (!pending.uploadId) {
    const start = await api('/api/media/uploads', {
      method: 'POST',
      body: JSON.stringify({
        ...pending.fields,
        mime_type: pending.mimeType,
        total_size: pending.totalSize,
        chunk_size: UPLOAD_CHUNK_BYTES,
      }),
      timeoutMs: UPLOAD_TIMEOUT_MS,
    }, true);
    pending.uploadId = start.uploadId;
    pending.totalChunks = Number(start.totalChunks ?? start.total_chunks);
    pending.chunkSize = Number(start.chunkSize ?? start.chunk_size);
    if (!Number.isSafeInteger(pending.chunkSize) || pending.chunkSize < 1
      || !Number.isSafeInteger(pending.totalChunks) || pending.totalChunks < 1) {
      throw new Error('Le serveur n\u2019a pas confirm\u00e9 une taille de morceau valide.');
    }
    savePendingUpload(pending);
  }

  // Lire le Blob depuis IndexedDB (aucune restriction d'accès natif).
  const blob = await readSourceFile(pending);

  const status = resumedStatus || await api(`/api/media/uploads/${encodeURIComponent(pending.uploadId)}`, {
    timeoutMs: UPLOAD_TIMEOUT_MS,
  }, true);

  // Le backend fait autorité sur chunkSize et totalChunks.
  const serverChunkSize = Number(status.chunkSize ?? status.chunk_size ?? pending.chunkSize);
  const totalChunks = Number(status.totalChunks ?? status.total_chunks ?? pending.totalChunks);
  const receivedChunks = status.receivedChunks ?? status.received_chunks ?? [];
  if (!Array.isArray(receivedChunks)) {
    throw new Error('Le serveur a renvoy\u00e9 une liste de morceaux re\u00e7us invalide.');
  }
  const received = new Set(receivedChunks.map(Number));

  pending.totalChunks = totalChunks;
  pending.chunkSize = serverChunkSize;

  if (!['in_progress', 'complete'].includes(status.status)) {
    throw new Error('Cette session d\u2019envoi n\u2019est plus active sur le serveur.');
  }
  if (!Number.isSafeInteger(totalChunks) || totalChunks < 1
    || !Number.isSafeInteger(serverChunkSize) || serverChunkSize < 1
    || totalChunks !== Math.ceil(blob.size / serverChunkSize)
    || [...received].some((i) => !Number.isSafeInteger(i) || i < 0 || i >= totalChunks)) {
    throw new Error('Le serveur a renvoy\u00e9 un \u00e9tat d\u2019envoi invalide.');
  }
  savePendingUpload(pending);

  // ── Chargement unique en ArrayBuffer ───────────────────────────────────────
  // Le Blob vient d'IndexedDB : appeler .arrayBuffer() sur lui est totalement
  // sûr (aucune restriction Android). On charge tout en RAM une seule fois,
  // puis on découpe avec subarray() — zéro I/O disque supplémentaire.
  onProgress(received.size, totalChunks, 'Chargement de la vid\u00e9o en m\u00e9moire...');
  let fileBuffer;
  try {
    fileBuffer = await blob.arrayBuffer();
  } catch (bufferError) {
    throw new Error(`Impossible de lire la vid\u00e9o en m\u00e9moire. ${bufferError.message}`);
  }
  const fileBytes = new Uint8Array(fileBuffer);
  if (fileBytes.length !== blob.size) {
    throw new Error(`Lecture incompl\u00e8te\u00a0: ${fileBytes.length} octets lus au lieu de ${blob.size}.`);
  }

  let sentCount = received.size;
  onProgress(sentCount, totalChunks);

  // Les indices démarrent à 0 (0-indexed, conforme au backend).
  // serverChunkSize (variable locale gelée) est l'unique source de vérité.
  for (let index = 0; index < totalChunks; index += 1) {
    if (received.has(index)) continue;

    if (navigator.onLine === false) {
      onProgress(sentCount, totalChunks, 'Envoi en pause \u00b7 attente du r\u00e9seau...');
      await waitUntilOnline();
    }

    // Découpage en mémoire (zéro I/O) : subarray() est une vue sur le même
    // ArrayBuffer, sans copie. start = index × serverChunkSize (alignement exact
    // attendu par le backend). end borné à fileBytes.length pour le dernier morceau.
    const start = index * serverChunkSize;
    const end = Math.min(start + serverChunkSize, fileBytes.length);
    if (start >= fileBytes.length || end <= start) {
      throw new Error(`Impossible de d\u00e9couper le morceau ${index + 1}.`);
    }
    const slice = fileBytes.subarray(start, end);
    const expectedSize = Math.min(serverChunkSize, fileBytes.length - start);
    if (slice.length !== expectedSize) {
      throw new Error(`Taille incorrecte pour le morceau ${index + 1}\u00a0: ${slice.length} au lieu de ${expectedSize} octets.`);
    }
    // Blob wrapper : fetch envoie Content-Length exact et Content-Type sans ambiguïté.
    const chunk = new Blob([slice], { type: 'application/octet-stream' });

    await retryChunk(api, pending.uploadId, index, chunk, (message) => {
      onProgress(sentCount, totalChunks, message);
    });
    sentCount += 1;
    onProgress(sentCount, totalChunks);

    // Délai inter-chunk : laisse le WebView Android libérer la pile réseau
    // entre deux PUT. Imperceptible sur le débit, évite les protections anti-abus.
    if (index < totalChunks - 1) await delay(INTER_CHUNK_DELAY_MS);
  }

  onProgress(sentCount, totalChunks, 'Finalisation de la vid\u00e9o...');
  const result = await api(`/api/media/uploads/${encodeURIComponent(pending.uploadId)}/complete`, {
    method: 'POST',
    timeoutMs: UPLOAD_TIMEOUT_MS,
  }, true);
  await clearPendingUpload(pending);
  return result;
}

async function retryChunk(api, uploadId, index, chunk, onStatus) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await api(`/api/media/uploads/${encodeURIComponent(uploadId)}/chunks/${index}`, {
        method: 'PUT',
        body: chunk,
        headers: { 'Content-Type': 'application/octet-stream' },
        timeoutMs: UPLOAD_TIMEOUT_MS,
      }, true, true);
      return;
    } catch (error) {
      lastError = error;
      const retryable = !error.status
        || error.status === 408
        || error.status === 429
        || error.status >= 500;
      if (!retryable) {
        throw new Error(`Le serveur a refus\u00e9 le morceau ${index + 1}. ${error.message}`);
      }
      if (attempt < 2) {
        if (navigator.onLine === false) {
          onStatus(`Envoi en pause au morceau ${index + 1} \u00b7 attente du r\u00e9seau...`);
          await waitUntilOnline();
        } else {
          onStatus(`Nouvelle tentative du morceau ${index + 1}...`);
          await delay(700 * (attempt + 1));
        }
      }
    }
  }
  throw new Error(`Connexion interrompue au morceau ${index + 1}. Reprenez l\u2019envoi. ${lastError?.message || ''}`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function savePendingUpload(pending) {
  try {
    window.localStorage.setItem(PENDING_UPLOAD_KEY, JSON.stringify(pending));
  } catch (error) {
    console.error('Impossible de sauvegarder l\u2019\u00e9tat de reprise de la vid\u00e9o.', error);
    throw new Error('Impossible de m\u00e9moriser cet envoi sur l\u2019appareil.');
  }
}

function createId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Lit un File/Blob en ArrayBuffer en une seule passe, sans aucun slice().
 * Utilise file.arrayBuffer() si disponible (Android WebView 69+),
 * sinon FileReader (repli universel).
 * À appeler UNE SEULE FOIS sur le File original sélectionné par l'utilisateur,
 * tant que le grant d'accès Android est encore valide.
 */
function readFileAsArrayBuffer(file) {
  if (typeof file.arrayBuffer === 'function') {
    return file.arrayBuffer();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Lecture du fichier vid\u00e9o impossible (FileReader).'));
    reader.readAsArrayBuffer(file);
  });
}

function readSourceFile(pending) {
  // sourceKind est toujours 'indexeddb' depuis la version courante.
  // On garde le cas 'cordova' uniquement pour les sessions de reprise
  // créées par une ancienne version de l'app (rétrocompatibilité).
  return pending.sourceKind === 'cordova'
    ? readCordovaFile(pending.sourceName)
    : readIndexedDbFile(pending.sourceId);
}

function deleteSourceFile(pending) {
  return pending.sourceKind === 'cordova'
    ? deleteCordovaFile(pending.sourceName)
    : deleteIndexedDbFile(pending.sourceId);
}

// ── IndexedDB ─────────────────────────────────────────────────────────────────

function openFileDatabase() {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(FILE_DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(FILE_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Stockage local indisponible.'));
  });
}

async function writeIndexedDbFile(blob, id) {
  const database = await openFileDatabase();
  try {
    await runFileTransaction(database, 'readwrite', (store) => store.put(blob, id));
  } finally {
    database.close();
  }
}

async function readIndexedDbFile(id) {
  const database = await openFileDatabase();
  try {
    const blob = await runFileTransaction(database, 'readonly', (store) => store.get(id));
    if (!blob) throw new Error('La vid\u00e9o enregistr\u00e9e est introuvable sur cet appareil.');
    return blob;
  } finally {
    database.close();
  }
}

async function deleteIndexedDbFile(id) {
  const database = await openFileDatabase();
  try {
    await runFileTransaction(database, 'readwrite', (store) => store.delete(id));
  } finally {
    database.close();
  }
}

function runFileTransaction(database, mode, operation) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(FILE_STORE, mode);
    const request = operation(transaction.objectStore(FILE_STORE));
    let result;
    request.onsuccess = () => { result = request.result; };
    request.onerror = () => reject(request.error || new Error('Acc\u00e8s au fichier vid\u00e9o impossible.'));
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error || new Error('Stockage du fichier vid\u00e9o impossible.'));
    transaction.onabort = () => reject(transaction.error || new Error('Stockage du fichier vid\u00e9o interrompu.'));
  });
}

// ── Cordova File (rétrocompatibilité reprise uniquement) ──────────────────────
// Ces fonctions ne sont plus appelées lors d'un nouvel upload.
// Elles restent présentes pour gérer les sessions de reprise créées
// par une ancienne version de l'app (sourceKind === 'cordova' en localStorage).

function readCordovaFile(name) {
  return new Promise((resolve, reject) => {
    window.resolveLocalFileSystemURL(window.cordova.file.dataDirectory, (directory) => {
      directory.getFile(name, { create: false }, (entry) => {
        entry.file(resolve, reject);
      }, reject);
    }, reject);
  });
}

function deleteCordovaFile(name) {
  return new Promise((resolve, reject) => {
    window.resolveLocalFileSystemURL(window.cordova.file.dataDirectory, (directory) => {
      directory.getFile(name, { create: false }, (entry) => entry.remove(resolve, reject), reject);
    }, (error) => {
      if (error?.code === window.FileError?.NOT_FOUND_ERR) resolve();
      else reject(error);
    });
  });
}

// ── Misc ──────────────────────────────────────────────────────────────────────

async function clearPendingUpload(pending) {
  try {
    window.localStorage.removeItem(PENDING_UPLOAD_KEY);
  } catch (error) {
    console.error('L\u2019\u00e9tat local de l\u2019envoi termin\u00e9 n\u2019a pas pu \u00eatre supprim\u00e9.', error);
    return;
  }
  try {
    await deleteSourceFile(pending);
  } catch (error) {
    console.error('La vid\u00e9o envoy\u00e9e n\u2019a pas pu \u00eatre supprim\u00e9e du stockage temporaire.', error);
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}
