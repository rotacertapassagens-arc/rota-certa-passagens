const hero = document.querySelector('.hero-scrub');
if (hero) initHeroScrub(hero);

function initHeroScrub(hero) {
  const stage = hero.querySelector('.hs-stage');
  const video = hero.querySelector('.hs-video');
  const poster = hero.querySelector('.hs-poster');
  const ring = hero.querySelector('.hs-ring');
  const VIDEO_URL = hero.dataset.video;
  const POSTER_URL = hero.dataset.poster;
  const VIDEO_BYTES = Number(hero.dataset.bytes) || 0;
  const TIME_MAP = (hero.dataset.timemap || '0:0,1:1')
    .split(',')
    .map((pair) => pair.split(':').map(Number))
    .filter(([p, t]) => Number.isFinite(p) && Number.isFinite(t))
    .sort((x, y) => x[0] - y[0]);

  const GATES = [
    '(max-width: 720px)',
    '(orientation: portrait) and (max-width: 1024px)',
    '(orientation: portrait) and (pointer: coarse)',
    '(orientation: landscape) and (pointer: coarse) and (max-height: 560px)',
    '(prefers-reduced-motion: reduce)',
  ];
  const MQLS = GATES.map((q) => matchMedia(q));

  hero.querySelectorAll('[data-split]').forEach(splitWords);

  const bands = [...hero.querySelectorAll('[data-a]')].map((el) => ({
    el,
    a: Number(el.dataset.a),
    b: Number(el.dataset.b),
    ramp: el.dataset.ramp ? Number(el.dataset.ramp) : null,
    op: -1,
    k: -1,
  }));
  const firstBand = bands.find((band) => band.a === 0);

  let scrubOn = false;
  let heroStarted = false;
  let heroOnScreen = true;
  let target = 0;
  let shown = 0;
  let rafId = null;
  let lastTick = 0;
  let seekBusy = false;
  let pendingTime = null;
  let loadK = 0;
  let loadStart = 0;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const smoothstep = (p, e0, e1) => {
    const t = clamp((p - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  };

  function heroVisible() {
    return hero.offsetParent !== null && hero.offsetHeight > 0;
  }

  function heroProgress() {
    if (!heroVisible()) return 0;
    const range = hero.offsetHeight - innerHeight;
    if (range <= 0) return 0;
    return clamp(-hero.getBoundingClientRect().top / range, 0, 1);
  }

  function videoTimeAt(p) {
    const end = Math.max(0, video.duration - 0.04);
    let t = TIME_MAP[TIME_MAP.length - 1][1];
    for (let i = 1; i < TIME_MAP.length; i++) {
      const [p0, t0] = TIME_MAP[i - 1];
      const [p1, t1] = TIME_MAP[i];
      if (p <= p1) {
        t = t0 + (t1 - t0) * (p1 === p0 ? 1 : (p - p0) / (p1 - p0));
        break;
      }
    }
    if (p <= TIME_MAP[0][0]) t = TIME_MAP[0][1];
    return clamp(t, 0, end);
  }

  function requestSeek(t) {
    if (!video.duration || !Number.isFinite(t)) return;
    if (seekBusy) { pendingTime = t; return; }
    seekBusy = true;
    video.currentTime = t;
  }
  video.addEventListener('seeked', () => {
    seekBusy = false;
    if (pendingTime !== null) {
      const t = pendingTime;
      pendingTime = null;
      requestSeek(t);
    }
  });
  video.addEventListener('error', () => {
    seekBusy = false;
    pendingTime = null;
    failVideo();
  });

  function updateCaptions(p) {
    for (const band of bands) {
      const f = Math.min(0.02, (band.b - band.a) / 3);
      const enter = band.a === 0 ? 1 : smoothstep(p, band.a, band.a + f);
      const exit = band.b >= 1 ? 1 : 1 - smoothstep(p, band.b - f, band.b);
      const op = Math.round(enter * exit * 1000) / 1000;
      if (op !== band.op) {
        band.op = op;
        band.el.style.opacity = op;
        band.el.classList.toggle('is-on', op > 0.02);
      }
      const ramp = band.ramp || Math.min(0.025, (band.b - band.a) * 0.35);
      let k = clamp((p - band.a) / ramp, 0, 1);
      if (band === firstBand) k = Math.max(k, loadK);
      if (Math.abs(k - band.k) > 0.008 || (k === 1 && band.k !== 1) || (k === 0 && band.k !== 0)) {
        band.k = k;
        band.el.style.setProperty('--k', k.toFixed(3));
      }
    }
    const cueOn = p < 0.04;
    if (hero.dataset.cue !== String(cueOn)) hero.dataset.cue = String(cueOn);
  }

  function tick(now) {
    const dt = Math.min(100, now - (lastTick || now));
    lastTick = now;
    if (loadStart && loadK < 1) loadK = clamp((now - loadStart) / 900, 0, 1);
    shown += (target - shown) * (1 - Math.pow(1 - 0.16, dt / 16.667));
    const settled = Math.abs(target - shown) < 0.0005 && (!loadStart || loadK >= 1);
    if (settled) {
      shown = target;
      rafId = null;
      lastTick = 0;
    } else {
      rafId = requestAnimationFrame(tick);
    }
    if (video.duration) requestSeek(videoTimeAt(shown));
    updateCaptions(shown);
  }

  function onScroll() {
    if (!scrubOn || !heroVisible()) return;
    target = heroProgress();
    if (rafId === null && heroOnScreen) rafId = requestAnimationFrame(tick);
  }

  function initHeroOnce() {
    if (heroStarted) return;
    heroStarted = true;
    poster.style.backgroundImage = `url('${POSTER_URL}')`;
    let started = false;
    const startBlob = () => {
      if (started) return;
      started = true;
      loadHeroBlob().catch(failVideo);
    };
    const img = new Image();
    img.onload = startBlob;
    img.onerror = startBlob;
    img.src = POSTER_URL;
    setTimeout(startBlob, 4000);
    loadStart = performance.now();
  }

  async function loadHeroBlob() {
    const ctrl = new AbortController();
    let watchdog = setTimeout(() => ctrl.abort(), 20000);
    const res = await fetch(VIDEO_URL, { priority: 'low', signal: ctrl.signal });
    if (!res.ok || !res.body) throw new Error('video_unavailable');
    const total = Number(res.headers.get('Content-Length')) || VIDEO_BYTES;
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    let lastRing = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      clearTimeout(watchdog);
      watchdog = setTimeout(() => ctrl.abort(), 20000);
      chunks.push(value);
      got += value.length;
      const frac = total ? Math.min(1, got / total) : 0;
      const now = performance.now();
      if (now - lastRing > 100 || frac === 1) {
        lastRing = now;
        ring.style.setProperty('--ld', Math.round(126 * (1 - frac)));
      }
    }
    clearTimeout(watchdog);
    ring.style.setProperty('--ld', 0);
    video.src = URL.createObjectURL(new Blob(chunks, { type: 'video/mp4' }));
    video.load();
    video.addEventListener('canplay', () => {
      stage.classList.add('video-ready');
      target = heroProgress();
      shown = target;
      requestSeek(videoTimeAt(shown));
      updateCaptions(shown);
    }, { once: true });
  }

  function failVideo() {
    stage.classList.add('video-failed');
    video.removeAttribute('src');
  }

  function pinFinalStates() {
    for (const band of bands) {
      band.op = -1;
      band.k = -1;
      band.el.style.removeProperty('opacity');
      band.el.style.removeProperty('--k');
      band.el.classList.remove('is-on');
    }
  }

  function enableScrub() {
    if (scrubOn) return;
    scrubOn = true;
    hero.classList.add('is-scrub');
    initHeroOnce();
    addEventListener('scroll', onScroll, { passive: true });
    addEventListener('resize', onScroll, { passive: true });
    for (const band of bands) { band.op = -1; band.k = -1; }
    target = heroProgress();
    shown = target;
    updateCaptions(shown);
    onScroll();
  }

  function disableScrub() {
    if (!scrubOn) return;
    scrubOn = false;
    hero.classList.remove('is-scrub');
    removeEventListener('scroll', onScroll);
    removeEventListener('resize', onScroll);
    if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    pinFinalStates();
  }

  function applyHeroMode() {
    if (MQLS.some((m) => m.matches)) disableScrub();
    else enableScrub();
  }

  new IntersectionObserver((entries) => {
    heroOnScreen = entries[0].isIntersecting;
    if (heroOnScreen) onScroll();
  }).observe(hero);

  document.addEventListener('visibilitychange', () => {
    document.body.classList.toggle('paused', document.hidden);
  });

  MQLS.forEach((m) => m.addEventListener('change', applyHeroMode));
  applyHeroMode();
}

function splitWords(el) {
  const readable = document.createElement('span');
  readable.className = 'sr-only';
  readable.textContent = el.textContent.replace(/\s+/g, ' ').trim();
  const visual = document.createElement('span');
  visual.className = 'hs-words';
  visual.setAttribute('aria-hidden', 'true');
  let i = 0;
  const addWords = (text, emphasis) => {
    for (const part of text.split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) { visual.appendChild(document.createTextNode(' ')); continue; }
      const word = document.createElement('span');
      word.className = emphasis ? 'w em' : 'w';
      word.style.setProperty('--i', i++);
      word.textContent = part;
      visual.appendChild(word);
    }
  };
  for (const node of [...el.childNodes]) {
    if (node.nodeType === Node.TEXT_NODE) addWords(node.textContent, false);
    else if (node.nodeType === Node.ELEMENT_NODE) addWords(node.textContent, node.tagName === 'EM');
  }
  visual.style.setProperty('--n', Math.max(1, i));
  el.replaceChildren(readable, visual);
}
