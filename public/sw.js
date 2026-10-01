// App Rota Certa (service worker): abre sem internet a última versão do site, do Planner e dos anexos já baixados.
// Regras: páginas e dados da API sempre tentam a rede primeiro; o que fica no aparelho é só cópia para quando não há conexão.
// Os dados da conta (rc-dados, rc-anexos) são apagados pelo site ao sair da conta.
const VERSAO = 'v2';
const SHELL = `rc-shell-${VERSAO}`;
const DADOS = 'rc-dados';
const ANEXOS = 'rc-anexos';
const PRECACHE = [
  '/', '/assets/site.js', '/assets/hero-media.js', '/assets/home-fx.js', '/manifest.webmanifest',
  '/assets/logo-simbolo-claro.png', '/assets/favicon.png', '/assets/app/icone-192.png',
  '/assets/planner/visao-geral-m.jpg', '/assets/planner/itinerario-m.jpg', '/assets/planner/lugares-m.jpg',
  '/assets/planner/orcamento-m.jpg', '/assets/planner/checklist-m.jpg',
  '/assets/telas/cliente-entrar-m.jpg', '/assets/telas/cliente-logado-m.jpg',
  '/assets/fonts/fontes.css', '/assets/fonts/montserrat-300-700-latin.woff2', '/assets/fonts/playfair-display-400-700-latin.woff2',
];
const OFFLINE_HTML = '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sem internet | Rota Certa</title></head>'
  + '<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0d1b2a;color:#f4f4f4;font:16px/1.5 Arial,sans-serif;text-align:center;padding:24px">'
  + '<div><p style="color:#d4af37;letter-spacing:.2em;font-size:.75rem;font-weight:700">ROTA CERTA</p><h1 style="font-family:Georgia,serif">Você está sem internet</h1>'
  + '<p>Esta página ainda não foi salva no aparelho. O seu Planner continua disponível.</p><p><a href="/#/planner" style="color:#d4af37">Abrir o Planner</a></p></div></body></html>';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => Promise.all(PRECACHE.map((url) => cache.add(url).catch(() => undefined)))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => key.startsWith('rc-shell-') && key !== SHELL).map((key) => caches.delete(key))))
    .then(() => self.clients.claim()));
});

async function networkFirst(request, cacheName, cacheKey) {
  try {
    const response = await fetch(request);
    if (response.ok) (await caches.open(cacheName)).put(cacheKey || request, response.clone());
    return response;
  } catch (error) {
    const cached = await caches.match(cacheKey || request, { cacheName });
    if (cached) return cached;
    throw error;
  }
}

// Viagem do Planner: guarda com e sem o número da viagem (?tripId=), para trocar de aba sem internet.
async function plannerData(event) {
  const request = event.request;
  const cache = await caches.open(DADOS);
  try {
    const response = await fetch(request);
    if (response.ok) {
      const copy = response.clone();
      event.waitUntil((async () => {
        const body = await copy.json();
        const json = JSON.stringify(body);
        const headers = { 'content-type': 'application/json' };
        await cache.put(request, new Response(json, { headers }));
        if (body?.trip?.id) {
          const url = new URL(request.url);
          url.search = `?tripId=${encodeURIComponent(body.trip.id)}`;
          await cache.put(url.toString(), new Response(json, { headers }));
        }
      })().catch(() => undefined));
    }
    return response;
  } catch (error) {
    const cached = (await cache.match(request)) || (await cache.match(new URL('/api/planner', request.url).toString()));
    if (cached) return cached;
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const p = url.pathname;

  // Bilhetes e vouchers (antes das páginas: tocar no anexo abre como página nova): não mudam depois de enviados, então o que já está no aparelho abre na hora.
  if (/^\/api\/planner\/[0-9a-f-]+\/attachments\/[0-9a-f-]+$/i.test(p)) {
    event.respondWith((async () => {
      const cached = await caches.match(request, { cacheName: ANEXOS });
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) (await caches.open(ANEXOS)).put(request, response.clone());
      return response;
    })());
    return;
  }

  // Páginas: rede primeiro. Sem conexão, a página inicial (onde mora o Planner) sai do aparelho.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok && (p === '/' || p === '/index.html')) (await caches.open(SHELL)).put('/', response.clone());
        return response;
      } catch {
        if (p === '/' || p === '/index.html') {
          const home = await caches.match('/', { cacheName: SHELL });
          if (home) return home;
        }
        return new Response(OFFLINE_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
    })());
    return;
  }

  // Sessão e dados do Planner: rede primeiro, cópia do aparelho sem conexão.
  if (p === '/api/auth/session' || p === '/api/planner/rates') {
    event.respondWith(networkFirst(request, DADOS));
    return;
  }
  if (p === '/api/planner') {
    event.respondWith(plannerData(event));
    return;
  }
  if (p.startsWith('/api/')) return;

  // Scripts e estilos: sempre a versão nova quando há rede (página e script nunca ficam de versões diferentes).
  if ((p.startsWith('/assets/') && /\.(js|css)$/i.test(p)) || p === '/manifest.webmanifest') {
    event.respondWith(networkFirst(request, SHELL));
    return;
  }
  // Imagens e ícones (menos vídeos): responde com a cópia e atualiza em segundo plano.
  if (p.startsWith('/assets/') && !/\.(mp4|webm)$/i.test(p)) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL);
      const cached = await cache.match(request);
      const fresh = fetch(request).then((response) => { if (response.ok) cache.put(request, response.clone()); return response; });
      if (cached) { event.waitUntil(fresh.catch(() => undefined)); return cached; }
      return fresh;
    })());
  }
});
