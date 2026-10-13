// Runs before the page paints so the saved (or system) day/night choice never flashes.
(function () {
  var theme = null;
  try { theme = localStorage.getItem('theme'); } catch (e) { /* storage unavailable */ }
  if (theme !== 'dark' && theme !== 'light') {
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-theme', theme);
})();
