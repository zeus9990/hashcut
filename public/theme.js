// Applies the saved colour theme before the page paints, to avoid a flash.
// Night mode is the default until someone switches to day mode.
(function () {
  var t = null;
  try { t = localStorage.getItem('theme'); } catch (e) { /* storage unavailable */ }
  if (t !== 'dark' && t !== 'light') t = 'dark';
  document.documentElement.setAttribute('data-theme', t);
})();
