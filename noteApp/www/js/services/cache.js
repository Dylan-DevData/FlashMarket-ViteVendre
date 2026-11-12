import { getStored, removeStored, setStored } from './storage.js';

const PREFIX = 'flashmarket.cache.';

export function readCache(key, maxAgeMs = Infinity) {
  const raw = getStored(`${PREFIX}${key}`);
  if (!raw) return null;
  try {
    const entry = JSON.parse(raw);
    if (!entry || !Number.isFinite(entry.savedAt) || !('value' in entry)) {
      throw new TypeError('Entrée de cache invalide.');
    }
    return {
      value: entry.value,
      savedAt: entry.savedAt,
      stale: Date.now() - entry.savedAt > maxAgeMs,
    };
  } catch (error) {
    console.error(`Lecture du cache impossible (${key}).`, error);
    removeStored(`${PREFIX}${key}`);
    return null;
  }
}

export function writeCache(key, value) {
  try {
    return setStored(`${PREFIX}${key}`, JSON.stringify({ savedAt: Date.now(), value }));
  } catch (error) {
    console.error(`Écriture du cache impossible (${key}).`, error);
    return false;
  }
}

export function clearCache() {
  try {
    const keysToRemove = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(PREFIX)) keysToRemove.push(key);
    }
    keysToRemove.forEach(removeStored);
    return keysToRemove.length;
  } catch (error) {
    console.error('Nettoyage du cache local impossible.', error);
    return 0;
  }
}
