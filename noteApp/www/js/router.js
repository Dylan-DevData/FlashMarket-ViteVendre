let currentCleanup = null;
let stopListening = null;

function parseRoute() {
  const hash = window.location.hash;
  const path = hash.startsWith('#/') ? hash.slice(1) : '/';
  return { path, segments: path.split('/').filter(Boolean) };
}

export function navigate(path, replace = false) {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  if (replace) window.history.replaceState(null, '', `#${normalized}`);
  else window.location.hash = normalized;
}

export function startRouter(resolveRoute) {
  if (typeof resolveRoute !== 'function') throw new TypeError('Un résolveur de route est requis.');
  stopRouter();

  const dispatch = () => {
    const route = parseRoute();
    if (typeof currentCleanup === 'function') {
      currentCleanup();
      currentCleanup = null;
    }
    const cleanup = resolveRoute(route);
    currentCleanup = typeof cleanup === 'function' ? cleanup : null;
  };
  window.addEventListener('hashchange', dispatch);
  stopListening = () => window.removeEventListener('hashchange', dispatch);
  dispatch();

  return stopRouter;
}

export function stopRouter() {
  stopListening?.();
  stopListening = null;
  if (typeof currentCleanup === 'function') currentCleanup();
  currentCleanup = null;
}
