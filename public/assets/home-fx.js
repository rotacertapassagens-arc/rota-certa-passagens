// Efeitos da página inicial: os blocos entram suavemente ao rolar e a rota do "Como funciona"
// se desenha com um aviãozinho quando aparece. Quem prefere menos movimento vê tudo parado,
// e nada fica escondido se este arquivo não carregar.
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const canObserve = 'IntersectionObserver' in window;
const wideRoute = () => matchMedia('(min-width: 1000px)').matches;

const route = document.querySelector('[data-route]');
if (route) initRoute(route);
if (!reduce && canObserve) initReveal();
const showcase = document.querySelector('.pl-showcase');
if (showcase) initShowcase(showcase);

// Vitrine do Planner: o notebook troca de tela sozinho enquanto está visível; se a pessoa
// escolhe uma aba, a troca automática para e fica na tela escolhida.
function initShowcase(box) {
  const shots = [...box.querySelectorAll('.pl-shot')];
  const tabs = [...box.querySelectorAll('.pl-tab')];
  let current = 0;
  let timer = 0;
  let visible = false;
  let picked = false;
  function show(i) {
    current = i;
    shots.forEach((shot, k) => shot.classList.toggle('is-on', k === i));
    tabs.forEach((tab, k) => tab.setAttribute('aria-pressed', String(k === i)));
  }
  function loop() {
    clearTimeout(timer);
    if (!visible || reduce || picked) return;
    timer = setTimeout(() => {
      show((current + 1) % shots.length);
      loop();
    }, 3800);
  }
  tabs.forEach((tab, k) => tab.addEventListener('click', () => {
    picked = true;
    clearTimeout(timer);
    show(k);
  }));
  if (!canObserve) return;
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    loop();
  }, { threshold: 0.3 }).observe(box);
}

function initReveal() {
  const targets = [];
  document.querySelectorAll('[data-reveal]').forEach((el) => targets.push([el, 0]));
  document.querySelectorAll('[data-reveal-group]').forEach((group) => {
    if (group.matches('.route-stops') && wideRoute()) return; // no computador a rota tem a animação própria
    // carrossel de arrastar (destinos no celular): entra inteiro, senão o cartão fora da tela ficaria escondido
    if (/auto|scroll/.test(getComputedStyle(group).overflowX)) { targets.push([group, 0]); return; }
    [...group.children].forEach((el, i) => targets.push([el, Math.min(i, 6) * 0.09]));
  });
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      io.unobserve(entry.target);
      show(entry.target);
    }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.1 });
  for (const [el, delay] of targets) {
    // o que já aparece na tela ao carregar fica como está, para nada piscar
    if (el.getBoundingClientRect().top < innerHeight * 0.95) continue;
    el.style.setProperty('--d', `${delay}s`);
    el.classList.add('fx-wait');
    io.observe(el);
  }
}

function show(el) {
  el.classList.add('is-in');
  const delay = parseFloat(el.style.getPropertyValue('--d')) || 0;
  // terminada a entrada, o elemento volta ao estilo normal (hover e afins voltam a valer)
  setTimeout(() => {
    el.classList.remove('fx-wait', 'is-in');
    el.style.removeProperty('--d');
  }, (0.85 + delay) * 1000);
}

function initRoute(route) {
  const svg = route.querySelector('.route-svg');
  const dots = svg.querySelector('.rt-dots');
  const mask = svg.querySelector('.rt-mask');
  const plane = route.querySelector('.route-plane');
  const stops = [...route.querySelectorAll('.route-stop')];
  const DURATION = 3.2;
  let drawn = false;

  // Caminho em curvas que passa pelo centro de cada parada, alternando para cima e para baixo.
  function build() {
    if (!wideRoute()) return;
    const box = route.getBoundingClientRect();
    const pts = stops.map((stop) => {
      const r = stop.querySelector('.stop-dot').getBoundingClientRect();
      return [r.left + r.width / 2 - box.left, r.top + r.height / 2 - box.top];
    });
    let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      const bend = (i % 2 ? -1 : 1) * 34;
      const dx = (x1 - x0) / 3;
      d += ` C ${(x0 + dx).toFixed(1)} ${(y0 + bend).toFixed(1)}, ${(x1 - dx).toFixed(1)} ${(y1 + bend).toFixed(1)}, ${x1.toFixed(1)} ${y1.toFixed(1)}`;
    }
    svg.setAttribute('viewBox', `0 0 ${Math.round(box.width)} ${Math.round(box.height)}`);
    dots.setAttribute('d', d);
    mask.setAttribute('d', d);
    const length = mask.getTotalLength();
    mask.style.transition = 'none';
    mask.style.strokeDasharray = `${length} ${length}`;
    mask.style.strokeDashoffset = drawn ? '0' : String(length);
    mask.getBoundingClientRect();
    mask.style.transition = '';
    plane.style.offsetPath = `path('${d}')`;
  }

  function finishNow() {
    drawn = true;
    route.classList.add('is-drawn', 'is-done');
    mask.style.strokeDashoffset = '0';
  }

  function start() {
    drawn = true;
    requestAnimationFrame(() => {
      route.classList.add('is-drawn');
      mask.style.strokeDashoffset = '0';
    });
    setTimeout(() => route.classList.add('is-done'), (DURATION + 0.9) * 1000);
  }

  build();
  if (reduce || !canObserve || !wideRoute()) {
    finishNow();
  } else {
    route.style.setProperty('--route-t', `${DURATION}s`);
    stops.forEach((stop, i) => stop.style.setProperty('--at', `${((DURATION * i) / (stops.length - 1)).toFixed(2)}s`));
    route.classList.add('fx-route');
    const io = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      io.disconnect();
      start();
    }, { threshold: 0.35 });
    io.observe(route);
  }

  let timer = 0;
  addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(build, 150);
  });
}
