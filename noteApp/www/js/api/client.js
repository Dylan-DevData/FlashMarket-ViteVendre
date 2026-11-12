import { API_BASE_URL } from '../config.js';
import { getNetworkSnapshot } from '../services/network.js';

export class ApiError extends Error {
  constructor({ status, code, message, fields = null }) {
    super(message || 'Une erreur est survenue pendant la requête.');
    this.name = 'ApiError';
    this.status = status;
    this.code = code || 'REQUEST_FAILED';
    this.fields = fields;
  }
}

function timeoutForQuality(quality) {
  if (quality === 'slow' || quality === 'offline') return 40000;
  if (quality === 'fast') return 15000;
  return 25000;
}

function retryDelay(attempt) {
  return Math.min(5000, 400 * (2 ** attempt)) + Math.floor(Math.random() * 200);
}

function sleep(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function parseResponse(response) {
  if (response.status === 204) return null;
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    if (!response.ok) throw new ApiError({ status: response.status, message: `Erreur serveur (${response.status}).` });
    return null;
  }
  try {
    return await response.json();
  } catch (error) {
    throw new ApiError({ status: response.status, code: 'INVALID_RESPONSE', message: 'La réponse du serveur est illisible.' });
  }
}

export async function request(path, options = {}) {
  const {
    baseUrl = new URL(API_BASE_URL).origin,
    token = '',
    authenticated = false,
    raw = false,
    retries = undefined,
    timeoutMs: requestedTimeoutMs,
    signal: externalSignal,
    ...fetchOptions
  } = options;
  const method = String(fetchOptions.method || 'GET').toUpperCase();
  const safeToRetry = method === 'GET' || method === 'HEAD' || method === 'DELETE';
  const maxRetries = retries === undefined ? (safeToRetry ? 2 : 0) : Math.max(0, retries);
  const headers = new Headers(fetchOptions.headers || {});
  if (authenticated && token) headers.set('Authorization', `Bearer ${token}`);
  if (fetchOptions.body !== undefined
    && !(fetchOptions.body instanceof FormData)
    && !(fetchOptions.body instanceof Blob)
    && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  let lastError;
  let timedOutLast = false;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timeoutMs = requestedTimeoutMs || timeoutForQuality(getNetworkSnapshot().quality);
    const timeout = window.setTimeout(() => controller.abort(new Error('request-timeout')), timeoutMs);
    const abortExternal = () => controller.abort(externalSignal.reason);
    if (externalSignal?.aborted) abortExternal();
    else externalSignal?.addEventListener('abort', abortExternal, { once: true });

    try {
      const response = await fetch(`${baseUrl}${path}`, {
        ...fetchOptions,
        method,
        headers,
        signal: controller.signal,
      });
      if (raw && response.ok) {
        await response.text();
        return response;
      }
      const payload = await parseResponse(response);
      if (!response.ok) {
        throw new ApiError({
          status: response.status,
          code: payload?.code || payload?.errorCode,
          message: payload?.message || payload?.error || `Erreur (${response.status}).`,
          fields: payload?.fields || null,
        });
      }
      return payload;
    } catch (error) {
      lastError = error;
      const timedOut = controller.signal.aborted && !externalSignal?.aborted;
      timedOutLast = timedOut;
      if (externalSignal?.aborted) throw error;
      if (!(error instanceof ApiError) && !(error instanceof TypeError) && !timedOut) throw error;
      const retryableStatus = error instanceof ApiError
        && (error.status === 408 || error.status === 429 || error.status >= 500);
      if (attempt >= maxRetries || (error instanceof ApiError && !retryableStatus)) break;
      await sleep(retryDelay(attempt));
    } finally {
      window.clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', abortExternal);
    }
  }

  if (lastError instanceof ApiError) throw lastError;
  throw new ApiError({
    status: 0,
    code: timedOutLast || lastError?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR',
    message: timedOutLast || lastError?.name === 'AbortError'
      ? 'Le réseau est trop lent. Réessayez quand la connexion sera meilleure.'
      : 'Impossible de joindre le serveur. Vérifiez votre connexion.',
  });
}
