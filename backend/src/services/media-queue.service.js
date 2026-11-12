const fs = require('fs/promises');
const path = require('path');
const mediaModel = require('../models/media.model');
const postModel = require('../models/post.model');
const { uploadDir, mediaDir, uploadSessionTtlHours } = require('../config/env');
const { processImage } = require('./image.service');
const { processVideo } = require('./ffmpeg.service');
const { perceptualHash } = require('./hash.service');
const logger = require('../utils/logger');

const pending = [];
const queued = new Set();
let active = false;

function enqueue(mediaId) {
  const id = Number(mediaId);
  if (!Number.isSafeInteger(id) || id < 1 || queued.has(id)) return;
  queued.add(id);
  pending.push(id);
  runNext();
}

/**
 * Traite un média en arrière-plan (Image via Sharp ou Vidéo via FFmpeg) :
 * 1. Verrouille le média en base pour éviter les traitements concurrents.
 * 2. Déclenche le transcodage HLS et FastStart via `processVideo`.
 * 3. Calcule l'empreinte perceptuelle pHash pour la modération.
 * 4. Publie l'annonce si tous ses médias sont prêts.
 * 5. SUPPRIME le fichier source temporaire lourd dans `uploads/` pour libérer le disque.
 */
async function processOne(mediaId) {
  const releaseLock = await mediaModel.acquireProcessingLock(mediaId);
  if (!releaseLock) return;
  try {
    const media = await mediaModel.getForProcessing(mediaId);
    if (!media || !media.storage_key.startsWith('upload:')) return;
    const filename = media.storage_key.slice('upload:'.length);
    if (path.basename(filename) !== filename) throw new Error('Chemin de fichier temporaire invalide.');
    const sourcePath = path.join(uploadDir, filename);
    const outputDirectory = path.join(
      mediaDir,
      media.kind === 'video' ? 'videos' : 'images',
      String(mediaId)
    );
    try {
      // Exécute le transcodage vidéo (FFmpeg HLS + MP4 FastStart) ou la compression image (Sharp WebP)
      const processed = media.kind === 'video'
        ? await processVideo(sourcePath, mediaId)
        : await processImage(sourcePath, mediaId);
      const fingerprintPath = media.kind === 'video'
        ? path.join(mediaDir, processed.posterKey)
        : path.join(mediaDir, processed.storageKey);
      const phash = await perceptualHash(fingerprintPath);
      
      // Enregistre les métadonnées et publie l'annonce si tout est prêt
      await mediaModel.completeAndMaybePublish(mediaId, { ...processed, phash });

      // NETTOYAGE : suppression du fichier source brut original pour libérer l'espace disque
      await fs.unlink(sourcePath).catch((error) => {
        if (error.code !== 'ENOENT') logger.error('media_source_cleanup_failed', { mediaId, message: error.message });
      });
    } catch (error) {
      await fs.rm(outputDirectory, { recursive: true, force: true });
      const abandonedFiles = await mediaModel.failProcessing(mediaId);
      await fs.unlink(sourcePath).catch((cleanupError) => {
        if (cleanupError.code !== 'ENOENT') logger.error('media_source_cleanup_failed', { mediaId, message: cleanupError.message });
      });
      for (const abandoned of abandonedFiles) {
        if (abandoned.storage_key && abandoned.storage_key.startsWith('upload:')) {
          const abandonedName = abandoned.storage_key.slice('upload:'.length);
          if (path.basename(abandonedName) === abandonedName) {
            await fs.unlink(path.join(uploadDir, abandonedName)).catch((cleanupError) => {
              if (cleanupError.code !== 'ENOENT') {
                logger.error('media_source_cleanup_failed', { mediaId, message: cleanupError.message });
              }
            });
          }
        } else {
          await fs.rm(
            path.join(mediaDir, abandoned.kind === 'video' ? 'videos' : 'images', String(abandoned.id)),
            { recursive: true, force: true }
          );
        }
      }
      throw error;
    }
  } finally {
    await releaseLock();
  }
}

async function runNext() {
  if (active) return;
  const mediaId = pending.shift();
  if (!mediaId) return;
  active = true;
  try {
    await processOne(mediaId);
  } catch (error) {
    logger.error('media_processing_failed', { mediaId, message: error.message });
  } finally {
    queued.delete(mediaId);
    active = false;
    setImmediate(runNext);
  }
}

async function recoverPending() {
  let expiredCount = 0;
  while (true) {
    const expiredUploads = await mediaModel.listExpiredUploads(uploadSessionTtlHours);
    for (const upload of expiredUploads) {
      await mediaModel.abortExpiredUpload(upload.id);
      await fs.rm(path.join(uploadDir, 'chunks', upload.id), { recursive: true, force: true });
      await fs.unlink(path.join(uploadDir, upload.file_name)).catch((error) => {
        if (error.code !== 'ENOENT') logger.error('expired_upload_cleanup_failed', { uploadId: upload.id, message: error.message });
      });
    }
    expiredCount += expiredUploads.length;
    if (expiredUploads.length < 200) break;
  }

  let processed = 0;
  let afterId = 0;
  while (true) {
    const rows = await postModel.getPendingMedia(afterId);
    rows.forEach((row) => enqueue(row.id));
    processed += rows.length;
    if (rows.length < 100) break;
    afterId = Number(rows[rows.length - 1].id);
  }
  return { processed, expired: expiredCount };
}

module.exports = { enqueue, recoverPending };
