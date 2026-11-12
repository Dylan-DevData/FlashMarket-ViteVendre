const PRICE_UNITS = {
  unit: 'unité',
  kg: 'kg',
  bag: 'sac',
  carton: 'carton',
  day: 'jour',
  month: 'mois',
};

export function formatPrice(value, unit = '') {
  const numericAmount = Number(value);
  if (!Number.isSafeInteger(numericAmount) || numericAmount < 0) return 'Prix à négocier';
  const amount = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(numericAmount);
  const formattedAmount = amount.replace(/\u00a0|\u202f/g, '\u202f');
  const label = PRICE_UNITS[unit] || unit;
  return `${formattedAmount}\u202fFCFA${label ? ` / ${label}` : ''}`;
}

export function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return 'Taille inconnue';
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} Ko`;
  return `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
}
