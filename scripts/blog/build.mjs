// Gera os Guias de viagem (blog) a partir de scripts/blog/posts.mjs.
// Uso: npm run blog:build  (grava public/blog/index.html, um HTML por post e atualiza public/sitemap.xml)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atualizado, posts, regioes } from './posts.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pub = join(root, 'public');
const SITE = 'https://rotacertapassagens.com';
const WHATSAPP = 'https://wa.me/351925307391';
const nomeRegiao = Object.fromEntries(regioes.map((r) => [r.id, r.nome]));

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const urlPost = (p) => `/blog/${p.slug}`;
const proposta = (destino) => `/proposta-voo?destino=${encodeURIComponent(destino)}`;

// Largura e altura de um JPEG, para o navegador reservar o espaço da foto antes de ela chegar.
function jpegSize(file) {
  const b = readFileSync(file);
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1];
    const len = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  throw new Error(`sem dimensões: ${file}`);
}
const foto = (nome) => {
  const g = jpegSize(join(pub, 'assets', 'blog', `${nome}.jpg`));
  const m = jpegSize(join(pub, 'assets', 'blog', `${nome}-m.jpg`));
  return { src: `/assets/blog/${nome}.jpg`, srcM: `/assets/blog/${nome}-m.jpg`, g, m };
};

function head({ titulo, descricao, url, imagem, tipo = 'website', jsonLd }) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(titulo)}</title>
<meta name="description" content="${esc(descricao)}">
<link rel="canonical" href="${SITE}${url}">
<meta property="og:type" content="${tipo}">
<meta property="og:site_name" content="Rota Certa Passagens">
<meta property="og:locale" content="pt_BR">
<meta property="og:title" content="${esc(titulo)}">
<meta property="og:description" content="${esc(descricao)}">
<meta property="og:url" content="${SITE}${url}">
<meta property="og:image" content="${SITE}${imagem}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" type="image/png" href="/assets/favicon.png">
<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,500;0,600;0,700;1,500;1,600&family=Montserrat:wght@300;400;500;600;700&family=IBM+Plex+Mono:wght@500;600&display=optional" rel="stylesheet">
<link rel="stylesheet" href="/assets/blog.css">${jsonLd ? `\n<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>` : ''}
</head>
<body>`;
}

function header(naLista) {
  return `
<header class="bl-header">
  <div class="wrap">
    <a class="bl-logo" href="/"><img src="/assets/logo-simbolo-claro.png" alt="" width="40" height="40">Rota Certa <span>Passagens</span></a>
    <nav class="bl-nav" aria-label="Navegação principal">
      <a href="/" class="bl-hide-sm">Início</a>
      <a href="/blog/"${naLista ? ' aria-current="page"' : ''}>Guias de viagem</a>
      <a href="/#/planner" class="bl-hide-sm">Planejador</a>
      <a href="/proposta-voo" class="btn btn-gold btn-sm bl-cta-btn"><span class="t-full">Pedir proposta de voo</span><span class="t-mid">Pedir proposta</span><span class="t-short">Proposta</span></a>
    </nav>
  </div>
</header>`;
}

function footer(scripts) {
  return `
<footer class="bl-footer">
  <div class="wrap">
    <div class="bl-foot-grid">
      <div>
        <a class="bl-logo" href="/"><img src="/assets/logo-simbolo-claro.png" alt="" width="40" height="40" loading="lazy">Rota Certa <span>Passagens</span></a>
        <p>Você escolhe o destino. Nós tratamos da rota.</p>
      </div>
      <div>
        <h2>Explorar</h2>
        <ul>
          <li><a href="/#como-funciona">Como funciona</a></li>
          <li><a href="/#servicos">Serviços</a></li>
          <li><a href="/#planner">Rota Certa Planner</a></li>
          <li><a href="/blog/">Guias de viagem</a></li>
        </ul>
      </div>
      <div>
        <h2>Empresa</h2>
        <ul>
          <li><a href="/#faq">Perguntas frequentes</a></li>
          <li><a href="/#sobre">Sobre nós</a></li>
          <li><a href="/proposta-voo">Pedir proposta de voo</a></li>
        </ul>
      </div>
      <div>
        <h2>Contato</h2>
        <ul>
          <li><a href="${WHATSAPP}" target="_blank" rel="noopener">WhatsApp</a></li>
          <li><a href="mailto:contato@rotacertapassagens.com">contato@rotacertapassagens.com</a></li>
          <li><a href="https://www.instagram.com/rotacerta.passagens/" target="_blank" rel="noopener">Instagram</a></li>
          <li><a href="https://app.notion.com/p/Pol-tica-de-Privacidade-344e5d1415884db8b629bcc5dbfb7f50?source=copy_link" target="_blank" rel="noopener">Política de Privacidade</a></li>
        </ul>
      </div>
    </div>
    <div class="bl-foot-bottom">
      <span>© 2026 Rota Certa Passagens. Todos os direitos reservados.</span>
      <span>Fotos: Pexels.</span>
    </div>
  </div>
