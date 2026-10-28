// Abertura leve: logo + nome por ~1,2s (só CSS, sem vídeo). Toque para pular.
(function () {
  var root = document.documentElement;
  var el = document.getElementById('splash');
  if (!el) return;
  if (!root.classList.contains('splash-on')) return;
  try { sessionStorage.setItem('fp_splash_seen', '1'); } catch (e) {}
  var feito = false;
  function fechar() {
    if (feito) return;
    feito = true;
    el.classList.add('hide');
    setTimeout(function () { root.classList.remove('splash-on'); }, 450);
  }
  el.addEventListener('click', fechar);
  setTimeout(fechar, 1200);
  setTimeout(fechar, 3000);
})();
