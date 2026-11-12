export function tapFeedback(duration = 12) {
  if (typeof navigator.vibrate !== 'function') return false;
  try {
    return navigator.vibrate(duration);
  } catch (error) {
    console.warn('Le retour haptique n’est pas disponible sur cet appareil.', error);
    return false;
  }
}
