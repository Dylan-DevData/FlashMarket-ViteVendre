const { nodeEnv } = require('../config/env');
const multer = require('multer');

// Route inconnue
function notFound(req, res) {
  res.status(404).json({ error: `Route introuvable : ${req.method} ${req.originalUrl}` });
}

// Gestion centralisée des erreurs : les contrôleurs appellent next(err)
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  const status = err instanceof multer.MulterError
    ? (err.code === 'LIMIT_FILE_SIZE' || err.code === 'LIMIT_FILE_COUNT' ? 413 : 400)
    : (err.status || 500);
  if (status >= 500) console.error('[erreur]', err);

  res.status(status).json({
    error: status >= 500 && nodeEnv === 'production'
      ? 'Erreur serveur'
      : (err instanceof multer.MulterError ? 'Fichier envoyé invalide ou trop volumineux.' : err.message),
  });
}

module.exports = { notFound, errorHandler };
