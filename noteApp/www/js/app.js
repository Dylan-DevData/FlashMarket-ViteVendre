import { getDefaultApiOrigin } from './config.js';
import { request } from './api/client.js';
import { readCache, writeCache } from './services/cache.js';
import { getNetworkSnapshot, subscribeNetwork } from './services/network.js';
import { getPendingUpload, resumePendingVideo, uploadVideo } from './services/uploader.js';
import { getStored, removeStored, setStored } from './services/storage.js';
import { formatBytes as formatByteCount, formatPrice as formatPriceLabel } from './services/format.js';
import { tapFeedback } from './services/haptics.js';
import { navigate, startRouter } from './router.js';
import { createStore } from './store.js';
import { icon } from './ui/icons.js';

(function () {
  'use strict';

  const TOKEN_STORAGE_KEY = 'flashmarket.token';
  const USER_STORAGE_KEY = 'flashmarket.user';
  const CITY_STORAGE_KEY = 'flashmarket.cityId';
  const THEME_STORAGE_KEY = 'flashmarket.theme';
  const FAVORITES_STORAGE_KEY = 'flashmarket.favorites';
  const ONBOARDING_STORAGE_KEY = 'flashmarket.onboardingDone.v3';
  const CATALOG_CACHE_KEY = 'catalog.v1';
  const CATALOG_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
  const MAX_PHOTOS = 8;
  const FALLBACK_CITIES = [
    { id: 1, name: 'Bafoussam', region: 'Ouest' },
    { id: 3, name: 'Yaoundé', region: 'Centre' },
    { id: 4, name: 'Douala', region: 'Littoral' },
  ];

  const state = {
    apiUrl: normalizeApiUrl(getDefaultApiOrigin()),
    theme: getStored(THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark',
    token: getStored(TOKEN_STORAGE_KEY) || '',
    user: parseStoredUser(),
    cities: [],
    cityLoadState: 'loading',
    categories: [],
    cityId: Number(getStored(CITY_STORAGE_KEY)) || null,
    favorites: parseStoredFavorites(),
    postsById: new Map(),
    activePage: 'feed',
    onboardingIndex: 0,
    onboardingFrame: 0,
    splashTimer: null,
    categoryId: null,
    search: '',
    page: 1,
    limit: 10,
    loading: false,
    hasMore: true,
    feedNationwide: false,
    feedRequestId: 0,
    feedController: null,
    authMode: 'login',
    pendingUpload: null,
    uploadResuming: false,
    activeHls: null,
    activeVideo: null,
    videoMuted: true,
    feedObserver: null,
    controlsTimer: null,
    previewUrls: [],
    networkQuality: getNetworkSnapshot().quality,
    apiReachable: null,
    stopRouter: null,
    unsubscribeNetwork: null,
  };

  const elements = {};
  const appStore = createStore({ networkQuality: state.networkQuality, cityId: state.cityId });

  document.addEventListener('DOMContentLoaded', initialize);
  document.addEventListener('deviceready', initialize, false);
  document.addEventListener('deviceready', () => applyTheme(state.theme), { once: true });

  function normalizeApiUrl(value) {
    return String(value || '').trim().replace(/\/+$/, '');
  }

  function dismissSplash() {
    if (state.splashTimer) {
      window.clearTimeout(state.splashTimer);
      state.splashTimer = null;
    }
    elements['app-splash']?.classList.add('is-hidden');
  }

  function parseStoredUser() {
    try {
      return JSON.parse(getStored(USER_STORAGE_KEY) || 'null');
    } catch (error) {
      console.error('Profil local illisible', error);
      return null;
    }
  }

  function parseStoredFavorites() {
    try {
      const saved = JSON.parse(getStored(FAVORITES_STORAGE_KEY) || '[]');
      return Array.isArray(saved) ? saved.filter((post) => post && post.id !== undefined) : [];
    } catch (error) {
      console.error('Les favoris locaux sont illisibles.', error);
      return [];
    }
  }

  function startFirstRun() {
    if (getStored(ONBOARDING_STORAGE_KEY) !== 'true') {
      syncOnboarding(0, false);
      elements['onboarding-dialog'].showModal();
      return;
    }
    if (!state.cityId) elements['city-dialog'].showModal();
  }

  function finishOnboarding() {
    setStored(ONBOARDING_STORAGE_KEY, 'true');
    if (elements['onboarding-dialog'].open) elements['onboarding-dialog'].close();
    if (!state.cityId && !elements['city-dialog'].open) elements['city-dialog'].showModal();
  }

  function replayOnboarding() {
    removeStored(ONBOARDING_STORAGE_KEY);
    syncOnboarding(0, false);
    if (!elements['onboarding-dialog'].open) elements['onboarding-dialog'].showModal();
  }

  function syncOnboarding(index, scroll = true) {
    const slides = Array.from(elements['onboarding-track'].querySelectorAll('.onboarding-slide'));
    state.onboardingIndex = Math.max(0, Math.min(slides.length - 1, index));
    elements['onboarding-dialog'].dataset.slide = String(state.onboardingIndex);
    slides.forEach((slide, slideIndex) => {
      slide.classList.toggle('is-active', slideIndex === state.onboardingIndex);
    });
    document.querySelectorAll('[data-onboarding-index]').forEach((button) => {
      const active = Number(button.dataset.onboardingIndex) === state.onboardingIndex;
      button.classList.toggle('is-active', active);
      if (active) button.setAttribute('aria-current', 'step');
      else button.removeAttribute('aria-current');
    });
    elements['onboarding-next'].textContent = state.onboardingIndex === slides.length - 1
      ? 'C’est parti'
      : 'Suivant';
    if (scroll) {
      elements['onboarding-track'].scrollTo({
        left: state.onboardingIndex * elements['onboarding-track'].clientWidth,
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      });
    }
  }

  function scheduleOnboardingUpdate() {
    if (state.onboardingFrame) return;
    state.onboardingFrame = window.requestAnimationFrame(() => {
      state.onboardingFrame = 0;
      const width = elements['onboarding-track'].clientWidth;
      if (width > 0) {
        updateOnboardingParallax();
        syncOnboarding(Math.round(elements['onboarding-track'].scrollLeft / width), false);
      }
    });
  }

  function updateOnboardingParallax() {
    const track = elements['onboarding-track'];
    const slides = Array.from(track.querySelectorAll('.onboarding-slide'));
    const width = track.clientWidth;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    slides.forEach((slide, index) => {
      const art = slide.querySelector('.onboarding-art');
      const offset = reduceMotion || width === 0 ? 0 : (track.scrollLeft - index * width) * 0.7;
      art.style.transform = `translate3d(${offset}px, 0, 0)`;
    });
  }

  async function initialize() {
    if (initialize.done) return;
    if (window.cordova && !window.cordova.file) return;
    initialize.done = true;
    cacheElements();
    attachEvents();
    state.pendingUpload = getPendingUpload();
    applyTheme(state.theme);
    startFirstRun();
    state.splashTimer = window.setTimeout(dismissSplash, 900);
    state.stopRouter = startRouter((route) => {
      if (route.path === '/me') {
        showPage('account');
        return disposeActiveVideo;
      }
      if (route.path === '/favorites') {
        showPage('favorites');
        return disposeActiveVideo;
      }
      if (route.path === '/explore') {
        showPage('explore');
        return disposeActiveVideo;
      }
      const shopMatch = route.path.match(/^\/shop\/([^/]+)$/);
      if (shopMatch) {
        showShop(decodeURIComponent(shopMatch[1]));
        return disposeActiveVideo;
      }
      showPage('feed');
      return disposeActiveVideo;
    });
    state.unsubscribeNetwork = subscribeNetwork(updateNetworkStatus);
    updateAccountButton();
    await loadCatalog();
    renderAccount();
    await refreshFeed();
    dismissSplash();
    if (state.pendingUpload && state.token) resumePendingUpload(true);
  }

  function cacheElements() {
    [
      'feed-page', 'account-page', 'feed-list', 'category-strip', 'city-button',
      'current-city', 'city-dialog', 'city-select', 'save-city', 'account-button',
      'city-load-status', 'retry-cities',
      'account-avatar', 'account-content', 'auth-dialog', 'auth-form', 'auth-title',
      'auth-description', 'auth-phone', 'auth-password', 'auth-name', 'auth-city',
      'register-fields', 'auth-submit', 'auth-message', 'publish-dialog',
      'publish-content', 'search-toggle', 'search-form', 'search-input',
      'immersive-search-toggle', 'search-close', 'load-more',
      'toast-region',
      'network-status',
      'favorites-page', 'favorites-list', 'onboarding-dialog', 'onboarding-track',
      'onboarding-next', 'account-heading',
      'app-splash',
    ].forEach((id) => {
      elements[id] = document.getElementById(id);
    });
    updateNetworkBanner();
  }

  function updateNetworkStatus(snapshot) {
    const wasOffline = state.networkQuality === 'offline';
    const appState = appStore.setState({
      networkQuality: snapshot.quality,
      cityId: state.cityId,
    });
    state.networkQuality = appState.networkQuality;
    updateNetworkBanner(snapshot);
    if (wasOffline && snapshot.online) {
      showToast('Connexion rétablie.');
      if (state.cityId) refreshFeed();
      if (state.pendingUpload && state.token && !state.uploadResuming) {
        resumePendingUpload(true);
      }
    }
  }

  function updateNetworkBanner(snapshot = getNetworkSnapshot()) {
    const unavailable = !snapshot.online || state.apiReachable === false;
    elements['network-status'].classList.toggle('hidden', !unavailable);
    if (!unavailable) {
      elements['network-status'].textContent = '';
      return;
    }
    const cachedFeed = readCache(
      `feed.${state.cityId}.${state.categoryId || 'all'}.${state.search || 'all'}.1`
    );
    elements['network-status'].textContent = !snapshot.online
      ? (cachedFeed ? 'Hors connexion — contenu enregistré' : 'Hors connexion — vérifiez votre réseau')
      : 'Hors connexion — serveur indisponible';
  }

  function setApiReachable(reachable) {
    state.apiReachable = reachable;
    updateNetworkBanner();
  }

  function attachEvents() {
    document.addEventListener('click', handleClick);
    elements['feed-list'].addEventListener('click', handleVideoClick, true);
    elements['feed-list'].addEventListener('play', handleVideoClick, true);
    elements['feed-list'].addEventListener('timeupdate', updateVideoProgress, true);
    elements['feed-list'].addEventListener('durationchange', updateVideoProgress, true);
    elements['feed-list'].addEventListener('loadedmetadata', updateVideoProgress, true);
    elements['feed-list'].addEventListener('loadedmetadata', updateVideoLayout, true);
    elements['feed-list'].addEventListener('canplay', updateVideoProgress, true);
    elements['feed-list'].addEventListener('progress', updateVideoProgress, true);
    elements['feed-list'].addEventListener('input', handleSeekInput);
    elements['feed-list'].addEventListener('change', handleSeekInput);
    elements['feed-list'].addEventListener('pointerdown', handleControlsActivity);
    elements['feed-list'].addEventListener('pointermove', handleControlsActivity);
    elements['feed-list'].addEventListener('pointerup', handleControlsActivity);
    elements['feed-list'].addEventListener('pointercancel', handleControlsActivity);
    window.addEventListener('resize', updateAllVideoLayouts, { passive: true });
    elements['favorites-list']?.addEventListener('click', handleVideoClick, true);
    elements['favorites-list']?.addEventListener('play', handleVideoClick, true);
    elements['city-button'].addEventListener('click', openCityPicker);
    elements['save-city'].addEventListener('click', saveCity);
    elements['retry-cities'].addEventListener('click', loadCatalog);
    elements['auth-form'].addEventListener('submit', submitAuth);
    elements['search-toggle'].addEventListener('click', () => {
      elements['search-form'].classList.toggle('hidden');
      if (!elements['search-form'].classList.contains('hidden')) elements['search-input'].focus();
    });
    elements['immersive-search-toggle'].addEventListener('click', () => {
      setSearchVisibility(elements['search-form'].classList.contains('hidden'));
    });
    elements['search-close'].addEventListener('click', () => setSearchVisibility(false));
    elements['search-form'].addEventListener('submit', (event) => {
      event.preventDefault();
      state.search = elements['search-input'].value.trim();
      refreshFeed();
    });
    elements['load-more'].addEventListener('click', loadMore);
    elements['onboarding-track'].addEventListener('scroll', scheduleOnboardingUpdate, { passive: true });
    if ('IntersectionObserver' in window) {
      state.feedObserver = new IntersectionObserver(handleFeedVisibility, { threshold: [0, 0.6] });
    }
    elements['onboarding-dialog'].addEventListener('cancel', (event) => {
      event.preventDefault();
      finishOnboarding();
    });
    document.querySelectorAll('[data-auth-mode]').forEach((button) => {
      button.addEventListener('click', () => setAuthMode(button.dataset.authMode));
    });
  }

  async function loadCatalog() {
    const cached = readCache(CATALOG_CACHE_KEY, CATALOG_CACHE_TTL);
    setCityLoadState('loading');
    const [citiesResponse, categoriesResponse] = await Promise.allSettled([
      api('/api/cities', { timeoutMs: 8000, retries: 0 }),
      api('/api/categories', { timeoutMs: 8000, retries: 0 }),
    ]);

    let citiesResult;
    let citiesError = citiesResponse.status === 'rejected' ? citiesResponse.reason : null;
    let citiesFromApi = false;
    if (citiesResponse.status === 'fulfilled') {
      try {
        citiesResult = { cities: parseCities(citiesResponse.value) };
        citiesFromApi = true;
      } catch (error) {
        citiesError = error;
      }
    }
    if (!citiesResult && cached?.value?.citiesResult) {
      try {
        citiesResult = { cities: parseCities(cached.value.citiesResult) };
      } catch (cacheError) {
        console.error('Le cache des villes est invalide.', cacheError);
      }
    }

    if (citiesResult) {
      applyCities(citiesResult, !citiesFromApi);
    } else {
      console.warn('Le catalogue des villes est indisponible; utilisation des villes locales de secours.', citiesError);
      applyCities({ cities: FALLBACK_CITIES }, true);
      showToast(citiesError?.message || 'Le serveur est indisponible. Des villes locales sont proposées.');
    }

    let categoriesResult;
    if (categoriesResponse.status === 'fulfilled') {
      categoriesResult = categoriesResponse.value;
    } else if (cached?.value?.categoriesResult) {
      categoriesResult = cached.value.categoriesResult;
    }

    if (categoriesResult) {
      applyCategories(categoriesResult);
    } else {
      showToast(categoriesResponse.reason?.message || 'Impossible de charger les catégories.');
    }

    if (citiesFromApi && categoriesResponse.status === 'fulfilled') {
      writeCache(CATALOG_CACHE_KEY, {
        citiesResult: { cities: state.cities },
        categoriesResult: { categories: state.categories },
      });
    }
  }

  function parseCities(result) {
    const cities = Array.isArray(result)
      ? result
      : (Array.isArray(result?.cities) ? result.cities : result?.items);
    if (!Array.isArray(cities)) {
      throw new Error('Réponse invalide du serveur : la liste des villes est absente.');
    }
    if (cities.length === 0) {
      throw new Error('Le serveur ne contient aucune ville disponible.');
    }
    return cities.map((city) => {
      const id = Number(city?.id);
      if (!Number.isSafeInteger(id) || id < 1 || typeof city?.name !== 'string' || !city.name.trim()) {
        throw new Error('Réponse invalide du serveur : une ville ne contient pas d’identifiant ou de nom valide.');
      }
      return { id, name: city.name.trim(), region: typeof city.region === 'string' ? city.region : '' };
    });
  }

  function applyCities(citiesResult, isFallback = false) {
    state.cities = citiesResult.cities;
    state.cityLoadState = state.cities.length ? (isFallback ? 'fallback' : 'loaded') : 'empty';
    renderCityOptions();

    if (state.cityId && !state.cities.some((city) => Number(city.id) === Number(state.cityId))) {
      state.cityId = null;
      removeStored(CITY_STORAGE_KEY);
    }
    if (state.user?.cityId && !getStored(CITY_STORAGE_KEY)) {
      state.cityId = Number(state.user.cityId);
    }
    updateCityLabel();
    if (isFallback && state.cities.length) {
      elements['city-load-status'].textContent = 'Serveur indisponible. Villes locales proposées ; réessayez pour actualiser la liste.';
      elements['retry-cities'].classList.remove('hidden');
    }
  }

  function applyCategories(categoriesResult) {
    state.categories = Array.isArray(categoriesResult?.categories)
      ? categoriesResult.categories
      : (Array.isArray(categoriesResult?.items) ? categoriesResult.items : []);
    renderCategories();
  }

  function setCityLoadState(status, message = '') {
    state.cityLoadState = status;
    const placeholder = status === 'loading'
      ? 'Chargement des villes...'
      : (status === 'error' ? 'Villes indisponibles' : 'Choisir une ville');
    elements['city-select'].innerHTML = `<option value="">${placeholder}</option>`;
    elements['city-select'].disabled = status === 'loading' || status === 'error';
    elements['save-city'].disabled = status !== 'loaded';
    elements['retry-cities'].classList.toggle('hidden', status !== 'error' && status !== 'fallback');
    elements['city-load-status'].textContent = message
      || (status === 'empty' ? 'Aucune ville disponible. Vérifiez les données de la base.' : '');
  }

  function renderCityOptions() {
    const options = state.cities.map((city) =>
      `<option value="${city.id}">${escapeHtml(city.name)}${city.region ? ` · ${escapeHtml(city.region)}` : ''}</option>`
    ).join('');
    const placeholder = state.cities.length ? 'Choisir une ville' : 'Aucune ville disponible';
    elements['city-select'].innerHTML = `<option value="">${placeholder}</option>${options}`;
    elements['auth-city'].innerHTML = `<option value="">${placeholder}</option>${options}`;
    elements['city-select'].disabled = state.cities.length === 0;
    elements['auth-city'].disabled = state.cities.length === 0;
    elements['save-city'].disabled = state.cities.length === 0;
    elements['city-load-status'].textContent = state.cities.length
      ? (state.cityLoadState === 'fallback'
        ? 'Serveur indisponible. Villes locales proposées ; réessayez pour actualiser la liste.'
        : '')
      : (state.cityLoadState === 'error'
        ? 'Impossible de récupérer les villes. Vérifiez la connexion au serveur.'
        : 'Aucune ville disponible. Vérifiez les données de la base.');
    if (state.cityId) {
      elements['city-select'].value = String(state.cityId);
      elements['auth-city'].value = String(state.cityId);
    }
  }

  function renderCategories() {
    const allButton = `<button class="category-chip ${state.categoryId === null ? 'selected' : ''}" type="button" data-category="">Tout voir</button>`;
    const chips = state.categories.map((category) =>
      `<button class="category-chip ${Number(state.categoryId) === Number(category.id) ? 'selected' : ''}" type="button" data-category="${category.id}">${escapeHtml(category.name)}</button>`
    ).join('');
    elements['category-strip'].innerHTML = allButton + chips;
  }

  function updateCityLabel() {
    const city = state.cities.find((item) => Number(item.id) === Number(state.cityId));
    elements['current-city'].textContent = city ? city.name : 'Choisir une ville';
  }

  function openCityPicker() {
    renderCityOptions();
    elements['city-select'].value = state.cityId ? String(state.cityId) : '';
    elements['city-dialog'].showModal();
  }

  async function saveCity() {
    const cityId = Number(elements['city-select'].value);
    if (!Number.isSafeInteger(cityId) || cityId < 1) {
      showToast('Choisissez une ville pour afficher les annonces proches.');
      return;
    }
    state.cityId = cityId;
    state.feedNationwide = false;
    appStore.setState({ cityId });
    setStored(CITY_STORAGE_KEY, String(cityId));
    elements['auth-city'].value = String(cityId);
    updateCityLabel();
    elements['city-dialog'].close();
    await refreshFeed();
  }

  async function refreshFeed() {
    state.feedController?.abort();
    state.feedController = new AbortController();
    state.feedRequestId += 1;
    state.loading = false;
    state.page = 1;
    state.hasMore = true;
    disposeActiveVideo();
    state.feedObserver?.disconnect();
    elements['feed-list'].innerHTML = loadingState();
    await fetchFeed(false, state.feedRequestId, state.feedController);
  }

  async function loadMore() {
    if (state.loading || !state.hasMore || (!state.cityId && !state.feedNationwide)) return;
    state.page += 1;
    state.feedController = new AbortController();
    state.feedRequestId += 1;
    await fetchFeed(true, state.feedRequestId, state.feedController);
  }

  async function fetchFeed(append, requestId, controller) {
    let feedFailure = null;
    try {
      state.loading = true;
      elements['load-more'].disabled = true;
      if (!state.cityId && !state.feedNationwide) {
        updateCityLabel();
        elements['feed-list'].innerHTML = emptyState(
          'Choisissez votre ville',
          'Les annonces locales apparaîtront ici. Vous pourrez aussi explorer tout le Cameroun.',
          '<button class="button button-primary" type="button" data-action="explore-cameroon">Explorer tout le Cameroun</button><button class="button button-secondary" type="button" data-action="choose-city">Choisir une ville</button>'
        );
        elements['load-more'].classList.add('hidden');
        return;
      }
      let feedCity = state.feedNationwide ? 'all' : String(state.cityId);
      const params = new URLSearchParams({
        city_id: feedCity,
        page: String(state.page),
        limit: String(state.limit),
      });
      if (state.categoryId) params.set('category_id', String(state.categoryId));
      if (state.search) params.set('q', state.search);
      let result = await api(`/api/posts?${params.toString()}`, {
        signal: controller.signal,
        timeoutMs: 15000,
        retries: 0,
      });
      if (requestId !== state.feedRequestId) return;
      if (!Array.isArray(result?.posts)) {
        throw new Error('Le serveur a renvoyé un fil d’annonces invalide.');
      }
      if (!append && !state.feedNationwide && result.posts.length === 0) {
        const fallbackParams = new URLSearchParams(params);
        fallbackParams.set('city_id', 'all');
        try {
          const fallbackResult = await api(`/api/posts?${fallbackParams.toString()}`, {
            signal: controller.signal,
            timeoutMs: 15000,
            retries: 0,
          });
          if (requestId !== state.feedRequestId) return;
          if (Array.isArray(fallbackResult?.posts)) {
            result = fallbackResult;
            state.feedNationwide = true;
            feedCity = 'all';
            if (result.posts.length) {
              const cityName = state.cities.find((city) => Number(city.id) === Number(state.cityId))?.name;
              showToast(`Aucune annonce à ${cityName || 'proximité'} ; voici les annonces disponibles au Cameroun.`);
            }
          }
        } catch (fallbackError) {
          if (fallbackError.name === 'AbortError') return;
          console.warn('Impossible d’élargir le fil à tout le Cameroun.', fallbackError);
        }
      }
      const cacheKey = `feed.${feedCity}.${state.categoryId || 'all'}.${state.search || 'all'}.${state.page}`;
      if (state.page === 1) writeCache(cacheKey, result);
      const posts = result.posts;
      posts.forEach((post) => state.postsById.set(String(post.id), post));
      state.hasMore = posts.length === state.limit;
      if (append) {
        elements['feed-list'].querySelectorAll('.feed-load-error').forEach((item) => item.remove());
        elements['feed-list'].insertAdjacentHTML('beforeend', posts.map(renderPost).join(''));
      } else {
        elements['feed-list'].innerHTML = posts.length
          ? posts.map(renderPost).join('')
          : renderFeedEmpty();
      }
      elements['load-more'].classList.toggle('hidden', !state.hasMore || posts.length === 0);
      observeFeedCards();
    } catch (error) {
      if (requestId !== state.feedRequestId || error.name === 'AbortError') return;
      feedFailure = error.message || 'Impossible de joindre le serveur.';
      const feedCity = state.feedNationwide ? 'all' : String(state.cityId);
      const cacheKey = `feed.${feedCity}.${state.categoryId || 'all'}.${state.search || 'all'}.${state.page}`;
      const cached = !append ? readCache(cacheKey) : null;
      if (cached?.value?.posts) {
        const posts = cached.value.posts;
        state.hasMore = false;
        elements['feed-list'].innerHTML = posts.length
          ? posts.map(renderPost).join('')
          : emptyState('Aucune annonce enregistrée', 'Reconnectez-vous pour actualiser le fil.');
        observeFeedCards();
        elements['load-more'].classList.add('hidden');
        return;
      }
      if (append) {
        state.page = Math.max(1, state.page - 1);
        elements['feed-list'].insertAdjacentHTML(
          'beforeend',
          `<div class="empty-state feed-load-error"><h2>Impossible de charger la suite</h2><p>${escapeHtml(error.message)}</p><button class="button button-secondary" type="button" data-action="retry-more">Réessayer</button></div>`
        );
      } else {
        elements['feed-list'].innerHTML = emptyState(
          'Le fil n’a pas pu se charger',
          error.message,
          '<button class="button button-primary" type="button" data-action="retry-feed">Réessayer</button>'
        );
      }
      showToast(error.message);
    } finally {
      if (requestId === state.feedRequestId) {
        state.loading = false;
        state.feedController = null;
        elements['load-more'].disabled = false;
        if (!append && elements['feed-list'].querySelector('.loading-card')) {
          elements['feed-list'].innerHTML = emptyState(
            'Le fil n’a pas pu se charger',
            feedFailure || 'Le chargement a été interrompu. Réessayez.',
            '<button class="button button-primary" type="button" data-action="retry-feed">Réessayer</button>'
          );
        }
      }
    }
  }

  function renderFeedEmpty() {
    if (state.feedNationwide) {
      return emptyState(
        'Aucune annonce au Cameroun pour le moment',
        'Réessayez plus tard ou revenez aux annonces de votre ville.',
        '<button class="button button-secondary" type="button" data-action="retry-feed">Réessayer</button>'
      );
    }
    const city = state.cities.find((item) => Number(item.id) === Number(state.cityId));
    const cityName = city?.name || 'votre ville';
    return emptyState(
      `Aucune annonce à ${cityName} pour le moment`,
      'Vous pouvez réessayer ou élargir la recherche à tout le Cameroun.',
      '<button class="button button-primary" type="button" data-action="explore-cameroon">Explorer tout le Cameroun</button><button class="button button-secondary" type="button" data-action="retry-feed">Réessayer</button>'
    );
  }

  function renderPost(post) {
    state.postsById.set(String(post.id), post);
    const isFavorite = state.favorites.some((favorite) => String(favorite.id) === String(post.id));
    const sellerName = post.shop?.ownerName || post.shop?.name || 'Vendeur';
    const sellerAvatar = post.shop?.logoUrl || post.shop?.ownerAvatarUrl;
    const avatar = sellerAvatar
      ? `<img src="${escapeAttribute(sellerAvatar)}" alt="" loading="lazy">`
      : `<span>${escapeHtml(initials(sellerName))}</span>`;
    const media = Array.isArray(post.media) ? post.media : [];
    const content = media.length
      ? media.map(renderMedia).join('')
      : `<div class="media-placeholder"><span>Image à venir</span></div>`;
    const backdropUrl = media[0]?.posterUrl || (media[0]?.type === 'image' ? media[0]?.url : '');
    const backdrop = backdropUrl
      ? `<img class="post-backdrop" src="${escapeAttribute(absoluteUrl(backdropUrl))}" alt="" aria-hidden="true" loading="eager">`
      : '';
    const saleActive = Boolean(post.flash_sale_active);
    const price = saleActive ? post.current_price_fcfa : post.price_fcfa;
    const mediaType = media.length > 1 ? `<span class="media-count">${media.length} photos · glisser</span>` : '';
    const neighborhood = [post.neighborhood, post.district, post.area, post.shop?.neighborhood]
      .find((value) => typeof value === 'string' && value.trim());
    const city = [post.city, post.shop?.city]
      .find((value) => typeof value === 'string' && value.trim());
    const location = [neighborhood, city].filter(Boolean).map((value) => escapeHtml(value.trim())).join(' · ');
    const sellerProfile = post.shop?.slug
      ? `<a class="rail-profile" href="#" data-action="shop" data-slug="${escapeAttribute(post.shop.slug)}" aria-label="Ouvrir le profil de ${escapeAttribute(sellerName)}">${avatar}</a>`
      : `<span class="rail-profile" aria-label="Profil de ${escapeAttribute(sellerName)}">${avatar}</span>`;
    const playerControls = media.some((item) => item.type === 'video') ? `
      <div class="video-progress-rail">
        <input class="video-seekbar" type="range" min="0" max="1000" value="0" step="1" data-seekbar disabled aria-label="Avancer ou reculer dans la vidéo">
      </div>
      <div class="video-controls is-hidden" data-video-controls>
        <div class="video-controls-top">
          <span class="video-time"><span data-current-time>00:00</span> / <span data-duration>00:00</span></span>
        </div>
      </div>` : '';

    return `
      <article class="post-card" data-post-id="${post.id}">
        <div class="post-media ${media.length > 1 ? 'has-gallery' : ''}">${backdrop}${content}${mediaType}${playerControls}${playerControls ? `<div class="media-play-feedback" aria-hidden="true">${icon('play')}</div>` : ''}</div>
        <aside class="feed-action-rail" aria-label="Actions sur l'annonce">
          ${sellerProfile}
          <button class="favorite-toggle rail-favorite ${isFavorite ? 'is-favorite' : ''}" type="button" data-favorite-id="${escapeAttribute(post.id)}" aria-label="${isFavorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}" aria-pressed="${isFavorite}">${icon('heart')}<span>Favori</span></button>
          <button class="rail-action" type="button" data-contact="whatsapp" data-post-id="${escapeAttribute(post.id)}" aria-label="Contacter sur WhatsApp">${icon('message')}<span>WhatsApp</span></button>
          ${post.shop?.slug ? `<a class="rail-action rail-shop" href="#" data-action="shop" data-slug="${escapeAttribute(post.shop.slug)}" aria-label="Voir les annonces de ${escapeAttribute(sellerName)}">${icon('store')}<span>Boutique</span></a>` : ''}
          ${media.some((item) => item.type === 'video') ? `<button class="rail-action rail-audio" type="button" data-audio-toggle aria-label="Activer le son" aria-pressed="false">${icon('volumeOff')}<span>Son coupé</span></button>` : ''}
        </aside>
        <div class="post-body">
          <div class="post-kicker">
            <span class="category-label">${escapeHtml(post.category || 'Annonce')}</span>
            ${saleActive ? '<span class="flash-label">VENTE FLASH</span>' : ''}
            <button class="favorite-toggle ${isFavorite ? 'is-favorite' : ''}" type="button" data-favorite-id="${escapeAttribute(post.id)}" aria-label="${isFavorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}" aria-pressed="${isFavorite}">${icon('heart')}</button>
          </div>
          ${location ? `<p class="post-location">${location}</p>` : ''}
          <h2 class="post-title">${escapeHtml(post.title)}</h2>
          ${post.description ? `<p class="post-description">${escapeHtml(post.description)}</p>` : ''}
          <div class="price-row">
            <strong>${escapeHtml(formatPriceLabel(price, post.price_unit))}</strong>
            ${saleActive ? `<del>${escapeHtml(formatPriceLabel(post.price_fcfa, post.price_unit))}</del>` : ''}
          </div>
          <div class="contact-actions">
            <button class="button button-primary contact-button" type="button" data-contact="whatsapp" data-post-id="${post.id}">
              ${icon('message')} WhatsApp
            </button>
            <button class="button button-outline contact-button" type="button" data-contact="call" data-post-id="${post.id}">
              ${icon('phone')} Appeler
            </button>
          </div>
        </div>
      </article>`;
  }

  function renderMedia(media) {
    const url = absoluteUrl(media.url);
    const poster = media.posterUrl ? ` poster="${escapeAttribute(absoluteUrl(media.posterUrl))}"` : '';
    if (media.type === 'video') {
      return `<video class="post-video" playsinline muted preload="none"${poster} data-hls-url="${escapeAttribute(url)}">
        Votre lecteur ne prend pas en charge les vidéos HLS.
      </video>`;
    }
    return `<img class="post-image" src="${escapeAttribute(url)}" alt="Photo de l’annonce" loading="lazy">`;
  }

  function observeFeedCards() {
    if (!state.feedObserver) return;
    elements['feed-list'].querySelectorAll('.post-card').forEach((card) => state.feedObserver.observe(card));
  }

  function handleFeedVisibility(entries) {
    if (state.activePage !== 'feed' || !document.body.classList.contains('immersive-feed')) return;
    entries.forEach((entry) => {
      const video = entry.target.querySelector('video.post-video');
      if (entry.intersectionRatio >= 0.6) {
        if (video && state.activeVideo !== video) {
          video.muted = state.videoMuted;
          video.defaultMuted = state.videoMuted;
          if (state.videoMuted) video.setAttribute('muted', '');
          else video.removeAttribute('muted');
          const audioButton = entry.target.querySelector('[data-audio-toggle]');
          if (audioButton) {
            audioButton.setAttribute('aria-label', state.videoMuted ? 'Activer le son' : 'Couper le son');
            audioButton.setAttribute('aria-pressed', String(!state.videoMuted));
            audioButton.innerHTML = `${icon(state.videoMuted ? 'volumeOff' : 'volume')}<span>${state.videoMuted ? 'Son coupé' : 'Son activé'}</span>`;
          }
          handleVideoClick({ target: video });
        }
      } else if (video && state.activeVideo === video) {
        disposeActiveVideo();
        hideVideoControls(entry.target);
      }
      const cards = elements['feed-list'].querySelectorAll('.post-card');
      if (entry.isIntersecting && entry.intersectionRatio >= 0.2
        && cards[cards.length - 1] === entry.target && state.hasMore) loadMore();
    });
  }

  function showVideoControls(card) {
    const controls = card?.querySelector('[data-video-controls]');
    if (!controls) return;
    document.querySelectorAll('[data-video-controls]').forEach((item) => item.classList.add('is-hidden'));
    controls.classList.remove('is-hidden');
    window.clearTimeout(state.controlsTimer);
    state.controlsTimer = window.setTimeout(() => controls.classList.add('is-hidden'), 2700);
  }

  function hideVideoControls(card) {
    card?.querySelector('[data-video-controls]')?.classList.add('is-hidden');
  }

  function showPlaybackFeedback(video, playing) {
    const feedback = video.closest('.post-card')?.querySelector('.media-play-feedback');
    if (!feedback) return;
    feedback.innerHTML = icon(playing ? 'pause' : 'play');
    feedback.classList.remove('is-visible');
    void feedback.offsetWidth;
    feedback.classList.add('is-visible');
    window.setTimeout(() => feedback.classList.remove('is-visible'), 650);
  }

  function formatPlaybackTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
    const total = Math.floor(seconds);
    const minutes = Math.floor(total / 60);
    const remainder = total % 60;
    return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
  }

  function updateVideoProgress(event) {
    const video = event.target.closest?.('video.post-video');
    if (!video) return;
    const card = video.closest('.post-card');
    const seekbar = card?.querySelector('[data-seekbar]');
    const timeline = getVideoTimeline(video);
    const duration = timeline ? timeline.end - timeline.start : 0;
    const currentTime = timeline ? Math.max(0, Math.min(duration, video.currentTime - timeline.start)) : video.currentTime;
    if (seekbar && event.type !== 'input' && !seekbar.dataset.scrubbing) {
      seekbar.value = duration ? String(Math.round((currentTime / duration) * 1000)) : '0';
      seekbar.disabled = !timeline;
    } else if (seekbar && timeline) {
      seekbar.disabled = false;
    }
    const current = card?.querySelector('[data-current-time]');
    const total = card?.querySelector('[data-duration]');
    if (current) current.textContent = formatPlaybackTime(currentTime);
    if (total) total.textContent = formatPlaybackTime(duration);
  }

  function getVideoTimeline(video) {
    if (Number.isFinite(video.duration) && video.duration > 0) {
      return { start: 0, end: video.duration };
    }
    try {
      if (video.seekable?.length) {
        const last = video.seekable.length - 1;
        const start = video.seekable.start(last);
        const end = video.seekable.end(last);
        if (Number.isFinite(start) && Number.isFinite(end) && end > start) return { start, end };
      }
    } catch { /* Le navigateur peut invalider la fenêtre seekable pendant le chargement. */ }
    const hlsDuration = Number(video.dataset.hlsDuration);
    if (Number.isFinite(hlsDuration) && hlsDuration > 0) return { start: 0, end: hlsDuration };
    return null;
  }

  function updateVideoLayout(event) {
    const video = event.target.closest?.('video.post-video');
    if (!video || !video.videoWidth || !video.videoHeight) return;
    const media = video.closest('.post-media');
    if (!media) return;
    const bounds = media.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const scale = Math.min(bounds.width / video.videoWidth, bounds.height / video.videoHeight);
    const displayedHeight = video.videoHeight * scale;
    const bottomGap = Math.max(0, (bounds.height - displayedHeight) / 2);
    media.style.setProperty('--video-letterbox-bottom', `${bottomGap}px`);
  }

  function updateAllVideoLayouts() {
    elements['feed-list']?.querySelectorAll('video.post-video').forEach((video) => {
      updateVideoLayout({ target: video });
    });
  }

  function handleSeekInput(event) {
    const seekbar = event.target.closest('[data-seekbar]');
    if (!seekbar) return;
    const card = seekbar.closest('.post-card');
    const video = card?.querySelector('video.post-video');
    const timeline = video && getVideoTimeline(video);
    if (!video || !timeline) return;
    const duration = timeline.end - timeline.start;
    try {
      video.currentTime = timeline.start + (Number(seekbar.value) / Number(seekbar.max)) * duration;
    } catch (error) {
      console.warn('Impossible de déplacer la lecture vidéo.', error);
      return;
    }
    showVideoControls(card);
    updateVideoProgress({ target: video, type: 'input' });
    if (event.type === 'change' || event.type === 'pointerup' || event.type === 'pointercancel') {
      delete seekbar.dataset.scrubbing;
    }
  }

  function handleControlsActivity(event) {
    const card = event.target.closest?.('.post-card');
    if (!card) return;
    const seekbar = event.target.closest('[data-seekbar]');
    if (seekbar && ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'].includes(event.type)) {
      if (event.type === 'pointerdown') {
        seekbar.dataset.scrubbing = 'true';
        try { seekbar.setPointerCapture(event.pointerId); } catch { /* Capture is optional on older webviews. */ }
      }
      if (event.type === 'pointerdown' || (event.type === 'pointermove' && seekbar.dataset.scrubbing)) {
        const bounds = seekbar.getBoundingClientRect();
        if (bounds.width > 0) {
          const progress = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
          seekbar.value = String(Math.round(progress * Number(seekbar.max)));
          handleSeekInput({ target: seekbar, type: 'input' });
        }
      }
      if (event.type === 'pointerup' || event.type === 'pointercancel') {
        handleSeekInput({ target: seekbar, type: event.type });
      }
    }
    if (event.type === 'pointerdown'
      || (event.type === 'pointermove' && seekbar)
      || (event.type === 'pointerup' && seekbar)) {
      showVideoControls(card);
    }
  }

  /**
   * Gestionnaire de lecture vidéo déclenché au clic ou à l'événement 'play' natif.
   * 
   * Ordre de résolution de lecture :
   * 1. Hls.js en priorité : nécessaire sur Google Chrome Android car canPlayType renvoie
   *    'maybe' sans réellement décoder le HLS nativement.
   * 2. HLS natif : pris en charge nativement par Safari (iOS / iPadOS).
   * 3. Fallback MP4 direct : si le HLS échoue ou sur un navigateur non compatible,
   *    lecture directe du fichier 'video.mp4' optimisé FastStart.
   */
  function handleVideoClick(event) {
    const video = event.target.closest('video.post-video');
    if (!video) return;
    const card = video.closest('.post-card');
    if (event.type === 'click') showVideoControls(card);
    if (video.dataset.sourceReady) {
      if (event.type === 'click' && document.body.classList.contains('immersive-feed')
        && state.activeVideo === video) {
        if (video.paused) {
          video.play().catch(() => {});
          showPlaybackFeedback(video, true);
        } else {
          video.pause();
          showPlaybackFeedback(video, false);
        }
      }
      return;
    }

    const source = video.dataset.hlsUrl;
    if (!source) return;

    if (event.type === 'click') showPlaybackFeedback(video, true);

    // Ferme la vidéo précédente pour éviter les lectures multiples simultanées
    disposeActiveVideo();
    state.activeVideo = video;
    video.dataset.sourceReady = 'true';

    // Priorité 1 : Moteur Hls.js (Chrome Android, Firefox, Edge, etc.)
    if (window.Hls && window.Hls.isSupported()) {
      const player = new window.Hls({
        startLevel: 0,
        capLevelToPlayerSize: true,
        maxBufferLength: 8,
        maxMaxBufferLength: 16,
        enableWorker: true,
      });
      state.activeHls = player;
      video.hlsPlayer = player;
      player.loadSource(source);
      player.attachMedia(video);
      player.on(window.Hls.Events.LEVEL_LOADED, (eventName, data) => {
        const duration = Number(data?.details?.totalduration);
        if (Number.isFinite(duration) && duration > 0) {
          video.dataset.hlsDuration = String(duration);
          updateVideoProgress({ target: video, type: 'durationchange' });
        }
        updateVideoLayout({ target: video });
      });
      player.on(window.Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch((error) => console.warn('La lecture vidéo a été interrompue.', error));
      });
      player.on(window.Hls.Events.ERROR, (eventName, data) => {
        if (data.fatal) {
          console.warn('Erreur HLS fatale, bascule sur le fichier MP4 direct...', data);
          player.destroy();
          video.hlsPlayer = null;
          state.activeHls = null;
          // Si le manifest HLS échoue, charge directement le fichier video.mp4 correspondant
          const mp4Fallback = source.replace(/master\.m3u8$/, 'video.mp4');
          if (mp4Fallback !== source) {
            video.src = mp4Fallback;
            video.load();
            video.play().catch(() => {});
          } else {
            state.activeVideo = null;
            video.dataset.sourceReady = '';
            showToast('Impossible de lire cette vidéo. Vérifiez votre connexion puis réessayez.');
          }
        }
      });
      return;
    }

    // Priorité 2 : Support HLS natif (Safari sous iOS / macOS)
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = source;
      video.load();
      video.play().catch((error) => console.warn('Lecture native interrompue.', error));
      return;
    }

    // Priorité 3 : Lecture directe MP4 pour les navigateurs basiques
    const mp4Fallback = source.replace(/master\.m3u8$/, 'video.mp4');
    video.src = mp4Fallback;
    video.load();
    video.play().catch((error) => console.warn('Lecture MP4 interrompue.', error));
  }

  function disposeActiveVideo() {
    if (state.activeHls) {
      state.activeHls.destroy();
      state.activeHls = null;
    }
    if (state.activeVideo) {
      state.activeVideo.pause();
      state.activeVideo.removeAttribute('src');
      state.activeVideo.load();
      state.activeVideo.dataset.sourceReady = '';
      state.activeVideo.hlsPlayer = null;
      state.activeVideo = null;
    }
  }

  function handleClick(event) {
    if (event.target.closest('button')) tapFeedback();
    const onboardingAction = event.target.closest('[data-onboarding-action]');
    if (onboardingAction) {
      if (onboardingAction.dataset.onboardingAction === 'finish') {
        finishOnboarding();
      } else if (state.onboardingIndex === 3) {
        finishOnboarding();
      } else {
        syncOnboarding(state.onboardingIndex + 1);
      }
      return;
    }
    const onboardingDot = event.target.closest('[data-onboarding-index]');
    if (onboardingDot) {
      syncOnboarding(Number(onboardingDot.dataset.onboardingIndex));
      return;
    }
    const favoriteButton = event.target.closest('[data-favorite-id]');
    if (favoriteButton) {
      toggleFavorite(favoriteButton.dataset.favoriteId);
      return;
    }

    const category = event.target.closest('[data-category]');
    if (category) {
      state.categoryId = category.dataset.category ? Number(category.dataset.category) : null;
      renderCategories();
      refreshFeed();
      return;
    }

    const contact = event.target.closest('[data-contact]');
    if (contact) {
      contactSeller(contact.dataset.postId, contact.dataset.contact);
      return;
    }

    const shopContact = event.target.closest('[data-shop-contact]');
    if (shopContact) {
      contactShop(shopContact);
      return;
    }

    const audioToggle = event.target.closest('[data-audio-toggle]');
    if (audioToggle) {
      const video = audioToggle.closest('.post-card')?.querySelector('video.post-video');
      if (video) {
        const shouldMute = !video.muted;
        video.muted = shouldMute;
        video.defaultMuted = shouldMute;
        if (shouldMute) video.setAttribute('muted', '');
        else video.removeAttribute('muted');
        video.volume = 1;
        state.videoMuted = shouldMute;
        audioToggle.setAttribute('aria-label', video.muted ? 'Activer le son' : 'Couper le son');
        audioToggle.setAttribute('aria-pressed', String(!video.muted));
        audioToggle.innerHTML = `${icon(video.muted ? 'volumeOff' : 'volume')}<span>${video.muted ? 'Son coupé' : 'Son activé'}</span>`;
        showVideoControls(audioToggle.closest('.post-card'));
        if (!video.muted) {
          video.play().catch((error) => {
            console.warn('Impossible d’activer le son de la vidéo.', error);
            showToast('Touchez à nouveau le bouton du son pour autoriser la lecture audio.');
          });
        }
      }
      return;
    }

    const action = event.target.closest('[data-action]');
    if (!action) return;
    event.preventDefault();
    if (action.dataset.action === 'replay-onboarding') {
      replayOnboarding();
      return;
    }
    if (action.dataset.action === 'home') navigate('/feed');
    if (action.dataset.action === 'explore-cameroon') {
      state.feedNationwide = true;
      refreshFeed();
    }
    if (action.dataset.action === 'retry-feed') refreshFeed();
    if (action.dataset.action === 'retry-more') loadMore();
    if (action.dataset.action === 'choose-city') openCityPicker();
    if (action.dataset.action === 'explore') navigate('/explore');
    if (action.dataset.action === 'favorites') navigate('/favorites');
    if (action.dataset.action === 'account') navigate('/me');
    if (action.dataset.action === 'publish') openPublish();
    if (action.dataset.action === 'shop') navigate(`/shop/${encodeURIComponent(action.dataset.slug)}`);
    if (action.dataset.action === 'login') openAuth('login');
    if (action.dataset.action === 'logout') logout();
    if (action.dataset.action === 'create-shop') createShop();
    if (action.dataset.action === 'toggle-theme') {
      state.theme = state.theme === 'dark' ? 'light' : 'dark';
      setStored(THEME_STORAGE_KEY, state.theme);
      applyTheme(state.theme);
      showToast(state.theme === 'dark' ? 'Mode sombre activé.' : 'Mode clair activé.');
      return;
    }
    if (action.dataset.action === 'resume-upload') resumePendingUpload();
  }

  function showPage(page) {
    state.activePage = page;
    if (page === 'feed') setSearchVisibility(false, false);
    if (page !== 'feed' && page !== 'explore') disposeActiveVideo();
    document.body.classList.toggle('immersive-feed', page === 'feed');
    document.body.classList.toggle('shop-page', page === 'shop');
    const showingFeed = page === 'feed' || page === 'explore';
    elements['feed-page'].classList.toggle('hidden', !showingFeed);
    elements['account-page'].classList.toggle('hidden', page !== 'account');
    elements['favorites-page'].classList.toggle('hidden', page !== 'favorites');
    document.querySelectorAll('.nav-item').forEach((item) => {
      const selectedAction = page === 'explore' ? 'explore'
        : page === 'favorites' ? 'favorites'
          : page === 'account' ? 'account' : 'home';
      item.classList.toggle('active', item.dataset.action === selectedAction);
    });
    if (page === 'account') renderAccount();
    if (page === 'favorites') renderFavorites();
    if (page === 'account' || page === 'favorites') elements['search-form'].classList.add('hidden');
    if (page === 'explore') {
      elements['search-form'].classList.remove('hidden');
      window.setTimeout(() => elements['search-input'].focus(), 0);
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function setSearchVisibility(visible, focus = true) {
    elements['search-form'].classList.toggle('hidden', !visible);
    elements['immersive-search-toggle'].setAttribute('aria-expanded', String(visible));
    elements['search-input'].value = state.search;
    if (visible && focus) window.setTimeout(() => elements['search-input'].focus(), 0);
    if (!visible) elements['search-input'].blur();
  }

  function toggleFavorite(postId) {
    const existingIndex = state.favorites.findIndex((post) => String(post.id) === String(postId));
    if (existingIndex >= 0) {
      state.favorites.splice(existingIndex, 1);
      showToast('Annonce retirée des favoris.');
    } else {
      const post = state.postsById.get(String(postId));
      if (!post) {
        showToast('Cette annonce n’est plus disponible dans la liste.');
        return;
      }
      state.favorites.unshift(post);
      showToast('Annonce ajoutée aux favoris.');
    }
    setStored(FAVORITES_STORAGE_KEY, JSON.stringify(state.favorites));
    document.querySelectorAll('[data-favorite-id]').forEach((button) => {
      if (String(button.dataset.favoriteId) !== String(postId)) return;
      const selected = state.favorites.some((post) => String(post.id) === String(postId));
      button.setAttribute('aria-pressed', String(selected));
      button.setAttribute('aria-label', selected ? 'Retirer des favoris' : 'Ajouter aux favoris');
      button.classList.toggle('is-favorite', selected);
      button.innerHTML = icon('heart');
    });
    if (state.activePage === 'favorites') renderFavorites();
  }

  function renderFavorites() {
    const content = state.favorites.length
      ? state.favorites.map(renderPost).join('')
      : emptyState('Aucun favori pour le moment', 'Touchez le cœur d’une annonce pour la retrouver ici.');
    elements['favorites-list'].innerHTML = content;
  }

  async function contactSeller(postId, channel) {
    if (!state.token) {
      openAuth('login', 'Connectez-vous pour contacter le vendeur.');
      return;
    }
    try {
      const result = await api(`/api/posts/${encodeURIComponent(postId)}/contact`, {
        method: 'POST',
        body: JSON.stringify({ channel }),
      }, true);
      if (channel === 'call') {
        openExternalUrl(`tel:${result.phone}`);
      } else {
        const digits = String(result.whatsapp || result.phone).replace(/\D/g, '');
        const card = Array.from(elements['feed-list'].querySelectorAll('[data-post-id]'))
          .find((item) => item.dataset.postId === String(postId));
        const title = card?.querySelector('.post-title')?.textContent?.trim() || 'une annonce';
        const message = encodeURIComponent(`Bonjour, je suis intéressé(e) par "${title}" sur ViteVendre.`);
        openExternalUrl(`https://wa.me/${digits}?text=${message}`);
      }
    } catch (error) {
      showToast(error.message);
    }
  }

  function contactShop(button) {
    const channel = button.dataset.shopContact;
    const phone = button.dataset.phone || '';
    const digits = phone.replace(/\D/g, '');
    if (digits) {
      if (channel === 'call') {
        openExternalUrl(`tel:${phone.replace(/[^\d+]/g, '')}`);
      } else {
        const message = encodeURIComponent('Bonjour, je souhaite contacter votre boutique sur ViteVendre.');
        openExternalUrl(`https://wa.me/${digits}?text=${message}`);
      }
      return;
    }
    if (button.dataset.postId) {
      contactSeller(button.dataset.postId, channel);
      return;
    }
    showToast('Cette boutique n’a pas encore renseigné de numéro de contact.');
  }

  function openExternalUrl(url) {
    if (window.cordova?.InAppBrowser?.open) {
      window.cordova.InAppBrowser.open(url, '_system');
      return;
    }
    window.location.href = url;
  }

  function openAuth(mode, message = '') {
    setAuthMode(mode);
    elements['auth-message'].textContent = message;
    elements['auth-dialog'].showModal();
  }

  function setAuthMode(mode) {
    state.authMode = mode === 'register' ? 'register' : 'login';
    const registering = state.authMode === 'register';
    elements['auth-title'].textContent = registering ? 'Créer mon compte' : 'Connectez-vous';
    elements['auth-description'].textContent = registering
      ? 'Une ville suffit pour découvrir les offres près de chez vous.'
      : 'Pour contacter un vendeur, connectez-vous à ViteVendre.';
    elements['register-fields'].classList.toggle('hidden', !registering);
    elements['auth-name'].required = registering;
    elements['auth-city'].required = registering;
    elements['auth-password'].autocomplete = registering ? 'new-password' : 'current-password';
    elements['auth-submit'].textContent = registering ? 'Créer mon compte' : 'Se connecter';
    elements['auth-message'].textContent = '';
    document.querySelectorAll('[data-auth-mode]').forEach((button) => {
      button.classList.toggle('active', button.dataset.authMode === state.authMode);
    });
  }

  async function submitAuth(event) {
    event.preventDefault();
    const registering = state.authMode === 'register';
    const payload = {
      phone: elements['auth-phone'].value.trim().replace(/\s+/g, ''),
      password: elements['auth-password'].value,
    };
    if (registering) {
      payload.fullName = elements['auth-name'].value.trim();
      payload.cityId = Number(elements['auth-city'].value);
    }
    setBusy(elements['auth-submit'], true, registering ? 'Création...' : 'Connexion...');
    elements['auth-message'].textContent = '';
    try {
      const result = await api(`/api/auth/${registering ? 'register' : 'login'}`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      state.token = result.token;
      state.user = result.user;
      setStored(TOKEN_STORAGE_KEY, state.token);
      setStored(USER_STORAGE_KEY, JSON.stringify(state.user));
      if (state.user.cityId) {
        state.cityId = Number(state.user.cityId);
        setStored(CITY_STORAGE_KEY, String(state.cityId));
        updateCityLabel();
      }
      elements['auth-dialog'].close();
      elements['auth-form'].reset();
      updateAccountButton();
      renderAccount();
      await refreshFeed();
      showToast(registering ? 'Compte créé. Bienvenue sur ViteVendre !' : 'Connexion réussie.');
      if (state.pendingUpload) resumePendingUpload(true);
    } catch (error) {
      elements['auth-message'].textContent = error.message;
    } finally {
      setBusy(elements['auth-submit'], false);
    }
  }

  function logout() {
    state.token = '';
    state.user = null;
    removeStored(TOKEN_STORAGE_KEY);
    removeStored(USER_STORAGE_KEY);
    updateAccountButton();
    renderAccount();
    showToast('Vous êtes déconnecté.');
  }

  function updateAccountButton() {
    if (state.user) elements['account-avatar'].textContent = initials(state.user.fullName);
    else elements['account-avatar'].innerHTML = icon('user');
    elements['account-button'].setAttribute(
      'aria-label',
      state.user ? `Compte de ${state.user.fullName}` : 'Se connecter'
    );
  }

  function applyTheme(theme) {
    state.theme = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = state.theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute(
      'content',
      state.theme === 'dark' ? '#000000' : '#f3eee6'
    );
    if (window.StatusBar && window.cordova?.platformId === 'android') {
      window.StatusBar.backgroundColorByHexString(state.theme === 'dark' ? '#000000' : '#f3eee6');
      if (state.theme === 'dark' && window.StatusBar.styleLightContent) window.StatusBar.styleLightContent();
      else window.StatusBar.styleDefault();
    }
    updateThemeControl();
  }

  function updateThemeControl() {
    const control = elements['account-content']?.querySelector('[data-action="toggle-theme"]');
    const description = document.getElementById('theme-description');
    if (!control) return;
    const dark = state.theme === 'dark';
    control.setAttribute('aria-pressed', String(dark));
    control.setAttribute('aria-label', dark ? 'Activer le mode clair' : 'Activer le mode sombre');
    if (description) description.textContent = dark
      ? 'Le thème sombre est activé.'
      : 'Le thème clair est activé.';
  }

  async function renderAccount() {
    if (!elements['account-content']) return;
    const signedIn = Boolean(state.user && state.token);
    elements['account-heading'].classList.toggle('hidden', !signedIn);
    if (!signedIn) {
      elements['account-content'].innerHTML = `
        <div class="account-card welcome-card">
          <div class="welcome-icon">${icon('spark')}</div>
          <h2>Les meilleures affaires sont locales.</h2>
          <p>Connectez-vous pour contacter les vendeurs ou créer votre boutique.</p>
          <button class="button button-primary full-width" type="button" data-action="login">Connexion / inscription</button>
          <button class="onboarding-replay" type="button" data-action="replay-onboarding">Revoir la présentation</button>
        </div>`;
      return;
    }

    const city = state.cities.find((item) => Number(item.id) === Number(state.user.cityId));
    let shopMarkup = '<div class="shop-loading"><span class="loader"></span> Chargement de votre boutique...</div>';
    elements['account-content'].innerHTML = `
      <div class="account-card profile-card">
        <div class="profile-avatar">${escapeHtml(initials(state.user.fullName))}</div>
        <div class="profile-details">
          <p class="eyebrow">MON PROFIL MBOAFLASH</p>
          <h2>${escapeHtml(state.user.fullName)}</h2>
          <dl class="profile-facts">
            <div><dt>Téléphone</dt><dd>${escapeHtml(state.user.phone)}</dd></div>
            <div><dt>Ville</dt><dd>${escapeHtml(city?.name || 'Ville non définie')}</dd></div>
          </dl>
        </div>
      </div>
      <div id="shop-panel">${shopMarkup}</div>
      <section class="account-card appearance-card" aria-labelledby="appearance-title">
        <div class="appearance-copy">
          <p class="eyebrow">PERSONNALISATION</p>
          <h2 id="appearance-title">Mode sombre</h2>
          <p class="muted" id="theme-description">Adapter l’apparence de l’application.</p>
          <button class="onboarding-replay" type="button" data-action="replay-onboarding">Revoir la présentation</button>
        </div>
        <button class="theme-switch" type="button" data-action="toggle-theme" aria-pressed="${state.theme === 'dark'}" aria-label="${state.theme === 'dark' ? 'Activer le mode clair' : 'Activer le mode sombre'}">
          <span class="theme-switch-track"><span class="theme-switch-thumb"></span></span>
        </button>
      </section>
      <div class="account-actions">
        <button class="button button-outline full-width" type="button" data-action="logout">${icon('logout')} Se déconnecter</button>
      </div>`;
    updateThemeControl();

    try {
      const result = await api('/api/shops/me', {}, true);
      shopMarkup = `
        <div class="account-card shop-card">
          <p class="eyebrow">VOTRE BOUTIQUE</p>
          <h2>${escapeHtml(result.shop.name)}</h2>
          <p class="muted">${escapeHtml(result.shop.description || 'Votre boutique est visible par les acheteurs de votre ville.')}</p>
          <a class="shop-link" href="#" data-action="shop" data-slug="${escapeAttribute(result.shop.slug)}">Voir la boutique ${icon('arrowUpRight')}</a>
        </div>`;
    } catch (error) {
      if (error.status === 404) {
        shopMarkup = `
          <div class="account-card shop-card">
            <p class="eyebrow">DEVENEZ VENDEUR</p>
            <h2>Ouvrez votre boutique</h2>
            <p class="muted">Une boutique suffit pour publier des produits ou des annonces immobilières.</p>
            <button class="button button-primary" type="button" data-action="create-shop">Créer ma boutique</button>
          </div>`;
      } else {
        shopMarkup = `<div class="account-card"><p class="form-message">${escapeHtml(error.message)}</p></div>`;
      }
    }
    const panel = document.getElementById('shop-panel');
    if (panel) panel.innerHTML = shopMarkup;
  }

  async function createShop() {
    const name = window.prompt('Quel est le nom de votre boutique ?');
    if (name === null) return;
    const cleanName = name.trim();
    if (cleanName.length < 2) {
      showToast('Le nom doit contenir au moins 2 caractères.');
      return;
    }
    try {
      await api('/api/shops', {
        method: 'POST',
        body: JSON.stringify({
          name: cleanName,
          cityId: state.user.cityId || state.cityId,
        }),
      }, true);
      showToast('Votre boutique est créée.');
      await renderAccount();
    } catch (error) {
      showToast(error.message);
    }
  }

  async function showShop(slug) {
    try {
      const result = await api(`/api/shops/${encodeURIComponent(slug)}`);
      const shop = result.shop;
      const posts = shop.posts || [];
      disposeActiveVideo();
      elements['feed-page'].classList.remove('hidden');
      elements['account-page'].classList.add('hidden');
      elements['favorites-page'].classList.add('hidden');
      state.activePage = 'shop';
      document.body.classList.remove('immersive-feed');
      document.body.classList.add('shop-page');
      elements['feed-list'].innerHTML = `
        <div class="shop-hero">
          <button class="button button-quiet back-button" type="button" data-action="home" aria-label="Retour au fil">${icon('arrowLeft')} Retour au fil</button>
          <p class="eyebrow">BOUTIQUE LOCALE</p>
          <h2>${escapeHtml(shop.name)}</h2>
          <p class="shop-location">${escapeHtml(shop.city || '')}</p>
          <div class="shop-contact-actions" aria-label="Contacter la boutique">
            <button class="shop-contact-button shop-contact-whatsapp" type="button" data-shop-contact="whatsapp" data-phone="${escapeAttribute(shop.whatsapp || '')}" data-post-id="${escapeAttribute(posts[0]?.id || '')}">${icon('whatsapp')} WhatsApp</button>
            <button class="shop-contact-button shop-contact-call" type="button" data-shop-contact="call" data-phone="${escapeAttribute(shop.whatsapp || '')}" data-post-id="${escapeAttribute(posts[0]?.id || '')}">${icon('phone')} Appeler</button>
          </div>
          <p class="muted">${escapeHtml(shop.description || '')}</p>
        </div>
        ${posts.length ? posts.map(renderShopPost).join('') : emptyState('La boutique prépare ses offres', 'Revenez bientôt découvrir les prochaines annonces.')}`;
      elements['load-more'].classList.add('hidden');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (error) {
      showToast(error.message);
    }
  }

  function renderShopPost(post) {
    const media = post.media || [];
    return `<article class="shop-listing">
      ${media[0] ? renderMedia(media[0]) : ''}
      <div><p class="eyebrow">ANNONCE</p><h3>${escapeHtml(post.title)}</h3>
      <strong>${escapeHtml(formatPriceLabel(
        post.current_price_fcfa ?? post.price_fcfa ?? post.currentPriceFcfa ?? post.priceFcfa,
        post.price_unit || post.priceUnit
      ))}</strong></div>
    </article>`;
  }

  function openPublish() {
    if (!state.token) {
      openAuth('login', 'Connectez-vous pour publier une annonce.');
      return;
    }
    renderPublishForm();
    elements['publish-dialog'].showModal();
  }

  function renderPublishForm() {
    if (!state.categories.length) {
      elements['publish-content'].innerHTML = emptyState('Catégories indisponibles', 'Reconnectez-vous au serveur puis réessayez.');
      return;
    }
    const categoryOptions = state.categories.map((category) =>
      `<option value="${category.id}">${escapeHtml(category.name)}</option>`
    ).join('');
    const cityOptions = state.cities.map((city) =>
      `<option value="${city.id}" ${Number(city.id) === Number(state.cityId) ? 'selected' : ''}>${escapeHtml(city.name)}</option>`
    ).join('');
    elements['publish-content'].innerHTML = `
      <form class="publish-form" id="publish-form">
        <label class="field-label" for="post-title">Titre de l’annonce</label>
        <input id="post-title" name="title" type="text" minlength="3" maxlength="120" placeholder="Ex. Panier de mangues fraîches" required>
        <label class="field-label" for="post-description">Description</label>
        <textarea id="post-description" name="description" rows="3" maxlength="5000" placeholder="Décrivez votre produit ou logement..."></textarea>
        <div class="form-grid">
          <div><label class="field-label" for="post-category">Catégorie</label><select id="post-category" name="category_id" required>${categoryOptions}</select></div>
          <div><label class="field-label" for="post-city">Ville</label><select id="post-city" name="city_id" required>${cityOptions}</select></div>
          <div><label class="field-label" for="post-price">Prix (FCFA)</label><input id="post-price" name="price_fcfa" type="number" min="0" step="1" inputmode="numeric" placeholder="1500" required></div>
          <div><label class="field-label" for="post-unit">Unité</label><select id="post-unit" name="price_unit"><option value="unit">Unité</option><option value="kg">Kg</option><option value="bag">Sac</option><option value="carton">Carton</option><option value="day">Jour</option><option value="month">Mois</option></select></div>
          <div id="stock-field"><label class="field-label" for="post-stock">Stock disponible</label><input id="post-stock" name="stock" type="number" min="0" step="1" inputmode="numeric" placeholder="10"></div>
          <div><label class="field-label" for="sale-price">Prix flash (facultatif)</label><input id="sale-price" name="sale_price_fcfa" type="number" min="0" step="1" inputmode="numeric" placeholder="1200"><p class="field-error hidden" id="sale-price-error"></p></div>
          <div><label class="field-label" for="sale-start">Début de l’offre</label><input id="sale-start" name="sale_starts_at" type="datetime-local" aria-describedby="sale-start-error"><p class="field-error hidden" id="sale-start-error"></p></div>
          <div><label class="field-label" for="sale-end">Fin de l’offre</label><input id="sale-end" name="sale_ends_at" type="datetime-local" aria-describedby="sale-end-error"><p class="field-error hidden" id="sale-end-error"></p></div>
        </div>
        <label class="field-label" for="post-neighborhood">Quartier <span class="optional">(facultatif)</span></label>
        <input id="post-neighborhood" name="neighborhood" type="text" maxlength="120" placeholder="Ex. Tamdja">
        <label class="field-label" for="post-media">Photos ou une vidéo</label>
        <input id="post-media" name="media" type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm,video/3gpp" multiple required>
        <p class="tiny muted">Une vidéo seule ou 1 à 8 photos. Les photos sont compressées sur le serveur. La vidéo est envoyée par morceaux pour reprendre après une coupure.</p>
        ${state.pendingUpload ? '<button class="text-button" type="button" data-action="resume-upload">Reprendre la vidéo enregistrée</button>' : ''}
        <div class="media-preview" id="media-preview"></div>
        <div class="upload-status hidden" id="upload-status"><span class="loader"></span><span id="upload-message">Préparation...</span></div>
        <progress class="upload-progress hidden" id="upload-progress" max="100" value="0"></progress>
        <button class="button button-primary full-width" id="publish-submit" type="submit">Publier l’annonce</button>
        <p class="form-message" id="publish-message" role="status"></p>
      </form>`;

    const categorySelect = document.getElementById('post-category');
    categorySelect.addEventListener('change', updateStockField);
    document.getElementById('post-media').addEventListener('change', previewFiles);
    document.getElementById('publish-form').addEventListener('submit', submitPost);
    ['sale-price', 'sale-start', 'sale-end'].forEach((id) => {
      const field = document.getElementById(id);
      field.addEventListener('input', () => {
        clearFieldError(id);
        if (id === 'sale-price') validateSalePriceLive();
      });
      field.addEventListener('change', () => {
        clearFieldError(id);
        if (id === 'sale-price') validateSalePriceLive();
      });
    });
    document.getElementById('post-price').addEventListener('input', validateSalePriceLive);
    document.getElementById('post-price').addEventListener('change', validateSalePriceLive);
    updateStockField();
  }

  function updateStockField() {
    const category = state.categories.find((item) => Number(item.id) === Number(document.getElementById('post-category').value));
    const stockField = document.getElementById('post-stock');
    const stockContainer = document.getElementById('stock-field');
    stockField.required = Boolean(category?.uses_stock);
    stockContainer.classList.toggle('hidden', !category?.uses_stock);
  }

  function previewFiles(event) {
    const files = Array.from(event.target.files || []);
    const preview = document.getElementById('media-preview');
    const hasImages = files.some((file) => file.type.startsWith('image/'));
    const hasVideos = files.some((file) => file.type.startsWith('video/'));
    if (files.length > MAX_PHOTOS || (hasImages && hasVideos) || (hasVideos && files.length > 1)) {
      event.target.value = '';
      clearPreviewUrls();
      preview.replaceChildren();
      showToast('Choisissez une vidéo seule ou jusqu’à 8 photos, sans mélanger les types.');
      return;
    }
    clearPreviewUrls();
    preview.innerHTML = files.map((file) => {
      if (file.type.startsWith('video/')) {
        return `<div class="preview-file"><span class="preview-video">${icon('play')}</span><span>${escapeHtml(file.name)}<small>${formatBytes(file.size)}</small></span></div>`;
      }
      const url = URL.createObjectURL(file);
      state.previewUrls.push(url);
      return `<div class="preview-image"><img src="${escapeAttribute(url)}" alt=""><span>${escapeHtml(file.name)}</span></div>`;
    }).join('');
  }

  function clearPreviewUrls() {
    state.previewUrls.forEach((url) => URL.revokeObjectURL(url));
    state.previewUrls = [];
  }

  async function submitPost(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const fileInput = document.getElementById('post-media');
    const files = Array.from(fileInput.files || []);
    if (!files.length) {
      showPublishMessage('Choisissez une vidéo ou des photos.');
      return;
    }
    const hasVideo = files[0].type.startsWith('video/');
    if (files.some((file) => file.type.startsWith('video/') !== hasVideo)
      || (hasVideo && files.length > 1) || files.length > MAX_PHOTOS) {
      showPublishMessage('Une annonce accepte une vidéo seule ou 1 à 8 photos.');
      return;
    }
    const formData = new FormData(form);
    const regularPrice = parseIntegerAmount(document.getElementById('post-price').value);
    if (regularPrice === null || regularPrice > 2_000_000_000) {
      showPublishMessage('Le prix doit être un nombre entier en FCFA.');
      document.getElementById('post-price').focus();
      return;
    }
    formData.set('price_fcfa', String(regularPrice));
    if (!preparePromotionFields(formData)) return;
    formData.delete('media');
    files.forEach((file) => formData.append('media', file));
    const submit = document.getElementById('publish-submit');
    setBusy(submit, true, 'Envoi en cours...');
    showPublishMessage('');
    try {
      let result;
      if (hasVideo) {
        result = await uploadVideoInChunks(files[0], formData);
      } else {
        setUploadProgress(true, 'Envoi et compression des photos...');
        result = await api('/api/posts', { method: 'POST', body: formData }, true);
      }
      elements['publish-dialog'].close();
      showToast('Annonce reçue ! Le traitement média peut prendre quelques instants.');
      form.reset();
      clearPreviewUrls();
      document.getElementById('media-preview').replaceChildren();
      setUploadProgress(false);
      showPage('feed');
      await refreshFeed();
      if (result.postId) pollPost(result.postId);
    } catch (error) {
      showPublishMessage(error.message);
      if (state.pendingUpload) {
        setUploadMessage('Envoi en pause. Vos morceaux déjà reçus sont conservés.');
        const progress = document.getElementById('publish-message');
        if (progress) {
          progress.insertAdjacentHTML('beforeend', ' <button class="text-button" type="button" data-action="resume-upload">Reprendre l’envoi</button>');
        }
      }
    } finally {
      setBusy(submit, false);
      if (!state.pendingUpload) setUploadProgress(false);
    }
  }

  function preparePromotionFields(formData) {
    const priceField = document.getElementById('sale-price');
    const startField = document.getElementById('sale-start');
    const endField = document.getElementById('sale-end');
    [priceField, startField, endField].forEach((field) => clearFieldError(field.id));

    const price = priceField.value.trim();
    const startValue = startField.value.trim();
    const endValue = endField.value.trim();
    ['sale_price_fcfa', 'sale_starts_at', 'sale_ends_at'].forEach((key) => formData.delete(key));
    if (!price) return true;

    const salePrice = parseIntegerAmount(price);
    const regularPrice = parseIntegerAmount(document.getElementById('post-price').value);
    if (salePrice === null || salePrice > 2_000_000_000 || regularPrice === null || salePrice >= regularPrice) {
      setFieldError(priceField, 'Le prix promotionnel doit être un entier inférieur au prix normal.');
    }

    const startDate = parseLocalDate(startValue);
    const endDate = parseLocalDate(endValue);
    if (!startValue) {
      setFieldError(startField, 'Indiquez le début de la promotion.');
    } else if (!startDate) {
      setFieldError(startField, 'La date de début est invalide.');
    }
    if (!endValue) {
      setFieldError(endField, 'Indiquez la fin de la promotion.');
    } else if (!endDate) {
      setFieldError(endField, 'La date de fin est invalide.');
    } else if (startDate && endDate <= startDate) {
      setFieldError(endField, 'La fin doit être postérieure au début.');
    }

    const firstInvalid = [priceField, startField, endField].find((field) => field.getAttribute('aria-invalid') === 'true');
    if (firstInvalid) {
      showPublishMessage('Corrigez les champs de la promotion signalés en rouge.');
      firstInvalid.focus();
      firstInvalid.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return false;
    }

    formData.set('sale_price_fcfa', String(salePrice));
    formData.set('sale_starts_at', startDate.toISOString());
    formData.set('sale_ends_at', endDate.toISOString());
    return true;
  }

  function parseIntegerAmount(value) {
    const cleaned = String(value ?? '').trim();
    if (!/^\d+$/.test(cleaned)) return null;
    const amount = Number(cleaned);
    return Number.isSafeInteger(amount) ? amount : null;
  }

  function validateSalePriceLive() {
    const priceField = document.getElementById('sale-price');
    const salePrice = parseIntegerAmount(priceField.value);
    if (!priceField.value.trim()) {
      clearFieldError(priceField.id);
      return;
    }
    const regularPrice = parseIntegerAmount(document.getElementById('post-price').value);
    if (salePrice === null || salePrice > 2_000_000_000 || regularPrice === null || salePrice >= regularPrice) {
      setFieldError(priceField, 'Le prix flash doit être un entier inférieur au prix normal.');
      return;
    }
    clearFieldError(priceField.id);
  }

  function parseLocalDate(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function setFieldError(field, message) {
    const error = document.getElementById(`${field.id}-error`);
    field.setAttribute('aria-invalid', 'true');
    field.classList.add('field-invalid');
    error.textContent = message;
    error.classList.remove('hidden');
  }

  function clearFieldError(fieldId) {
    const field = document.getElementById(fieldId);
    const error = document.getElementById(`${fieldId}-error`);
    if (!field || !error) return;
    field.removeAttribute('aria-invalid');
    field.classList.remove('field-invalid');
    error.textContent = '';
    error.classList.add('hidden');
  }

  async function uploadVideoInChunks(file, formData) {
    const fields = {};
    for (const [key, value] of formData.entries()) {
      if (key === 'media') continue;
      fields[key] = ['price_fcfa', 'sale_price_fcfa'].includes(key)
        ? parseIntegerAmount(value)
        : value;
    }
    setUploadProgress(true, 'Enregistrement temporaire de la vidéo...');
    const upload = uploadVideo(file, fields, api, updateUploadProgress);
    state.pendingUpload = getPendingUpload();
    try {
      const result = await upload;
      state.pendingUpload = null;
      return result;
    } catch (error) {
      state.pendingUpload = getPendingUpload();
      throw error;
    }
  }

  async function resumePendingUpload(automatic = false) {
    if (!state.pendingUpload || state.uploadResuming || !state.token) return;
    state.uploadResuming = true;
    try {
      if (!automatic) setUploadProgress(true, 'Reprise de la vidéo enregistrée...');
      const result = await resumePendingVideo(api, updateUploadProgress);
      state.pendingUpload = null;
      if (elements['publish-dialog'].open) elements['publish-dialog'].close();
      showToast('Vidéo reçue. Le traitement HLS va démarrer.');
      showPage('feed');
      await refreshFeed();
      if (result?.postId) pollPost(result.postId);
    } catch (error) {
      state.pendingUpload = getPendingUpload();
      if (automatic) showToast(`Reprise de l’envoi impossible : ${error.message}`);
      else showPublishMessage(error.message);
    } finally {
      state.uploadResuming = false;
    }
  }

  function updateUploadProgress(sent, total, status = '') {
    setUploadProgress(true, status || `Envoi de la vidéo · ${sent}/${total} morceaux`);
    const progress = document.getElementById('upload-progress');
    if (progress) progress.value = Math.round((sent / total) * 100);
  }

  async function pollPost(postId) {
    for (let attempt = 0; attempt < 24; attempt += 1) {
      await delay(2500);
      try {
        const result = await api(`/api/posts/${encodeURIComponent(postId)}`, {}, true);
        if (result.post?.status === 'published') {
          showToast('Votre annonce est maintenant visible dans le fil.');
          await refreshFeed();
          return;
        }
        if (result.post?.status === 'draft') {
          showToast('Le média n’a pas pu être traité. Vérifiez que FFmpeg est installé.');
          return;
        }
      } catch (error) {
        console.warn('Le statut de l’annonce n’a pas pu être actualisé.', error.message);
      }
    }
  }

  function setUploadProgress(visible, message = '') {
    const status = document.getElementById('upload-status');
    const progress = document.getElementById('upload-progress');
    if (!status || !progress) return;
    status.classList.toggle('hidden', !visible);
    progress.classList.toggle('hidden', !visible);
    progress.value = 0;
    setUploadMessage(message);
  }

  function setUploadMessage(message) {
    const target = document.getElementById('upload-message');
    if (target) target.textContent = message;
  }

  function showPublishMessage(message) {
    const target = document.getElementById('publish-message');
    if (target) target.textContent = message;
  }

  function api(path, options = {}, authenticated = false, raw = false) {
    return request(path, {
      ...options,
      baseUrl: state.apiUrl,
      token: state.token,
      authenticated,
      raw,
    }).then((result) => {
      if (state.apiReachable === false) {
        setApiReachable(true);
        showToast('Connexion au serveur rétablie.');
      } else {
        state.apiReachable = true;
        updateNetworkBanner();
      }
      return result;
    }).catch((error) => {
      if (error.status === 0 || error.code === 'NETWORK_ERROR' || error.code === 'TIMEOUT') {
        setApiReachable(false);
      }
      if (error.status === 401 && authenticated) {
        state.token = '';
        state.user = null;
        removeStored(TOKEN_STORAGE_KEY);
        removeStored(USER_STORAGE_KEY);
        updateAccountButton();
      }
      throw error;
    });
  }

  function absoluteUrl(url) {
    if (!url) return '';
    if (/^https?:\/\//i.test(url)) return url;
    return `${state.apiUrl}${url.startsWith('/') ? '' : '/'}${url}`;
  }

  function emptyState(title, message, actions = '') {
    return `<div class="empty-state"><span class="empty-mark">${icon('store')}</span><h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p>${actions ? `<div class="feed-footer">${actions}</div>` : ''}</div>`;
  }

  function loadingState() {
    return `<div class="loading-card"><span class="loader"></span><p>On cherche les bonnes affaires autour de vous...</p></div>`;
  }

  function showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    elements['toast-region'].appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('visible'));
    window.setTimeout(() => {
      toast.classList.remove('visible');
      window.setTimeout(() => toast.remove(), 220);
    }, 3500);
  }

  function setBusy(button, busy, label) {
    if (!button) return;
    if (busy) {
      button.dataset.originalText = button.textContent;
      button.textContent = label;
    } else if (button.dataset.originalText) {
      button.textContent = button.dataset.originalText;
      delete button.dataset.originalText;
    }
    button.disabled = busy;
  }

  function initials(value) {
    return String(value || '?')
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part.charAt(0).toUpperCase())
      .join('') || '?';
  }

  function formatBytes(value) {
    return formatByteCount(value);
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[character]);
  }

  function escapeAttribute(value) {
    return escapeHtml(value);
  }

  function delay(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }
}());
