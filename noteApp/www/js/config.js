/**
 * Configuration de l'accès réseau à l'API backend pour ViteVendre.
 * 
 * - Sur téléphone physique (APK ou navigateur) : utilise l'adresse IP locale de ton PC (ex: Starlink).
 * - Sur émulateur Android Studio : 10.0.2.2 correspond à localhost de la machine hôte.
 */
const API_BASE_URL = 'http://192.168.1.208:3000/api';

/**
 * Détermine dynamiquement l'origine du backend selon le contexte d'exécution :
 * 
 * 1. Contexte APK Cordova (Android) :
 *    window.cordova est présent -> utilise l'IP locale configurée dans API_BASE_URL.
 * 
 * 2. Contexte Navigateur Web mobile/PC :
 *    window.location.hostname contient l'adresse IP du serveur web où la page est consultée.
 *    On se connecte donc automatiquement au backend sur le port 3000 de ce même hôte.
 * 
 * 3. Fallback par défaut :
 *    Retourne l'origine de API_BASE_URL.
 */
export function getDefaultApiOrigin() {
  // Cas 1 : Application compilée APK (Cordova Android)
  if (window.cordova?.platformId === 'android') {
    return new URL(API_BASE_URL).origin;
  }

  // Cas 2 : Navigateur mobile ou desktop (Google Chrome, Safari...)
  if (typeof window !== 'undefined' && window.location?.hostname) {
    const host = window.location.hostname;
    // Si la page est servie via une IP Wi-Fi locale (ex: 192.168.1.208:8000)
    if (host && host !== 'localhost' && host !== '127.0.0.1') {
      return `http://${host}:3000`;
    }
  }

  // Cas 3 : Repli local standard
  return new URL(API_BASE_URL).origin;
}

export { API_BASE_URL };
