// Applies the saved (or system) colour theme before the page paints, to avoid a flash.
(function () {
  var t = null;
  try { t = localStorage.getItem('theme'); } catch (e) { /* storage unavailable */ }
  if (t !== 'dark' && t !== 'light') {
    t = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-theme', t);
})();
