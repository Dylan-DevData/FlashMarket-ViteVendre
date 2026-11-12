const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { sha256File, perceptualHash } = require('./hash.service');

test('SHA-256 et empreinte perceptuelle sont déterministes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flashmarket-hash-'));
  const imagePath = path.join(directory, 'fixture.png');
  const bytes = await sharp({
    create: { width: 32, height: 24, channels: 3, background: '#2764a5' },
  }).png().toBuffer();
  await fs.writeFile(imagePath, bytes);

  try {
    assert.equal(await sha256File(imagePath), crypto.createHash('sha256').update(bytes).digest('hex'));
    const first = await perceptualHash(imagePath);
    const second = await perceptualHash(imagePath);
    assert.equal(first, second);
    assert.equal(typeof first, 'bigint');
    assert.ok(first >= -(1n << 63n) && first < (1n << 63n));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
