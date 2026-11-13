const crypto = require('crypto');
const fs = require('fs');
const sharp = require('sharp');

// SHA-256 détecte les fichiers identiques; pHash repère les images visuellement proches.
async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function perceptualHash(filePath) {
  const { data } = await sharp(filePath)
    .rotate()
    .resize(32, 32, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const cosine = Array.from({ length: 8 }, (_, frequency) =>
    Array.from({ length: 32 }, (_, position) =>
      Math.cos(((2 * position + 1) * frequency * Math.PI) / 64)));
  const coefficients = [];
  for (let vertical = 0; vertical < 8; vertical += 1) {
    for (let horizontal = 0; horizontal < 8; horizontal += 1) {
      let sum = 0;
      for (let y = 0; y < 32; y += 1) {
        for (let x = 0; x < 32; x += 1) {
          sum += data[y * 32 + x] * cosine[vertical][y] * cosine[horizontal][x];
        }
      }
      coefficients.push(sum);
    }
  }

  const medianValues = coefficients.slice(1).sort((left, right) => left - right);
  const median = medianValues[Math.floor(medianValues.length / 2)];
  let hash = 0n;
  for (const coefficient of coefficients) {
    hash = (hash << 1n) | (coefficient > median ? 1n : 0n);
  }
  return hash >= (1n << 63n) ? hash - (1n << 64n) : hash;
}

module.exports = { sha256File, perceptualHash };