</footer>

<a class="wa-float" href="${WHATSAPP}" target="_blank" rel="noopener" aria-label="Falar no WhatsApp">
  <svg width="28" height="28" viewBox="0 0 24 24" fill="#fff" aria-hidden="true"><path d="M17.5 14.4c-.3-.1-1.7-.9-2-1-.3-.1-.5-.1-.7.1-.2.3-.8 1-.9 1.1-.2.2-.3.2-.6.1-.3-.1-1.2-.5-2.4-1.5-.9-.8-1.5-1.8-1.6-2.1-.2-.3 0-.5.1-.6.1-.1.3-.3.4-.5.1-.1.2-.3.2-.5.1-.2 0-.4 0-.5-.1-.1-.7-1.6-.9-2.2-.2-.5-.4-.5-.6-.5h-.5c-.2 0-.5.1-.7.3-.3.3-1 1-1 2.4s1 2.8 1.2 3c.1.2 2 3.1 4.9 4.3.7.3 1.2.5 1.6.6.7.2 1.3.2 1.8.1.5-.1 1.7-.7 1.9-1.4.2-.7.2-1.2.2-1.3-.1-.1-.3-.2-.6-.3z"/><path d="M12 2C6.5 2 2 6.5 2 12c0 1.9.5 3.6 1.4 5.1L2 22l5.1-1.3c1.4.8 3.1 1.2 4.9 1.2 5.5 0 10-4.5 10-10S17.5 2 12 2zm0 18.2c-1.6 0-3.2-.4-4.5-1.2l-.3-.2-3.4.9.9-3.3-.2-.3C3.7 14.6 3.2 13 3.2 12c0-4.8 3.9-8.8 8.8-8.8s8.8 3.9 8.8 8.8-4 8.2-8.8 8.2z"/></svg>
</a>
${scripts.map((s) => `<script type="module" src="${s}"></script>`).join('\n')}
</body>
</html>
`;
}

function card(p, tituloTag, { destaque = false } = {}) {
  const f = foto(p.foto);
  return `        <a class="post-card${destaque ? ' pc-featured' : ''}" href="${urlPost(p)}" data-regiao="${p.regiao}"${p.destaque ? ' data-destaque="sim"' : ''}>
          <div class="pc-img"><img src="${f.srcM}" alt="" width="${f.m.w}" height="${f.m.h}" loading="lazy" decoding="async"><span class="pc-tag">${esc(nomeRegiao[p.regiao])}</span></div>
          <div class="pc-body">
            <p class="pc-meta">${p.leitura} min de leitura</p>
            <${tituloTag}>${esc(p.titulo)}</${tituloTag}>
            <p>${esc(p.resumo)}</p>
            <span class="pc-more">Ler o guia <span aria-hidden="true">→</span></span>
          </div>
        </a>`;
}

function paginaPost(p) {
  const f = foto(p.foto);
  const url = urlPost(p);
  const relacionados = [
    ...posts.filter((o) => o !== p && o.regiao === p.regiao),
    ...posts.filter((o) => o !== p && o.regiao !== p.regiao),
  ].slice(0, 3);
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: p.titulo,
    description: p.resumo,
    image: [`${SITE}${f.src}`],
    datePublished: atualizado.iso,
    dateModified: atualizado.iso,
    inLanguage: 'pt-BR',
    author: { '@type': 'Organization', name: 'Rota Certa Passagens', url: SITE },
    publisher: { '@type': 'Organization', name: 'Rota Certa Passagens', logo: { '@type': 'ImageObject', url: `${SITE}/assets/logo-simbolo-claro.png` } },
    mainEntityOfPage: `${SITE}${url}`,
  };
  const ctaTitulo = p.ctaTitulo || `Quer conhecer <em>${esc(p.destino)}</em>?`;
  const ctaTexto = p.ctaTexto || 'Conte de onde você sai e as datas. A nossa equipe prepara a proposta de voo, em dinheiro ou em milhas, e responde por e-mail em até 48 horas.';
  return `${head({ titulo: `${p.titulo} | Rota Certa Passagens`, descricao: p.resumo, url, imagem: f.src, tipo: 'article', jsonLd })}${header(false)}

