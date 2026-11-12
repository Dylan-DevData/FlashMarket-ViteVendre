export function createLifecycleScope() {
  const cleanups = new Set();
  let disposed = false;

  function add(cleanup) {
    if (typeof cleanup !== 'function') throw new TypeError('Une fonction de nettoyage est requise.');
    if (disposed) cleanup();
    else cleanups.add(cleanup);
    return cleanup;
  }

  return {
    add,
    timeout(callback, delay) {
      const id = window.setTimeout(callback, delay);
      add(() => window.clearTimeout(id));
      return id;
    },
    interval(callback, delay) {
      const id = window.setInterval(callback, delay);
      add(() => window.clearInterval(id));
      return id;
    },
    observe(observer, target) {
      observer.observe(target);
      add(() => observer.unobserve(target));
      return observer;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const cleanup of cleanups) {
        try {
          cleanup();
        } catch (error) {
          console.error('Échec du nettoyage d’une ressource d’écran.', error);
        }
      }
      cleanups.clear();
    },
  };
}

export function runWhenIdle(callback, timeout = 1000) {
  if ('requestIdleCallback' in window) {
    const id = window.requestIdleCallback(callback, { timeout });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(callback, 0);
  return () => window.clearTimeout(id);
}
