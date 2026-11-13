const PHONE_PATTERN = /^\+?[0-9]{8,15}$/;

// Validation partagée afin que les contrôleurs appliquent les mêmes règles métier.
function isValidPhone(phone) {
  return typeof phone === 'string' && PHONE_PATTERN.test(phone.trim());
}

function parseOptionalId(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  if (typeof value === 'string' && !/^[1-9]\d*$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function slugify(value, suffix) {
  const base = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'boutique';

  return `${base}-${suffix}`;
}

module.exports = { isValidPhone, parseOptionalId, slugify };
