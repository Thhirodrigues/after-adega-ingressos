// Splash de abertura: vídeo -> pausa de 1 segundo no último quadro -> entra no app.
// Toca uma vez por sessão (index.html?splash=1 força). Se o vídeo falhar, o app abre direto.
(function () {
  var splash = document.getElementById('splash');
  var video = document.getElementById('splash-video');
  if (!splash || !video || !document.documentElement.classList.contains('splash-on')) return;

  var HOLD_MS = 1000;               // pausa depois que o vídeo termina
  var finished = false, holdTimer = null, guardTimer = null;

  function finish() {
    if (finished) return;
    finished = true;
    clearTimeout(holdTimer); clearTimeout(guardTimer);
    try { sessionStorage.setItem('fp_splash_seen', '1'); } catch (e) {}
    try { video.pause(); } catch (e) {}
    splash.classList.add('hide');
    document.documentElement.classList.remove('splash-on');
    setTimeout(function () { if (splash.parentNode) splash.parentNode.removeChild(splash); }, 600);
  }

  video.addEventListener('ended', function () {
    if (finished) return;
    clearTimeout(guardTimer);
    holdTimer = setTimeout(finish, HOLD_MS);
  });
  video.addEventListener('error', finish);   // vídeo ausente ou com erro: segue direto para o app
  splash.addEventListener('click', finish);  // toque em qualquer lugar pula

  // Se o vídeo não começar em 6 s, não prende ninguém na splash
  guardTimer = setTimeout(finish, 6000);
  video.addEventListener('playing', function () {
    clearTimeout(guardTimer);
    guardTimer = setTimeout(finish, 15000);  // trava de segurança
  }, { once: true });

  // Celular em pé usa o vídeo vertical; tela larga usa o horizontal
  var emPe = window.matchMedia && window.matchMedia('(max-aspect-ratio: 1/1)').matches;
  video.src = emPe ? '/splash-vertical.mp4' : '/splash.mp4';

  // Tenta tocar com som; se o navegador bloquear, toca sem som
  video.muted = false;
  var p = video.play();
  if (p && p.catch) {
    p.catch(function () {
      video.muted = true;
      var q = video.play();
      if (q && q.catch) q.catch(finish);
    });
  }
})();
