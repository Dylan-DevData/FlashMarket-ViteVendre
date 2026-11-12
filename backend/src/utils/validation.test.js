const test = require('node:test');
const assert = require('node:assert/strict');
const { isValidPhone, parseOptionalId, slugify } = require('./validation');

test('phone validation matches the database format', () => {
  assert.equal(isValidPhone('+237699123456'), true);
  assert.equal(isValidPhone('699123456'), true);
  assert.equal(isValidPhone('69 912 3456'), false);
  assert.equal(isValidPhone('+1234567'), false);
});

test('optional IDs distinguish omitted values from invalid values', () => {
  assert.equal(parseOptionalId(undefined), null);
  assert.equal(parseOptionalId('12'), 12);
  assert.equal(parseOptionalId('0'), undefined);
  assert.equal(parseOptionalId('1.5'), undefined);
});

test('shop slugs are URL-safe and unique to the owner', () => {
  assert.equal(slugify('Boutique Étoile', 17), 'boutique-etoile-17');
  assert.equal(slugify('!!!', 4), 'boutique-4');
});
