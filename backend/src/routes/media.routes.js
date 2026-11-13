const express = require('express');
const mediaController = require('../controllers/media.controller');
const { authenticate, optionalAuthenticate } = require('../middlewares/authenticate');
const { uploadChunkMaxBytes } = require('../config/env');

const router = express.Router();

// Regroupe la lecture des médias et le cycle de vie des uploads vidéo segmentés.
router.post(
  '/uploads',
  authenticate,
  mediaController.createChunkUpload
);
router.get('/uploads/:id', authenticate, mediaController.getUploadStatus);
router.put(
  '/uploads/:id/chunks/:index',
  authenticate,
  express.raw({ type: 'application/octet-stream', limit: uploadChunkMaxBytes }),
  mediaController.receiveChunk
);
router.post('/uploads/:id/complete', authenticate, mediaController.completeChunkUpload);
router.delete('/uploads/:id', authenticate, mediaController.abortChunkUpload);
router.get('/:id', optionalAuthenticate, mediaController.getMedia);

module.exports = router;
