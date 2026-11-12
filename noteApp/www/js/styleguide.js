const toggle = document.getElementById('theme-toggle');

toggle.addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme !== 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  toggle.textContent = dark ? 'Thème clair' : 'Thème sombre';
  toggle.setAttribute('aria-pressed', String(dark));
});
