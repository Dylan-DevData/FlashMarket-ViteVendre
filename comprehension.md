### ÉTAPE 1 : Côté Vendeur — Sélection, Stockage local &amp; Upload par morceaux

#### 1.1\. Sélection et basculement vers le pipeline vidéo

* **Fichier** : `noteApp/www/js/app.js` (dans `submitPost`)  liigne 1628
* **Code clé** :

```
if (hasVideo) {
    result = await uploadVideoInChunks(files, formData);
} else {
    result = await api('/api/posts', { method: 'POST', body: formData }, true);
}

```

* **Explication** :  `app.js` intercepte la sélection d'une vidéo et bascule vers le service d'upload résilient `uploadVideoInChunks()`.



#### 1.2\. Lecture unique et stockage dans IndexedDB

* **Fichier** : `noteApp/www/js/services/uploader.js` (dans `uploadVideo`)
* **Code clé** :

```
ligne  79
// 1. Lecture binaire unique tant que les accès Android sont valides
rawBuffer = await readFileAsArrayBuffer(file);

ligne 88 

// 2. Encapsulation dans un Blob sans restriction d'accès natif
const sourceBlob = new Blob([rawBuffer], { type: pending.mimeType });
rawBuffer = null; // Libération de la mémoire pour le Garbage Collector

ligne 92
// 3. Sauvegarde dans IndexedDB (base 'mboaflash-uploads')
await writeIndexedDbFile(sourceBlob, pending.sourceId);

```

* **Explication** : Sur Android WebView (Cordova), appeler des méthodes de découpage sur un fichier système natif (`content://`) déclenche rapidement des blocages de sécurité (*"unsafe for access"*). Le fichier est lu **une seule fois** en mémoire, transformé en `Blob` et persistant dans **IndexedDB**. Toutes les opérations ultérieures lisent ce Blob local sans restriction.
 * **Resume**: un  blob  (binary  large object) est  tout simplement un  paquet d'octect  brutes  gerer  par  le navigateur et  lorsque  on  recupere  un  fichier  via js  par defaut  est  blob  mais le soucis   est sur  un smartphone  android  avec   cordova  c'est  le webview   en  gros :File :Représenter un fichier sélectionné
Blob :	Manipuler les données binaires
Blob.slice():	Découper la vidéo en morceaux
IndexedDB:	Stocker temporairement la vidéo et les données de reprise

* **details-comprehension**:  ### 1\. C'est quoi un `Blob` (Binary Large Object) ?

Un **Blob**, c'est tout simplement un **paquet d'octets bruts** géré par le navigateur (du texte, une image, ou une vidéo).

* **Analogie simple** : Imaginez un fichier sur votre disque comme de l'eau. Un `Blob`, c'est une **bouteille fermée** dans laquelle le navigateur a versé cette eau. Vous ne pouvez pas modifier ce qu'il y a dedans (il est immuable), mais vous pouvez transporter la bouteille, la stocker dans une armoire (**IndexedDB**), ou en verser un petit verre de 1 Mo (**un chunk**) quand vous en avez besoin.
* En JavaScript, l'objet `File` (ce que vous récupérez quand vous sélectionnez une vidéo dans votre téléphone) est **déjà** un type spécial de `Blob` !

---

### 2\. Pourquoi le transformer en Blob et le stocker dans IndexedDB ?

