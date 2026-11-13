const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');
const { mediaDir, maxImageBytes } = require('../config/env');

// Valide, redimensionne et optimise une image avant de la rendre disponible dans le feed.
async function processImage(sourcePath, mediaId) {
  const metadata = await sharp(sourcePath, { limitInputPixels: 40_000_000 }).metadata();
  if (!['jpeg', 'png', 'webp'].includes(metadata.format)) {
    const error = new Error('Format photo non pris en charge. Utilisez JPEG, PNG ou WebP.');
    error.status = 415;
    throw error;
  }
  const stat = await fs.stat(sourcePath);
  if (stat.size > maxImageBytes) {
    const error = new Error('La photo dépasse la taille maximale autorisée.');
    error.status = 413;
    throw error;
  }

  const directory = path.join(mediaDir, 'images', String(mediaId));
  await fs.mkdir(directory, { recursive: true });
  const imagePath = path.join(directory, 'image.webp');
  const posterPath = path.join(directory, 'poster.webp');

  await sharp(sourcePath, { limitInputPixels: 40_000_000 })
    .rotate()
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 })
    .toFile(imagePath);
  await sharp(sourcePath, { limitInputPixels: 40_000_000 })
    .rotate()
    .resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 68 })
    .toFile(posterPath);

  const outputMetadata = await sharp(imagePath).metadata();
  return {
    storageKey: path.posix.join('images', String(mediaId), 'image.webp'),
    posterKey: path.posix.join('images', String(mediaId), 'poster.webp'),
    width: outputMetadata.width,
    height: outputMetadata.height,
  };
}

module.exports = { processImage };
