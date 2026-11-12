const listeners = new Set();
let listening = false;

function readSnapshot() {
  const online = navigator.onLine !== false;
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  const effectiveType = connection?.effectiveType || connection?.type || 'unknown';
  let quality = 'medium';

  if (!online) quality = 'offline';
  else if (connection?.saveData || /2g|slow-2g/i.test(effectiveType)) quality = 'slow';
  else if (/3g/i.test(effectiveType)) quality = 'medium';
  else if (/4g|wifi|ethernet/i.test(effectiveType)) quality = 'fast';

  return {
    online,
    quality,
    effectiveType,
    saveData: Boolean(connection?.saveData),
  };
}

function notify() {
  const snapshot = readSnapshot();
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch (error) {
      console.error('Échec de mise à jour de l’état réseau.', error);
    }
  }
}

function startListening() {
  if (listening) return;
  listening = true;
  window.addEventListener('online', notify);
  window.addEventListener('offline', notify);
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  connection?.addEventListener?.('change', notify);
}

export function getNetworkSnapshot() {
  startListening();
  return readSnapshot();
}

export function subscribeNetwork(listener) {
  if (typeof listener !== 'function') throw new TypeError('Un écouteur réseau est requis.');
  startListening();
  listeners.add(listener);
  listener(readSnapshot());
  return () => listeners.delete(listener);
}

export function waitUntilOnline() {
  if (navigator.onLine !== false) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = subscribeNetwork((snapshot) => {
      if (!snapshot.online) return;
      unsubscribe();
      resolve();
    });
  });
}