Sur un smartphone Android avec **Apache Cordova** (l'application mobile) :

1. **Le problème d'Android (** **content://** **)** : Quand vous choisissez une vidéo, Android vous donne un chemin temporaire (du type `content://media/external/video/123`).
2. **Le piège** : Si l'upload échoue après 3 minutes à cause du réseau et que l'application veut reprendre l'envoi plus tard, Android révoque souvent les permissions d'accès à ce chemin temporaire pour des raisons de sécurité (*"unsafe for access"*).
3. **La solution** **IndexedDB** : En lisant la vidéo au moment de la sélection et en la mettant dans **IndexedDB** (la base de données locale du navigateur du téléphone), la vidéo est définitivement copiée dans le coffre-fort local de votre application. Même si Android ferme le lien d'origine ou si vous fermez l'application, **la vidéo reste stockée dans IndexedDB** et le transfert pourra reprendre sans bug d'autorisation.

#### A. Ce que fait le code actuel dans `uploader.js`

Dans le projet, le code fait ceci :

```
rawBuffer = await readFileAsArrayBuffer(file); // Charge TOUT le fichier en RAM
const sourceBlob = new Blob([rawBuffer]);      // Crée le Blob
rawBuffer = null;                              // Demande de vider la RAM
await writeIndexedDbFile(sourceBlob, ...);    // Copie le Blob dans IndexedDB
```

#### 1.3\. Découpage binaire en morceaux de 1 Mo (Chunking)

* **Fichier** : `noteApp/www/js/services/uploader.js` (dans `transferPendingUpload`)
* **Code clé** :
ligne  123 : 
```
const UPLOAD_CHUNK_BYTES = 1048576; // 1 MiB (exactement 1 048 576 octets)
...
const fileBytes = new Uint8Array(fileBuffer);

// Calcul des bornes de la tranche
const start = index * serverChunkSize;
const end = Math.min(start + serverChunkSize, fileBytes.length);

// Découpage zéro-copie en mémoire
const slice = fileBytes.subarray(start, end);
const chunk = new Blob([slice], { type: 'application/octet-stream' });

```

* **Explication** : `subarray(start, end)` crée une vue binaire directe sur le tampon mémoire **sans dupliquer les données en RAM**. La tranche de 1 Mo est encapsulée dans un Blob binaire brut d'envoi (`application/octet-stream`).

####  Pourquoi 1 Mo est la taille idéale (le "sweet spot") ?

* **Équilibre optimal** : Pour une vidéo moyenne de 10 à 30 Mo, cela représente seulement 10 à 30 requêtes `PUT`[6][10]. C'est suffisant pour maintenir un très bon débit sans multiplier inutilement les requêtes HTTP, tout en garantissant qu'en cas de coupure, la perte de progression reste minime (maximum 1 Mo)[2][11].

---

### 2\. Les avantages techniques complémentaires

* **Gestion fluide de la mémoire RAM du téléphone** : Un morceau de 1 Mo extrait via `Uint8Array.subarray()` crée une vue binaire légère en mémoire sans dupliquer les octets[12].
* **Gestion des pauses réseau (** **INTER\_CHUNK\_DELAY\_MS = 30** **)** : Entre chaque envoi de 1 Mo, l'application effectue une pause de 30 ms pour laisser la pile réseau du WebView Android respirer et éviter les blocages du navigateur mobile[9][13].
* **Économie de mémoire serveur** : Le backend Node.js écrit directement chaque tranche `.part` de 1 Mo sur le disque sans avoir à charger l'intégralité de la vidéo en mémoire vive[8][14].




#### 1.4\. Protocole d'upload et reprise après coupure (Resumable Upload)

* **Fichier** : `noteApp/www/js/services/uploader.js` (dans `transferPendingUpload` et `retryChunk`)
* **Code clé** :

```
// Étape A — Initialisation : Obtention de l'uploadId
const start = await api('/api/media/uploads', {
  method: 'POST',
  body: JSON.stringify({ ...pending.fields, mime_type: pending.mimeType, total_size: pending.totalSize, chunk_size: UPLOAD_CHUNK_BYTES })
});

// Étape B — Transfert avec vérification des morceaux déjà reçus
const received = new Set(receivedChunks.map(Number));

for (let index = 0; index &lt; totalChunks; index += 1) {
  if (received.has(index)) continue; // Saute les morceaux déjà enregistrés sur le serveur !
  
  if (navigator.onLine === false) await waitUntilOnline();

  await retryChunk(api, pending.uploadId, index, chunk);
  if (index &lt; totalChunks - 1) await delay(30); // Délai de 30 ms pour libérer le WebView
}

// Étape C — Finalisation
const result = await api(`/api/media/uploads/${pending.uploadId}/complete`, { method: 'POST' });

```

* **Explication** :
  1. `POST /api/media/uploads` crée la session serveur et génère un `uploadId`.
  2. En cas de réapparition du réseau après une interruption, `received.has(index)` compare la liste des morceaux reçus par le serveur (`receivedChunks`) avec les morceaux locaux et reprend l'envoi au premier morceau manquant sans recommencer depuis le début.
  3. Un délai de 30 ms entre les requêtes `PUT` évite de saturer la pile réseau du mobile.
  4. `POST /complete` déclenche la finalisation sur le backend.



### 📌 ÉTAPE 2 : Côté Serveur — Réception, Assemblage et File d'Attente

#### 2.1\. Réception et stockage des morceaux `.part`

* **Fichier** : `backend/src/controllers/media.controller.js` (dans `receiveChunk`)
* **Code clé** :

```
// Écriture du morceau sous la forme d'un fichier .part sur le disque
const partPath = path.join(uploadDir, `${chunkIndex}.part`);
await fs.writeFile(partPath, chunkData);

// Inscription de la réception dans PostgreSQL
await mediaModel.markChunkReceived(uploadId, chunkIndex);

```

* **Explication** : Chaque morceau reçu par `PUT` est enregistré sous la forme d'un fichier binaire `.part` dans `uploads/chunks/


* **details** :  L'extension .part est une convention de nommage qui signifie "partial" (partiel) ou "partie".Dans le code de FlashMarket-ViteVendre, l'utilisation de .part a plusieurs rôles très précis :1. Indiquer un fichier temporaire et incompletLe suffixe .part signale au système d'exploitation et au serveur que ce fichier n'est pas une vidéo exploitable, mais seulement un morceau binaire brut (un chunk de 1 Mo).Si le fichier s'appelait 0.mp4, le système ou un lecteur multimédia pourrait tenter de l'ouvrir et déclencher une erreur, car un morceau de 1 Mo isolé ne possède pas l'entête vidéo complet.2. Organiser l'assemblage dans le bon ordreChaque morceau reçu par le serveur est nommé selon son numéro d'index :Morceau 0 $\rightarrow$ 0.partMorceau 1 $\rightarrow$ 1.partMorceau 2 $\rightarrow$ 2.partLors de l'étape de finalisation (POST /complete), le serveur parcourt le dossier de l'upload et sait exactement dans quel ordre lire et coller les fichiers .part les uns à la suite des autres pour reconstituer le fichier vidéo final (ex: video_reconstituee.mp4).3. Faciliter le nettoyage du disqueUne fois que le serveur a fini de coller tous les morceaux .part pour recréer la vidéo globale, ces petits fichiers temporaires deviennent inutiles. Le serveur peut simplement supprimer tous les fichiers qui se terminent par .part dans le dossier temporaire uploads/chunks/<uploadId>/ pour libérer l'espace disque.💡 En résumé : .part signifie "ceci est juste un morceau temporaire de 1 Mo, ne le lis pas comme une vidéo tant qu'on n'a pas tout réassemblé". 

* ** Resume** :  les chunk  recu par le serveur es nomme  .part  pour  dire  au  serveru  partial ou  inmcomplet  et  recuprer  tous ses  chunk .part les ensembles  pour  faire  une video .mp4



#### 2.2\. Concaténation séquentielle et contrôles d'intégrité

* **Fichier** : `backend/src/controllers/media.controller.js` (dans `completeChunkUpload`)
* **Code clé** :

```
// Concaténation dans l'ordre strict des index (0 à N-1)
for (let index = 0; index &lt; upload.total_chunks; index++) {
  const part = await fs.readFile(path.join(directory, `${index}.part`));
  await output.write(part);
}
// Contrôle de la taille finale, validation de la signature et calcul du hachage SHA-256

```

* **Explication** : Le serveur réassemble tous les fichiers `.part` dans l'ordre chronologique des morceaux pour reconstituer le MP4 d'origine. Il vérifie sa taille, sa signature vidéo et calcule une empreinte **SHA-256** pour détecter toute corruption.

* en  **plus** : 
Une **empreinte SHA-256** (ou *hachage SHA-256*, pour *Secure Hash Algorithm 256 bits*) est l'équivalent d'une **empreinte digitale numérique** unique propre à un fichier[1][2].

Voici son explication concrète dans le contexte du projet **FlashMarket-ViteVendre** :

---

### 💡 1\. L'analogie de l'empreinte digitale

Imaginez que chaque fichier informatique (texte, image ou vidéo) possède sa propre carte d'identité biologique. Si vous changez ne serait-ce qu'**un seul bit** ou une seule virgule dans une vidéo de 50 Mo, son empreinte SHA-256 change du tout au tout.

* **Exemple de résultat SHA-256** : Une chaîne fixe de 64 caractères hexadécimaux : `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`

---

### ⚙️ 2\. À quoi sert-elle lors de l'assemblage (`completeChunkUpload`) ?

Dans le contrôleur backend (`media.controller.js`), l'empreinte SHA-256 intervient juste après avoir collé tous les morceaux de 1 Mo (`0.part`, `1.part`, `2.part`...) pour reconstituer le fichier vidéo final[1] :

1. **Vérification d'intégrité (Anti-corruption)**[1] : Pendant le transfert réseau mobile (3G/4G), il arrive qu'un paquet d'octets soit mal transmis. En calculant le SHA-256 du fichier réassemblé, le serveur s'assure que le fichier final est **100 % identique et intact**. Si le client avait transmis une empreinte théorique au départ, le serveur compare les deux.
2. **Sécurité et Non-altération** : Elle garantit que personne n'a altéré ou remplacé le fichier binaire pendant les différentes requêtes d'upload.
3. **Traçabilité et Déduplication**[1][2] : L'empreinte permet d'identifier de manière unique une vidéo sur le serveur, évitant ainsi de traiter deux fois exactement le même fichier ou facilitant le suivi en base de données.

---

📌 **En résumé** : Le calcul du SHA-256 dans l'Étape 2.2 est le **tampon de conformité ultime** du serveur pour dire : *"La vidéo réassemblée est exacte, saine et prête à être envoyée au transcodage FFmpeg"*[1][3].

#### . Découplage par file d'attente (`Job Queue`)

* **Fichier** : `backend/src/services/media-queue.service.js`
* **Code clé** :

```
mediaQueue.enqueue(upload.media_id);

```

* **Explication** : Le serveur renvoie immédiatement une réponse HTTP `200 OK` au vendeur mobile, puis pousse le média dans une file d'attente asynchrone (`enqueue`) pour exécuter le transcodage FFmpeg en arrière-plan sans bloquer l'API.



### 📌 ÉTAPE 3 : Côté Serveur — Transcodage et Traitement FFmpeg

#### 3.1\. Encodage HLS Adaptatif (240p et 480p) et MP4 FastStart

* **Fichier** : `backend/src/services/ffmpeg.service.js` (dans `processVideo`)
* **Code clé** :

```
// Traitement en parallèle des versions HLS et du fallback MP4
await Promise.all([
  transcodeVariant(inputPath, lowDirectory, 240, '350k'),  // HLS 240p
  transcodeVariant(inputPath, highDirectory, 480, '900k'), // HLS 480p
  transcodeMp4(inputPath, mp4Path, 480, '900k')            // MP4 FastStart
]);

```

* **Options FFmpeg clés pour le HLS** :

```
'-hls_time 2',                       // Segments d'environ 2 secondes (.ts)
'-hls_playlist_type vod',           // Playlist pour vidéo à la demande
'-hls_flags independent_segments',  // Segments vidéo autonomes
'-force_key_frames', 'expr:gte(t,n_forced*2)' // Forcer des images clés toutes les 2s

```

* **Option FFmpeg clé pour le MP4** :

```
'-movflags +faststart' // Déplacement du moov atom au début du fichier

```

* **Explication** :
  * FFmpeg génère deux flux **HLS** découpés en petits fichiers `.ts` de **2 secondes** : **240p** (350 kbps, pour réseaux faibles 2G/3G) et **480p** (900 kbps, pour 4G/Wi-Fi), reliés par une playlist maître `master.m3u8`.
  * **FastStart (** **\-movflags +faststart** **)** déplace la table des matières du MP4 (l'atome `moov`) au début du fichier pour permettre un démarrage de lecture immédiat sans attendre le téléchargement total.

  * **En  plus** :
  
  Voici les explications concrètes sur ces trois notions fondamentales de l'architecture vidéo de **FlashMarket-ViteVendre** :

---

### 1\. C'est quoi `master.m3u8` ? Est-ce que c'est le manifeste ?

**Oui,** **master.m3u8** **EST le manifeste principal** (aussi appelé *Master Playlist* ou playlist maître) du flux HLS[1].

* **Sa nature** : Il s'agit d'un fichier texte léger au format M3U8 (Extended M3U) qui ne contient **aucune image ni aucun octet de vidéo**[1].
* **Son rôle** : C'est le **sommaire général** et la carte d'orientation envoyée au lecteur vidéo de l'acheteur[3][4]. Il déclare les différentes qualités (renditions) générées par le serveur pour une même vidéo[2][3] :
  1. **240p/index.m3u8** (Basse résolution \~350 kbps, pour réseaux lents 2G/3G)[3][5].
  2. **480p/index.m3u8** (Résolution moyenne \~900 kbps, pour 4G/Wi-Fi)[3][5].
* **Comment le lecteur l'utilise** :
  1. Lorsque l'acheteur clique sur la vidéo, l'application transmet l'URL de `master.m3u8` à la bibliothèque `Hls.js`[4][6].
  2. `Hls.js` lit `master.m3u8`, découvre les deux débits disponibles (240p et 480p), sélectionne la variante la plus adaptée à la vitesse de connexion du mobile, puis va lire la sous-playlist `index.m3u8` correspondante pour télécharger les petits segments vidéo `.ts` de 2 secondes[2].

---

### 2\. Pourquoi conserver la version MP4 en plus du HLS ?

Même si le HLS est la méthode de streaming principale du projet, le backend génère et conserve **toujours** un fichier `video.mp4` à côté du dossier HLS[5][8]. Ce choix repose sur deux raisons majeures :

1. **Compatibilité et secours (Fallback automatique)** :
  * Le streaming HLS nécessite un moteur moderne (`Hls.js` ou support HLS natif du navigateur via Media Source Extensions)[7][9].
  * Si un smartphone ancien ou un environnement WebView spécifique échoue à décoder le flux HLS (`data.fatal`), l'application détruit le lecteur HLS et bascule de manière transparente sur `video.mp4`[9]. Cela évite un écran noir ou un plantage de l'application[9].
2. **Avance rapide par plages d'octets (** **HTTP 206 Range Requests** **)** :
  * Le fichier MP4 permet la lecture progressive directe[5][10]. Si l'utilisateur déplace le curseur de lecture (seeking) sur la version MP4, le navigateur envoie une requête HTTP avec l'en-tête `Range: bytes=...`[10]. Le serveur Express répond avec un statut **HTTP 206 Partial Content** en ne transmettant que la plage d'octets demandée sans ré-expédier toute la vidéo[10].

---

### 3\. C'est quoi le `moov atom` et le `FastStart` ?

#### A. Le `moov atom` (l'Atome `moov`)

* Un fichier `.mp4` est structuré sous forme de conteneurs binaires appelés **atomes** (ou *boîtes*)[11].
* Deux atomes principaux composent une vidéo MP4 :
  * **mdat** **(Media Data)** : Contient la totalité des données brutes de l'image et du son[11].
  * **moov** **(Movie Metadata)** : Contient l'indexation, la durée, la fréquence d'images et la table des matières indiquant à quelle position exacte dans le fichier se trouve chaque seconde de vidéo[11].
* **Le problème classique** : Par défaut, lors d'un encodage MP4 standard, FFmpeg écrit l'atome **moov** **à la toute fin du fichier** (après le bloc de données `mdat`)[11].
* **La conséquence sur mobile** : Si l'atome `moov` est à la fin, le smartphone doit télécharger **l'intégralité du fichier MP4** jusqu'au dernier octet avant de trouver la table des matières et de pouvoir afficher la première seconde[11]. Cela provoque un temps de chargement très long[11].

#### B. Le `FastStart` (`-movflags +faststart`)

* **Définition** : `FastStart` est un traitement d'optimisation appliqué par FFmpeg grâce à l'option **\-movflags +faststart** lors du transcodage backend[5][11].
* **Son fonctionnement** : Cette option prend l'atome **moov** (les métadonnées) et le **déplace au tout début du fichier MP4**, juste avant l'atome `mdat`[11].
* **Bénéfice concrét** : Dès que le smartphone télécharge les tout premiers kilo-octets du fichier MP4, il reçoit immédiatement l'atome `moov`[11]. Le lecteur connaît aussitôt la structure de la vidéo et **démarre la lecture instantanément**, sans attendre la fin du téléchargement[11].


#### 3.2\. Extraction du poster et nettoyage du disque

* **Fichier** : `backend/src/services/ffmpeg.service.js` et `media-queue.service.js`
* **Code clé** :

```
// Extraction de l'image de couverture poster.jpg à t = 0 seconde
ffmpeg(inputPath).inputOptions(['-ss 0']).frames(1).output(posterPath);

// Suppression de la vidéo brute temporaire après transcodage
await fs.unlink(sourcePath);

```

* **Explication** : FFmpeg extrait l'image miniature `poster.jpg` pour l'afficher dans le fil d'actualité. Une fois les formats distribuables créés dans `media/videos/


### 📌 ÉTAPE 4 : Côté Acheteur — Feed Optimisé, IntersectionObserver et Streaming

#### 4.1\. Chargement économique du feed

* **Fichier** : `noteApp/www/js/app.js` (dans `renderMedia`)
* **Code clé** :

```
return ``;

```

* **Explication** : L'attribut `preload="none"` empêche le téléchargement des vidéos lors du défilement. Seule la miniature `poster.jpg` est affichée pour préserver le forfait Internet du client.


#### 4.2\. Détection de visibilité (`IntersectionObserver`)

* **Fichier** : `noteApp/www/js/app.js` (dans `attachEvents` et `handleFeedVisibility`)
* **Code clé** :

```
state.feedObserver = new IntersectionObserver(handleFeedVisibility, { threshold: [0, 0.6] });

function handleFeedVisibility(entries) {
  entries.forEach((entry) =&gt; {
    const video = entry.target.querySelector('video.post-video');
    if (entry.intersectionRatio &gt;= 0.6) {
      // La vidéo atteint 60% de visibilité -&gt; Démarrer la lecture
      handleVideoClick({ target: video });
    } else if (state.activeVideo === video) {
      // La vidéo sort de l'écran -&gt; Pause et destruction du lecteur
      disposeActiveVideo();
    }
  });
}

```

* **Explication** : La vidéo démarre uniquement lorsqu'elle atteint **au moins 60 % de visibilité à l'écran**. Dès que l'acheteur fait défiler la page, l'ancienne vidéo s'arrête et son lecteur est détruit pour économiser la mémoire RAM du mobile.

#### 4.3\. Orchestration de la lecture par Hls.js avec Fallback MP4

* **Fichier** : `noteApp/www/js/app.js` (dans `handleVideoClick`)
* **Code clé** :

```
// Priorité 1 : Moteur Hls.js (Google Chrome Android)
if (window.Hls &amp;&amp; window.Hls.isSupported()) {
  const player = new window.Hls({ startLevel: 0, maxBufferLength: 8 });
  player.loadSource(source); // Charge master.m3u8
  player.attachMedia(video);

  // En cas d'erreur fatale HLS, basculement automatique sur le MP4 FastStart
  player.on(window.Hls.Events.ERROR, (eventName, data) =&gt; {
    if (data.fatal) {
      player.destroy();
      const mp4Fallback = source.replace(/master\.m3u8$/, 'video.mp4');
      video.src = mp4Fallback;
      video.play();
    }
  });
  return;
}

// Priorité 2 : Support HLS natif (Safari iOS)
if (video.canPlayType('application/vnd.apple.mpegurl')) {
  video.src = source;
  video.play();
  return;
}

// Priorité 3 : Fallback direct MP4
video.src = source.replace(/master\.m3u8$/, 'video.mp4');
video.play();

```

* **Explication** :
  1. **Hls.js** lit la playlist `master.m3u8`, sélectionne la variante de qualité (240p ou 480p) et injecte les petits segments `.ts` de 2 secondes dans le lecteur via les **Media Source Extensions (MSE)**.
  2. Si l'appareil mobile ne gère pas Hls.js ou rencontre une erreur fatale, l'application bascule automatiquement et de manière transparente vers le fichier `video.mp4` FastStart.


  #### 4.4\. Requêtes HTTP partielles (`Range Requests`)

* **Fichier** : `backend/src/app.js`
* **Code clé** :

```
app.use('/media', express.static(mediaDir, {
  setHeaders(res, filePath) {
    res.setHeader('Accept-Ranges', 'bytes');
  }
}));

```

* **Explication** : En exposant l'en-tête `Accept-Ranges: bytes`, le serveur Express permet au navigateur d'envoyer des requêtes partielles (`Range: bytes=...`) et d'obtenir des réponses `HTTP 206 Partial Content`. Cela permet d'avancer instantanément (*seeking*) dans le fichier MP4 alternatif sans télécharger l'intégralité de la vidéo.