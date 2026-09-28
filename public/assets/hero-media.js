// Topo da home: o vídeo da rota fica no lugar do antigo quadro de passos e repete sozinho.
// As 4 frases entram no tempo da bolinha dourada, o bilhete aparece logo depois da chegada ao
// Brasil, fica alguns segundos e sai antes da volta recomeçar. Nada depende de rolar a página.
const media = document.querySelector('.hero-media');
if (media) initHeroMedia(media);

function initHeroMedia(media) {
  const video = media.querySelector('.hm-video');
  const layers = [...media.querySelectorAll('.hm-step')]; // 4 passos + a chegada
  const fills = [...media.querySelectorAll('.hm-track i')];
  const dip = media.querySelector('.hm-dip');
  // data-cues (segundos do vídeo): início dos passos 1 a 4, chegada da bolinha, entrada e saída do bilhete
  const cues = (media.dataset.cues || '').split(',').map(Number);
  const [arriveAt, ticketIn, ticketOut] = cues.slice(4);
  const DIP = 0.45; // transição pelo céu na volta do loop, para não ter corte seco
  const TAIL_RATE = 0.8; // desacelera o final (quase parado) para o bilhete ficar mais tempo na tela
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const small = matchMedia('(max-width: 700px)');
  const rvfc = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

  let phase = '';
  let loaded = false;
  let started = false;
  let inView = false;
  let firstCycle = true;
  let lastT = 0;
  let req = 0;
  let watchdog = 0;
  let dipShown = -1;
  const fillShown = fills.map(() => -1);

  media.querySelectorAll('.hm-title').forEach(splitWords);

  function setPhase(next) {
    if (next === phase) return;
    phase = next;
    media.dataset.phase = next;
    const on = next.startsWith('step') ? Number(next.slice(4)) : layers.length - 1;
    layers.forEach((el, i) => el.classList.toggle('is-on', i === on));
    const rate = next === 'ticket' ? TAIL_RATE : 1;
    if (video.playbackRate !== rate) video.playbackRate = rate;
  }

  function phaseAt(t) {
    if (t >= ticketOut) return 'gap';
    if (t >= ticketIn) return 'ticket';
    if (t >= arriveAt) return 'arrive';
    let i = 0;
    while (i < 3 && t >= cues[i + 1]) i++;
    return `step${i}`;
  }

  function setFill(k, p) {
    const q = Math.round(p * 1000);
    if (q === fillShown[k]) return;
    fillShown[k] = q;
    fills[k].style.transform = `scaleX(${q / 1000})`;
  }

  function render(t) {
    if (t + 1 < lastT) firstCycle = false; // o vídeo voltou ao começo
    lastT = t;
    setPhase(phaseAt(t));
    for (let k = 0; k < 4; k++) {
      const end = cues[k + 1];
      setFill(k, Math.min(1, Math.max(0, (t - cues[k]) / (end - cues[k]))));
    }
    const d = video.duration || 0;
    let o = 0;
    if (!firstCycle && t < DIP) o = 1 - t / DIP;
    if (d && t > d - DIP) o = Math.min(1, (t - (d - DIP)) / DIP);
    const q = Math.round(o * 100);
    if (q !== dipShown) {
      dipShown = q;
      dip.style.opacity = String(q / 100);
    }
  }

  function tick() {
    req = 0;
    render(video.currentTime);
    if (!video.paused) schedule();
  }
  function schedule() {
    if (req) return;
    req = rvfc ? video.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
  }
  function cancel() {
    if (!req) return;
    if (rvfc) video.cancelVideoFrameCallback(req);
    else cancelAnimationFrame(req);
    req = 0;
  }

  // Sem animação (movimento reduzido, vídeo bloqueado ou com erro): quadro da chegada com o bilhete.
  function showStatic() {
    cancel();
    setPhase('static');
    fills.forEach((_, k) => setFill(k, 1));
    dipShown = 0;
    dip.style.opacity = '0';
    if (started && video.duration) video.currentTime = Math.min(video.duration - 0.1, ticketIn + 1);
    else video.poster = media.dataset.posterEnd;
  }

  function load() {
    if (loaded) return;
    loaded = true;
    video.preload = 'auto';
    video.src = small.matches ? media.dataset.srcSmall : media.dataset.src;
    watchdog = setTimeout(() => { if (!started) showStatic(); }, 12000);
  }

  const wantPlay = () => inView && !document.hidden && !reduced.matches;

  function sync() {
    if (wantPlay()) {
      load();
      if (video.paused) video.play().catch(onPlayRejected);
    } else if (!video.paused) {
      video.pause();
    }
  }

  // Economia de bateria do iPhone e afins bloqueiam o play automático: mostra o quadro da chegada
  // e tenta de novo no primeiro toque ou tecla da pessoa na página.
  function onPlayRejected(error) {
    if (!error || error.name !== 'NotAllowedError') return;
    showStatic();
    const events = ['pointerdown', 'touchend', 'keydown'];
    const retry = () => {
      events.forEach((name) => document.removeEventListener(name, retry, true));
      if (wantPlay()) video.play().catch(() => {});
    };
    events.forEach((name) => document.addEventListener(name, retry, { capture: true, passive: true }));
  }

  video.addEventListener('playing', () => {
    started = true;
    clearTimeout(watchdog);
    schedule();
  });
  video.addEventListener('pause', cancel);
  video.addEventListener('error', () => { if (!started) showStatic(); });
  document.addEventListener('visibilitychange', sync);
  reduced.addEventListener?.('change', () => {
    if (reduced.matches) {
      video.pause();
      showStatic();
    } else {
      sync();
    }
  });

  if (reduced.matches) showStatic();
  else setPhase('step0');

  // Só toca com o quadro na tela (no celular ele fica abaixo do texto) e pausa quando sai,
  // inclusive quando o site.js esconde a home para abrir o Planejador ou a Área do cliente.
  new IntersectionObserver(([entry]) => {
    inView = entry.intersectionRatio >= 0.35;
    sync();
  }, { threshold: [0, 0.35] }).observe(media);
}

function splitWords(el) {
  const words = el.textContent.trim().split(/\s+/);
  el.textContent = '';
  words.forEach((word, i) => {
    if (i) el.append(' ');
    const span = document.createElement('span');
    span.className = 'w';
    span.style.setProperty('--i', String(i));
    span.textContent = word;
    el.append(span);
  });
}
