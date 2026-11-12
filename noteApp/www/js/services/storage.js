const memory = new Map();

export function getStored(key) {
  try {
    const value = window.localStorage.getItem(key);
    if (value !== null) memory.set(key, value);
    return value ?? memory.get(key) ?? null;
  } catch (error) {
    console.error(`Lecture du stockage local impossible (${key}).`, error);
    return memory.get(key) ?? null;
  }
}

export function setStored(key, value) {
  const serialized = String(value);
  memory.set(key, serialized);
  try {
    window.localStorage.setItem(key, serialized);
    return true;
  } catch (error) {
    console.error(`Écriture du stockage local impossible (${key}).`, error);
    return false;
  }
}

export function removeStored(key) {
  memory.delete(key);
  try {
    window.localStorage.removeItem(key);
    return true;
  } catch (error) {
    console.error(`Suppression du stockage local impossible (${key}).`, error);
    return false;
  }
}

export function clearStored(keys) {
  for (const key of keys) removeStored(key);
}