<main>
  <article>
    <header class="post-hero">
      <picture>
        <source media="(max-width: 700px)" srcset="${f.srcM}">
        <img class="ph-bg" src="${f.src}" alt="${esc(p.fotoAlt)}" width="${f.g.w}" height="${f.g.h}" fetchpriority="high">
      </picture>
      <div class="wrap">
        <nav class="crumbs" aria-label="Você está em">
          <a href="/">Início</a><span aria-hidden="true">›</span><a href="/blog/">Guias de viagem</a><span aria-hidden="true">›</span><a href="/blog/#${p.regiao}">${esc(nomeRegiao[p.regiao])}</a>
        </nav>
        <h1>${p.tituloHtml}</h1>
        <p class="post-lede">${esc(p.lede)}</p>
        <p class="post-meta">${p.leitura} min de leitura · Atualizado em ${atualizado.texto}</p>
      </div>
    </header>
    <div class="post-body">${p.corpo}
      <aside class="post-cta" data-reveal>
        <h2>${ctaTitulo}</h2>
        <p>${esc(ctaTexto)}</p>
        <a class="btn btn-gold" href="${proposta(p.destino)}">Pedir proposta de voo <span aria-hidden="true">→</span></a>
      </aside>
      <p class="post-note">Regras de entrada, horários e ingressos mudam. Confira sempre nos canais oficiais antes de viajar.</p>
    </div>
  </article>
  <section class="related" aria-labelledby="outros-guias">
    <div class="wrap">
      <h2 id="outros-guias">Outros <em>guias</em></h2>
      <div class="bl-grid" data-reveal-group>
${relacionados.map((o) => card(o, 'h3')).join('\n')}
      </div>
    </div>
  </section>
</main>
${footer(['/assets/home-fx.js'])}`;
}

function paginaIndice() {
  const f = foto('guias');
  const ordem = [...posts].sort((a, b) => Number(Boolean(b.destaque)) - Number(Boolean(a.destaque)));
  const descricao = 'Roteiros, bairros e dicas práticas para viajar entre o Brasil, Portugal e a Europa: Lisboa, Roma, Paris, Istambul, Albânia e mais.';
  return `${head({ titulo: 'Guias de viagem | Rota Certa Passagens', descricao, url: '/blog/', imagem: f.src })}${header(true)}

<main>
  <section class="bl-hero">
    <picture>
      <source media="(max-width: 700px)" srcset="${f.srcM}">
      <img class="ph-bg" src="${f.src}" alt="" width="${f.g.w}" height="${f.g.h}" fetchpriority="high">
    </picture>
    <div class="wrap">
      <p class="eyebrow">Guias de viagem</p>
      <h1>Inspiração e dicas para a sua <em>próxima viagem</em></h1>
      <p>Roteiros, bairros e cuidados práticos para viajar entre o Brasil, Portugal e a Europa, escritos pela equipe da Rota Certa.</p>
    </div>
  </section>

  <section class="bl-list" aria-label="Guias">
    <div class="wrap">
      <div class="bl-filters" role="group" aria-label="Filtrar por destino">
        <button class="bl-filter" type="button" data-regiao="todos" aria-pressed="true">Todos</button>
${regioes.map((r) => `        <button class="bl-filter" type="button" data-regiao="${r.id}" aria-pressed="false">${esc(r.nome)}</button>`).join('\n')}
      </div>
      <div class="bl-grid" data-reveal-group>
${ordem.map((p) => card(p, 'h2', { destaque: Boolean(p.destaque) })).join('\n')}
      </div>
    </div>
  </section>

  <section class="bl-cta">
    <picture>
      <source media="(max-width: 700px)" srcset="/assets/home/final-nuvens-m.jpg">
      <img class="ph-bg" src="/assets/home/final-nuvens.jpg" alt="" width="1920" height="1280" loading="lazy" decoding="async">
    </picture>
    <div class="wrap" data-reveal>
      <h2>Encontrou o seu próximo <em>destino</em>?</h2>
      <p>Peça uma proposta de voo ou organize a viagem inteira no Planejador.</p>
      <div class="bl-ctas">
        <a class="btn btn-gold" href="/proposta-voo">Pedir proposta de voo</a>
        <a class="btn btn-outline" href="/#/planner">Quero planejar a minha viagem</a>
      </div>
    </div>
  </section>
</main>
${footer(['/assets/home-fx.js', '/assets/blog.js'])}`;
}

function atualizarSitemap() {
  const file = join(pub, 'sitemap.xml');
  const xml = readFileSync(file, 'utf8');
  const semBlog = xml.replace(/\s*<url>\s*<loc>https:\/\/rotacertapassagens\.com\/blog\/[^<]*<\/loc>[\s\S]*?<\/url>/g, '');
  const urls = ['/blog/', ...posts.map(urlPost)].map((u) => `  <url>\n    <loc>${SITE}${u}</loc>\n    <lastmod>${atualizado.iso}</lastmod>\n  </url>`).join('\n');
  writeFileSync(file, semBlog.replace('</urlset>', `${urls}\n</urlset>`));
}

mkdirSync(join(pub, 'blog'), { recursive: true });
writeFileSync(join(pub, 'blog', 'index.html'), paginaIndice());
for (const p of posts) writeFileSync(join(pub, 'blog', `${p.slug}.html`), paginaPost(p));
atualizarSitemap();
console.log(`blog: índice + ${posts.length} posts gerados em public/blog/`);
