const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const mediaModel = require('../models/media.model');
const postController = require('./post.controller');
const mediaQueue = require('../services/media-queue.service');
const { sha256File } = require('../services/hash.service');
const { uploadDir, maxVideoBytes, uploadChunkMaxBytes } = require('../config/env');
const { optionalAuthenticate } = require('../middlewares/authenticate');
const { verifyMediaSignature } = postController;
const { httpError } = require('../utils/httpError');
const logger = require('../utils/logger');

const CHUNK_MIN_BYTES = 64 * 1024;
const CHUNK_MAX_BYTES = uploadChunkMaxBytes;
const MAX_TOTAL_CHUNKS = 2147483647;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VIDEO_EXTENSIONS = {
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'video/3gpp': '.3gp',
};
const activeCompletions = new Set();

async function getMedia(req, res, next) {
  try {
    const mediaId = Number(req.params.id);
    if (!Number.isSafeInteger(mediaId) || mediaId < 1) {
      throw httpError(400, 'Identifiant de média invalide.');
    }
    const media = await mediaModel.findAccessibleMedia(mediaId, req.user?.id || null);
    if (!media || media.status !== 'ready') throw httpError(404, 'Média introuvable.');
    return res.json({
      media: {
        id: media.id,
        type: media.kind,
        url: `/media/${media.storage_key}`,
        posterUrl: media.poster_key ? `/media/${media.poster_key}` : null,
        width: media.width,
        height: media.height,
        durationSeconds: media.duration_s,
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function createChunkUpload(req, res, next) {
  try {
    const body = req.body || {};
    const mimeType = body.mime_type;
    const totalSize = Number(body.total_size);
    const chunkSize = body.chunk_size === undefined ? 1024 * 1024 : Number(body.chunk_size);
    const expectedSha256 = body.sha256 === undefined || body.sha256 === ''
      ? null
      : String(body.sha256).toLowerCase();
    if (!VIDEO_EXTENSIONS[mimeType]) throw httpError(415, 'Type de vidéo non accepté.');
    if (!Number.isSafeInteger(totalSize) || totalSize < 1
      || (maxVideoBytes > 0 && totalSize > maxVideoBytes)) {
      throw httpError(413, 'La taille de la vidéo est invalide ou trop élevée.');
    }
    if (!Number.isInteger(chunkSize) || chunkSize < CHUNK_MIN_BYTES || chunkSize > CHUNK_MAX_BYTES) {
      throw httpError(400, `La taille de morceau doit être comprise entre 64 Ko et ${Math.floor(CHUNK_MAX_BYTES / (1024 * 1024))} Mo.`);
    }
    if (expectedSha256 !== null && !/^[a-f0-9]{64}$/.test(expectedSha256)) {
      throw httpError(400, 'Le SHA-256 attendu doit contenir 64 caractères hexadécimaux.');
    }
    const totalChunks = Math.ceil(totalSize / chunkSize);
    if (!Number.isSafeInteger(totalChunks) || totalChunks > MAX_TOTAL_CHUNKS) {
      throw httpError(413, 'Le nombre de morceaux dépasse la capacité de la base de données.');
    }

    const { post } = await postController.buildPostData(body, req.user);
    const fileName = `${crypto.randomUUID()}${VIDEO_EXTENSIONS[mimeType]}`;
    const result = await mediaModel.createChunkUpload(post, {
      mimeType,
      totalSize,
      chunkSize,
      totalChunks,
      expectedSha256,
      fileName,
    });
    return res.status(201).json({
      uploadId: result.uploadId,
      postId: result.id,
      chunkSize,
      totalChunks,
      status: 'in_progress',
    });
  } catch (error) {
    return next(error);
  }
}

async function getUploadStatus(req, res, next) {
  try {
    const uploadId = parseUploadId(req.params.id);
    const upload = await mediaModel.findUpload(uploadId, req.user.id);
    if (!upload) throw httpError(404, 'Session d’envoi introuvable.');
    return res.json({
      uploadId: upload.id,
      status: upload.status,
      chunkSize: upload.chunk_size,
      totalChunks: upload.total_chunks,
      receivedChunks: upload.received_chunks,
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * Reçoit un morceau binaire individuel (ex: 1 Mo) envoyé par le téléphone via PUT.
 * Stocke le morceau temporairement sous la forme `uploads/chunks/<uploadId>/<index>.part`.
 * Enregistre le numéro du morceau reçu en base de données pour permettre la reprise.
 */
async function receiveChunk(req, res, next) {
  try {
    const uploadId = parseUploadId(req.params.id);
    const upload = await mediaModel.findUpload(uploadId, req.user.id);
    if (!upload || upload.status !== 'in_progress') throw httpError(404, 'Session d’envoi introuvable ou terminée.');
    const chunkIndex = Number(req.params.index);
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= upload.total_chunks) {
      throw httpError(400, 'Index de morceau invalide.');
    }
    if (!Buffer.isBuffer(req.body)) {
      throw httpError(400, 'Envoyez le morceau avec Content-Type: application/octet-stream.');
    }
    const expectedLength = Math.min(
      upload.chunk_size,
      Number(upload.total_size) - chunkIndex * upload.chunk_size
    );
    if (req.body.length !== expectedLength) {
      throw httpError(400, `Taille incorrecte pour ce morceau : ${expectedLength} octets attendus.`);
    }

    // 1. Accès ou création du dossier temporaire pour cette session d'envoi
    const directory = chunkDirectory(uploadId);
    await fs.mkdir(directory, { recursive: true });

    // 2. Écriture atomique du morceau binaire sur le disque
    const target = path.join(directory, `${chunkIndex}.part`);
    const temporary = path.join(directory, `${chunkIndex}.${crypto.randomUUID()}.tmp`);
    await fs.writeFile(temporary, req.body, { flag: 'wx' });
    try {
      await fs.link(temporary, target);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const current = await fs.readFile(target);
      if (!current.equals(req.body)) throw httpError(409, 'Ce morceau a déjà été envoyé avec un contenu différent.');
    } finally {
      await fs.unlink(temporary).catch((error) => {
        if (error.code !== 'ENOENT') logger.error('upload_temp_cleanup_failed', { uploadId, message: error.message });
      });
    }

    // 3. Marque ce morceau comme reçu en base PostgreSQL
    const receivedChunks = await mediaModel.markChunkReceived(
      { id: uploadId, userId: req.user.id },
      chunkIndex
    );
    return res.json({ uploadId, chunkIndex, received: receivedChunks.length });
  } catch (error) {
    return next(error);
  }
}

/**
 * Finalise l'upload une fois tous les morceaux reçus :
 * 1. Concatène tous les fichiers .part dans l'ordre pour recréer le MP4 original.
 * 2. Vérifie la taille et l'empreinte de sécurité SHA-256.
 * 3. Envoie la vidéo dans la file de transcodage FFmpeg.
 * 4. Supprime le dossier temporaire uploads/chunks/<uploadId>/ pour libérer le disque.
 */
async function completeChunkUpload(req, res, next) {
  const uploadId = parseUploadId(req.params.id);
  if (activeCompletions.has(uploadId)) {
    return next(httpError(409, 'L’assemblage de cette vidéo est déjà en cours.'));
  }
  activeCompletions.add(uploadId);
  let assembledPath;
  let finalPath;
  try {
    const upload = await mediaModel.findUpload(uploadId, req.user.id);
    if (!upload) throw httpError(404, 'Session d’envoi introuvable.');
    if (upload.status === 'complete') {
      mediaQueue.enqueue(upload.media_id);
      return res.json({
        uploadId,
        postId: upload.post_id,
        status: 'processing',
        message: 'Cette vidéo est déjà en cours de traitement.',
      });
    }
    if (upload.status !== 'in_progress') throw httpError(409, 'Cette session d’envoi est terminée.');
    if (upload.received_chunks.length !== upload.total_chunks) {
      return res.status(409).json({
        error: 'Des morceaux sont encore manquants.',
        missingCount: upload.total_chunks - upload.received_chunks.length,
      });
    }

    const directory = chunkDirectory(uploadId);
    finalPath = path.join(uploadDir, upload.file_name);
    assembledPath = path.join(uploadDir, `${crypto.randomUUID()}.assembling`);
    const output = await fs.open(assembledPath, 'w');
    try {
      // Concaténation séquentielle de chaque morceau dans le fichier assemblé
      for (let index = 0; index < upload.total_chunks; index += 1) {
        const part = await fs.readFile(path.join(directory, `${index}.part`));
        let written = 0;
        while (written < part.length) {
          const result = await output.write(part, written, part.length - written);
          written += result.bytesWritten;
        }
      }
    } finally {
      await output.close();
    }

    // Contrôle d'intégrité : vérification de la taille et de la signature du fichier
    const stat = await fs.stat(assembledPath);
    if (Number(stat.size) !== Number(upload.total_size)) {
      throw httpError(422, 'La taille finale du fichier ne correspond pas à celle annoncée.');
    }
    await verifyMediaSignature(assembledPath, upload.mime_type);
    const sha256 = await sha256File(assembledPath);
    if (upload.expected_sha256 && sha256 !== upload.expected_sha256.trim()) {
      await mediaModel.abortChunkUpload(uploadId, req.user.id);
      await cleanupUploadFiles(uploadId, upload.file_name);
      throw httpError(422, 'Le SHA-256 reçu ne correspond pas. Recommencez un nouvel envoi.');
    }

    // Fichier validé : renommage vers son nom définitif
    await fs.rename(assembledPath, finalPath);
    assembledPath = null;
    const completed = await mediaModel.completeChunkUpload(uploadId, req.user.id, sha256);
    if (!completed) throw httpError(404, 'Session d’envoi introuvable.');

    // Envoi dans la file de transcodage FFmpeg
    mediaQueue.enqueue(upload.media_id);

    // NETTOYAGE : suppression immédiate du dossier temporaire uploads/chunks/<uploadId>/
    await fs.rm(directory, { recursive: true, force: true }).catch((cleanupError) => {
      logger.error('upload_chunks_cleanup_failed', { uploadId, message: cleanupError.message });
    });
    return res.status(202).json({
      uploadId,
      postId: upload.post_id,
      status: 'processing',
      message: 'Vidéo assemblée et envoyée au traitement HLS.',
    });
  } catch (error) {
    if (error.status === 409 && error.message === 'Cette vidéo a déjà été publiée.') {
      const upload = await mediaModel.findUpload(uploadId, req.user.id);
      if (upload) await mediaModel.abortChunkUpload(uploadId, req.user.id);
      if (upload) await cleanupUploadFiles(uploadId, upload.file_name);
      if (assembledPath) await fs.unlink(assembledPath).catch((cleanupError) => {
        if (cleanupError.code !== 'ENOENT') logger.error('upload_assembly_cleanup_failed', { uploadId, message: cleanupError.message });
      });
      if (finalPath) await fs.unlink(finalPath).catch((cleanupError) => {
        if (cleanupError.code !== 'ENOENT') logger.error('upload_file_cleanup_failed', { uploadId, message: cleanupError.message });
      });
    }
    if ([415, 422].includes(error.status) && assembledPath) {
      const upload = await mediaModel.findUpload(uploadId, req.user.id);
      if (upload && upload.status === 'in_progress') {
        await mediaModel.abortChunkUpload(uploadId, req.user.id);
        await cleanupUploadFiles(uploadId, upload.file_name);
      }
    }
    if (assembledPath) await fs.unlink(assembledPath).catch((cleanupError) => {
      if (cleanupError.code !== 'ENOENT') logger.error('upload_assembly_cleanup_failed', { uploadId, message: cleanupError.message });
    });
    return next(error);
  } finally {
    activeCompletions.delete(uploadId);
  }
}

async function abortChunkUpload(req, res, next) {
  try {
    const uploadId = parseUploadId(req.params.id);
    const upload = await mediaModel.abortChunkUpload(uploadId, req.user.id);
    if (!upload) throw httpError(404, 'Session d’envoi introuvable.');
    await cleanupUploadFiles(uploadId, upload.file_name);
    return res.status(204).end();
  } catch (error) {
    return next(error);
  }
}

function parseUploadId(value) {
  if (!UUID_PATTERN.test(value)) throw httpError(400, 'Identifiant d’envoi invalide.');
  return value;
}

/**
 * Retourne le chemin du dossier temporaire où sont stockés les morceaux d'une vidéo :
 * Exemple : `backend/uploads/chunks/<uploadId>/`
 */
function chunkDirectory(uploadId) {
  return path.join(uploadDir, 'chunks', uploadId);
}

async function cleanupUploadFiles(uploadId, fileName) {
  await fs.rm(chunkDirectory(uploadId), { recursive: true, force: true });
  if (fileName && path.basename(fileName) === fileName) {
    await fs.unlink(path.join(uploadDir, fileName)).catch((error) => {
      if (error.code !== 'ENOENT') logger.error('upload_file_cleanup_failed', { uploadId, message: error.message });
    });
  }
}

module.exports = {
  getMedia,
  createChunkUpload,
  getUploadStatus,
  receiveChunk,
  completeChunkUpload,
  abortChunkUpload,
  optionalAuthenticate,
};
