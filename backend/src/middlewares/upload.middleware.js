const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Transform, pipeline } = require('stream');
const multer = require('multer');
const { uploadDir, maxVideoBytes, maxImageBytes } = require('../config/env');

fs.mkdirSync(uploadDir, { recursive: true });

const allowedTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/3gpp',
]);

const storage = {
  _handleFile(req, file, callback) {
    const extension = path.extname(file.originalname).toLowerCase().slice(0, 10);
    const filename = `${crypto.randomUUID()}${extension}`;
    const destination = path.join(uploadDir, filename);
    const maximum = file.mimetype.startsWith('image/')
      ? maxImageBytes
      : maxVideoBytes;
    let fileSize = 0;
    const limiter = new Transform({
      transform(chunk, encoding, done) {
        fileSize += chunk.length;
        req.flashMediaBytes = (req.flashMediaBytes || 0) + chunk.length;
        if ((maximum > 0 && fileSize > maximum)
          || (maxVideoBytes > 0 && req.flashMediaBytes > maxVideoBytes)) {
          const error = new multer.MulterError('LIMIT_FILE_SIZE', file.fieldname);
          done(error);
          return;
        }
        done(null, chunk);
      },
    });

    pipeline(file.stream, limiter, fs.createWriteStream(destination, { flags: 'wx' }), (error) => {
      if (error) {
        fs.promises.unlink(destination).catch((cleanupError) => {
          if (cleanupError.code !== 'ENOENT') console.error('[upload] nettoyage impossible :', cleanupError.message);
        });
        return callback(error);
      }
      return callback(null, { destination: uploadDir, filename, path: destination, size: fileSize });
    });
  },
  _removeFile(req, file, callback) {
    fs.unlink(file.path, callback);
  },
};

const upload = multer({
  storage,
  limits: {
    fileSize: maxVideoBytes || Number.MAX_SAFE_INTEGER,
    files: 8,
    fields: 12,
    fieldSize: 16 * 1024,
  },
  fileFilter: (req, file, callback) => {
    if (!allowedTypes.has(file.mimetype)) {
      const error = new Error('Type de média non accepté.');
      error.status = 415;
      return callback(error);
    }
    const kind = file.mimetype.startsWith('image/') ? 'image' : 'video';
    const count = req.flashMediaCount || 0;
    if ((req.flashMediaKind && req.flashMediaKind !== kind)
      || (kind === 'video' && count > 0)) {
      const error = new Error('Une annonce contient une vidéo seule ou des photos uniquement.');
      error.status = 400;
      return callback(error);
    }
    req.flashMediaKind = kind;
    req.flashMediaCount = count + 1;
    return callback(null, true);
  },
});

function removeTemporaryFiles(files) {
  return Promise.all((files || []).map((file) => fs.promises.unlink(file.path).catch((error) => {
    if (error.code !== 'ENOENT') console.error('[upload] nettoyage impossible :', error.message);
  })));
}

function uploadPostMedia(req, res, next) {
  upload.array('media', 8)(req, res, async (error) => {
    if (!error) return next();
    await removeTemporaryFiles(req.files);
    return next(error);
  });
}

module.exports = { uploadPostMedia, removeTemporaryFiles };
