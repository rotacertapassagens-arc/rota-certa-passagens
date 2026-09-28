// Guias de viagem (blog) editáveis no painel admin.
// - Páginas públicas (/blog/, /blog/<slug>) montadas a partir do D1, com o visual de public/assets/blog.css.
// - API do editor (/api/admin/blog/...), só para usuários master, com Origin + CSRF nas alterações.
// - Fotos (/media/blog/<id>/<g|m>) guardadas em base64 no D1, já reduzidas pelo navegador.
// - /sitemap.xml gerado na hora, com os guias publicados.
import { Buffer } from 'node:buffer';

type Row = Record<string, unknown>;
type AuthLike = { userId: string; roles: string[] };
export type BlogDeps = {
  reply: (data: unknown, status?: number, headers?: HeadersInit) => Response;
  getAuth: (req: Request, env: Env) => Promise<AuthLike | null>;
  mutationAuth: (req: Request, env: Env) => Promise<AuthLike | null>;
  audit: (env: Env, actor: string | null, action: string, targetType: string, targetId: string | null) => Promise<void>;
};

type Block =
  | { t: 'p'; text: string }
  | { t: 'h'; label?: string; text: string }
  | { t: 'ul'; items: string[] }
  | { t: 'tip'; title?: string; items: string[] }
  | { t: 'img'; src: string; small?: string; alt?: string; caption?: string; w?: number; h?: number }
  | { t: 'quote'; text: string };

type Post = {
  id: string; slug: string; status: 'draft' | 'published'; region_id: string; region_name: string;
  title: string; title_highlight: string | null; summary: string; lede: string | null; destination: string | null;
  cta_title: string | null; cover_url: string | null; cover_url_small: string | null; cover_alt: string | null;
  featured: number; body: string; reading_minutes: number; published_at: string | null; updated_at: string;
};

const WHATSAPP = 'https://wa.me/351925307391';
const CSP = "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; media-src 'self' blob:; frame-src https://www.google.com; connect-src 'self'; upgrade-insecure-requests";
const MEDIA_URL = /^\/media\/blog\/[0-9a-f-]{36}\/(g|m)$/;
const ASSET_URL = /^\/assets\/blog\/[a-z0-9-]+\.(jpg|jpeg|png|webp)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_MEDIA_BYTES = 1_400_000; // base64 de 1,4 MB ainda cabe no limite de 2 MB por linha do D1
const POST_COLUMNS = `p.id,p.slug,p.status,p.region_id,r.name AS region_name,p.title,p.title_highlight,p.summary,p.lede,p.destination,p.cta_title,
  p.cover_url,p.cover_url_small,p.cover_alt,p.featured,p.body,p.reading_minutes,p.published_at,p.updated_at`;

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const site = (env: Env) => String(env.APP_ORIGIN).replace(/\/$/, '');
const isImageUrl = (v: unknown): v is string => typeof v === 'string' && (MEDIA_URL.test(v) || ASSET_URL.test(v));

function text(value: unknown, max: number, min = 0): string | null {
  const v = typeof value === 'string' ? value.trim() : '';
  return v.length >= min && v.length <= max ? v : null;
}
function optional(value: unknown, max: number): string | null | undefined {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return null;
  return text(value, max) ?? undefined; // undefined = inválido
}

export function slugify(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/, '');
}

// Negrito com **texto** e link com [texto](endereço). Tudo o mais é escapado, então nada vira HTML.
export function inline(value: string): string {
  let h = esc(value);
  h = h.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/\[([^\]]+?)\]\(([^)\s]+?)\)/g, (_m, label: string, href: string) => {
    const raw = href.replace(/&amp;/g, '&');
    if (!/^(https?:\/\/|\/|mailto:)/i.test(raw)) return label;
    const externo = /^https?:\/\//i.test(raw);
    return `<a href="${href}"${externo ? ' target="_blank" rel="noopener"' : ''}>${label}</a>`;
  });
  return h.replace(/\r?\n/g, '<br>');
}

// ---------- validação dos blocos do texto ----------
function list(value: unknown, maxItems: number, maxLen: number): string[] | null {
  if (!Array.isArray(value)) return null;
  const items = value.map((v) => text(v, maxLen)).filter((v): v is string => Boolean(v));
  return items.length && items.length <= maxItems ? items : null;
}
function block(value: unknown): Block | null {
  if (!value || typeof value !== 'object') return null;
  const b = value as Row;
  switch (b.t) {
    case 'p': { const t = text(b.text, 5000, 1); return t ? { t: 'p', text: t } : null; }
    case 'quote': { const t = text(b.text, 1000, 1); return t ? { t: 'quote', text: t } : null; }
    case 'h': {
      const t = text(b.text, 160, 1); const label = optional(b.label, 40);
      return t && label !== undefined ? { t: 'h', text: t, ...(label ? { label } : {}) } : null;
    }
    case 'ul': { const items = list(b.items, 40, 800); return items ? { t: 'ul', items } : null; }
    case 'tip': {
      const items = list(b.items, 40, 800); const title = optional(b.title, 80);
      return items && title !== undefined ? { t: 'tip', items, ...(title ? { title } : {}) } : null;
    }
    case 'img': {
      if (!isImageUrl(b.src)) return null;
      const small = b.small === undefined || b.small === null || b.small === '' ? undefined : (isImageUrl(b.small) ? b.small : null);
      const alt = optional(b.alt, 200); const caption = optional(b.caption, 300);
      if (small === null || alt === undefined || caption === undefined) return null;
      const w = Number(b.w); const h = Number(b.h);
      return {
        t: 'img', src: b.src, ...(small ? { small } : {}), ...(alt ? { alt } : {}), ...(caption ? { caption } : {}),
        ...(Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 && w <= 4000 && h <= 4000 ? { w, h } : {}),
      };
    }
    default: return null;
  }
}
function blocks(value: unknown): Block[] | null {
  if (!Array.isArray(value) || value.length > 150) return null;
  const out: Block[] = [];
  for (const v of value) { const b = block(v); if (!b) return null; out.push(b); }
  return out;
}
function readingMinutes(post: { title: string; summary: string }, body: Block[]): number {
  const texts = [post.title, post.summary];
  for (const b of body) {
    if (b.t === 'p' || b.t === 'quote' || b.t === 'h') texts.push(b.text);
    if (b.t === 'ul' || b.t === 'tip') texts.push(...b.items);
    if (b.t === 'img' && b.caption) texts.push(b.caption);
  }
  const words = texts.join(' ').split(/\s+/).filter(Boolean).length;
  return Math.max(2, Math.round(words / 200));
}
function parseBody(raw: string): Block[] { try { return blocks(JSON.parse(raw)) ?? []; } catch { return []; } }

// ---------- páginas ----------
function head(env: Env, o: { titulo: string; descricao: string; url: string; imagem?: string | null; tipo?: string; jsonLd?: unknown; noindex?: boolean }) {
  const imagem = o.imagem ? `${site(env)}${o.imagem}` : `${site(env)}/assets/blog/guias.jpg`;
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(o.titulo)}</title>
<meta name="description" content="${esc(o.descricao)}">
<link rel="canonical" href="${site(env)}${o.url}">${o.noindex ? '\n<meta name="robots" content="noindex, nofollow">' : ''}
<meta property="og:type" content="${o.tipo || 'website'}">
<meta property="og:site_name" content="Rota Certa Passagens">
<meta property="og:locale" content="pt_BR">
<meta property="og:title" content="${esc(o.titulo)}">
<meta property="og:description" content="${esc(o.descricao)}">
<meta property="og:url" content="${site(env)}${o.url}">
<meta property="og:image" content="${esc(imagem)}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" type="image/png" href="/assets/favicon.png">
<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,500;0,600;0,700;1,500;1,600&family=Montserrat:wght@300;400;500;600;700&family=IBM+Plex+Mono:wght@500;600&display=optional" rel="stylesheet">
<link rel="stylesheet" href="/assets/blog.css">${o.jsonLd ? `\n<script type="application/ld+json">${JSON.stringify(o.jsonLd).replace(/</g, '\\u003c')}</script>` : ''}
</head>
<body>`;
}

function header(naLista: boolean) {
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

function footer(scripts: string[]) {
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
      <span>© ${new Date().getUTCFullYear()} Rota Certa Passagens. Todos os direitos reservados.</span>
      <span>Fotos: Pexels e equipe Rota Certa.</span>
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

function titleHtml(p: Pick<Post, 'title' | 'title_highlight'>) {
  const t = p.title; const h = p.title_highlight;
  if (!h) return esc(t);
  const i = t.indexOf(h);
  if (i < 0) return esc(t);
  return `${esc(t.slice(0, i))}<em>${esc(h)}</em>${esc(t.slice(i + h.length))}`;
}

function card(p: Post, tituloTag: 'h2' | 'h3', destaque = false) {
  const img = p.cover_url_small || p.cover_url;
  return `        <a class="post-card${destaque ? ' pc-featured' : ''}" href="/blog/${esc(p.slug)}" data-regiao="${esc(p.region_id)}"${p.featured ? ' data-destaque="sim"' : ''}>
          <div class="pc-img">${img ? `<img src="${esc(img)}" alt="" loading="lazy" decoding="async">` : ''}<span class="pc-tag">${esc(p.region_name)}</span></div>
          <div class="pc-body">
            <p class="pc-meta">${p.reading_minutes} min de leitura</p>
            <${tituloTag}>${esc(p.title)}</${tituloTag}>
            <p>${esc(p.summary)}</p>
            <span class="pc-more">Ler o guia <span aria-hidden="true">→</span></span>
          </div>
        </a>`;
}

function renderBlocks(body: Block[]) {
  return body.map((b) => {
    switch (b.t) {
      case 'p': return `<p>${inline(b.text)}</p>`;
      case 'h': return `<h2>${b.label ? `<span class="num">${esc(b.label)}</span>` : ''}${esc(b.text)}</h2>`;
      case 'ul': return `<ul>${b.items.map((i) => `<li>${inline(i)}</li>`).join('')}</ul>`;
      case 'tip': return `<div class="tip"><h3>${esc(b.title || 'Dicas práticas')}</h3><ul>${b.items.map((i) => `<li>${inline(i)}</li>`).join('')}</ul></div>`;
      case 'quote': return `<blockquote class="post-quote"><p>${inline(b.text)}</p></blockquote>`;
      case 'img': {
        const srcset = b.small ? ` srcset="${esc(b.small)} 900w, ${esc(b.src)} 1600w" sizes="(max-width: 820px) 100vw, 760px"` : '';
        const dims = b.w && b.h ? ` width="${b.w}" height="${b.h}"` : '';
        return `<figure><img src="${esc(b.src)}"${srcset} alt="${esc(b.alt || '')}"${dims} loading="lazy" decoding="async">${b.caption ? `<figcaption>${esc(b.caption)}</figcaption>` : ''}</figure>`;
      }
    }
  }).join('\n');
}

function dataPt(iso: string | null) {
  const d = iso ? new Date(`${iso.replace(' ', 'T')}Z`) : new Date();
  const meses = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  return `${meses[d.getUTCMonth()]} de ${d.getUTCFullYear()}`;
}

function postPage(env: Env, p: Post, related: Post[], preview: boolean) {
  const url = `/blog/${p.slug}`;
  const body = parseBody(p.body);
  const jsonLd = {
    '@context': 'https://schema.org', '@type': 'BlogPosting', headline: p.title, description: p.summary,
    image: p.cover_url ? [`${site(env)}${p.cover_url}`] : undefined,
    datePublished: (p.published_at || p.updated_at).replace(' ', 'T'), dateModified: p.updated_at.replace(' ', 'T'), inLanguage: 'pt-BR',
    author: { '@type': 'Organization', name: 'Rota Certa Passagens', url: site(env) },
    publisher: { '@type': 'Organization', name: 'Rota Certa Passagens', logo: { '@type': 'ImageObject', url: `${site(env)}/assets/logo-simbolo-claro.png` } },
    mainEntityOfPage: `${site(env)}${url}`,
  };
  const destino = p.destination || '';
  const ctaTitulo = p.cta_title ? esc(p.cta_title) : destino ? `Quer conhecer <em>${esc(destino)}</em>?` : 'Quer fazer essa <em>viagem</em>?';
  const proposta = destino ? `/proposta-voo?destino=${encodeURIComponent(destino)}` : '/proposta-voo';
  const capa = p.cover_url ? `
      <picture>${p.cover_url_small ? `\n        <source media="(max-width: 700px)" srcset="${esc(p.cover_url_small)}">` : ''}
        <img class="ph-bg" src="${esc(p.cover_url)}" alt="${esc(p.cover_alt || '')}" fetchpriority="high">
      </picture>` : '';
  return `${head(env, { titulo: `${p.title} | Rota Certa Passagens`, descricao: p.summary, url, imagem: p.cover_url, tipo: 'article', jsonLd: preview ? undefined : jsonLd, noindex: preview })}${header(false)}
${preview ? `<div class="bl-preview" role="status">Pré-visualização. ${p.status === 'published' ? 'Este guia está publicado.' : 'Este guia ainda não está publicado: só quem está no painel vê esta página.'}</div>` : ''}
<main>
  <article>
    <header class="post-hero">${capa}
      <div class="wrap">
        <nav class="crumbs" aria-label="Você está em">
          <a href="/">Início</a><span aria-hidden="true">›</span><a href="/blog/">Guias de viagem</a><span aria-hidden="true">›</span><a href="/blog/#${esc(p.region_id)}">${esc(p.region_name)}</a>
        </nav>
        <h1>${titleHtml(p)}</h1>
        <p class="post-lede">${esc(p.lede || p.summary)}</p>
        <p class="post-meta">${p.reading_minutes} min de leitura · Atualizado em ${dataPt(p.updated_at)}</p>
      </div>
    </header>
    <div class="post-body">
${renderBlocks(body)}
      <aside class="post-cta" data-reveal>
        <h2>${ctaTitulo}</h2>
        <p>Conte de onde você sai e as datas. A nossa equipe prepara a proposta de voo, em dinheiro ou em milhas, e responde por e-mail em até 48 horas.</p>
        <a class="btn btn-gold" href="${esc(proposta)}">Pedir proposta de voo <span aria-hidden="true">→</span></a>
      </aside>
      <p class="post-note">Regras de entrada, horários e ingressos mudam. Confira sempre nos canais oficiais antes de viajar.</p>
    </div>
  </article>${related.length ? `
  <section class="related" aria-labelledby="outros-guias">
    <div class="wrap">
      <h2 id="outros-guias">Outros <em>guias</em></h2>
      <div class="bl-grid" data-reveal-group>
${related.map((o) => card(o, 'h3')).join('\n')}
      </div>
    </div>
  </section>` : ''}
</main>
${footer(['/assets/home-fx.js'])}`;
}

function indexPage(env: Env, posts: Post[], regions: { id: string; name: string }[]) {
  const descricao = 'Roteiros, bairros e dicas práticas para viajar entre o Brasil, Portugal e a Europa, escritos pela equipe da Rota Certa.';
  const destaque = posts.find((p) => p.featured);
  const ordem = destaque ? [destaque, ...posts.filter((p) => p !== destaque)] : posts;
  return `${head(env, { titulo: 'Guias de viagem | Rota Certa Passagens', descricao, url: '/blog/' })}${header(true)}

<main>
  <section class="bl-hero">
    <picture>
      <source media="(max-width: 700px)" srcset="/assets/blog/guias-m.jpg">
      <img class="ph-bg" src="/assets/blog/guias.jpg" alt="" fetchpriority="high">
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
${regions.map((r) => `        <button class="bl-filter" type="button" data-regiao="${esc(r.id)}" aria-pressed="false">${esc(r.name)}</button>`).join('\n')}
      </div>
      <div class="bl-grid" data-reveal-group>
${ordem.length ? ordem.map((p) => card(p, 'h2', p === destaque)).join('\n') : '        <p class="bl-empty">Os primeiros guias estão a caminho.</p>'}
      </div>
    </div>
  </section>

  <section class="bl-cta">
    <picture>
      <source media="(max-width: 700px)" srcset="/assets/home/final-nuvens-m.jpg">
      <img class="ph-bg" src="/assets/home/final-nuvens.jpg" alt="" loading="lazy" decoding="async">
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

function notFoundPage(env: Env) {
  return `${head(env, { titulo: 'Guia não encontrado | Rota Certa Passagens', descricao: 'Este guia não existe ou saiu do ar.', url: '/blog/', noindex: true })}${header(false)}
<main class="bl-404">
  <div class="wrap">
    <p class="eyebrow">Guias de viagem</p>
    <h1>Não encontramos este <em>guia</em></h1>
    <p>Ele pode ter mudado de endereço ou saído do ar. Veja os outros guias ou peça uma proposta de voo.</p>
    <div class="bl-ctas"><a class="btn btn-gold" href="/blog/">Ver todos os guias</a><a class="btn btn-outline-dark" href="/proposta-voo">Pedir proposta de voo</a></div>
  </div>
</main>
${footer([])}`;
}

function htmlResponse(body: string, status = 200, extra: Record<string, string> = {}) {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=0, must-revalidate', 'content-security-policy': CSP, ...extra } });
}

async function publishedPosts(env: Env) {
  const rows = await env.DB.prepare(`SELECT ${POST_COLUMNS} FROM blog_posts p JOIN blog_regions r ON r.id=p.region_id WHERE p.status='published' ORDER BY p.featured DESC, p.published_at DESC`).all<Post>();
  return rows.results;
}

async function sitemap(env: Env) {
  const posts = await env.DB.prepare(`SELECT slug, updated_at FROM blog_posts WHERE status='published' ORDER BY published_at DESC`).all<{ slug: string; updated_at: string }>();
  const hoje = new Date().toISOString().slice(0, 10);
  const fixas = ['/', '/proposta-voo', '/parceiros', '/politica-privacidade-parceiros.html', '/blog/'];
  const urls = [
    ...fixas.map((u) => ({ loc: u, lastmod: hoje })),
    ...posts.results.map((p) => ({ loc: `/blog/${p.slug}`, lastmod: p.updated_at.slice(0, 10) })),
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url>\n    <loc>${site(env)}${esc(u.loc)}</loc>\n    <lastmod>${u.lastmod}</lastmod>\n  </url>`).join('\n')}\n</urlset>\n`;
  return new Response(xml, { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
}

async function media(req: Request, env: Env, id: string, variant: string) {
  const cache = (caches as unknown as { default: Cache }).default;
  const hit = await cache.match(req);
  if (hit) return new Response(hit.body, hit);
  const row = await env.DB.prepare('SELECT content_type, data FROM blog_media WHERE id=? AND variant=?').bind(id, variant).first<{ content_type: string; data: string }>();
  if (!row) return new Response('Foto não encontrada', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  const res = new Response(Buffer.from(row.data, 'base64'), { headers: { 'content-type': row.content_type, 'cache-control': 'public, max-age=31536000, immutable' } });
  await cache.put(req, res.clone());
  return res;
}

/** Rotas públicas: /blog/, /blog/<slug>, /blog/preview/<id>, /media/blog/<id>/<g|m>, /sitemap.xml. */
export async function blogPublic(req: Request, env: Env, url: URL, deps: BlogDeps): Promise<Response | null> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return null;
  const p = url.pathname;
  if (p === '/sitemap.xml') return sitemap(env);
  const m = p.match(/^\/media\/blog\/([0-9a-f-]{36})\/(g|m)$/);
  if (m) return media(req, env, m[1]!, m[2]!);
  if (p === '/blog') return new Response(null, { status: 301, headers: { location: '/blog/' } });
  if (p === '/blog/') {
    const posts = await publishedPosts(env);
    const comPosts = new Set(posts.map((x) => x.region_id));
    const regions = (await env.DB.prepare('SELECT id, name FROM blog_regions ORDER BY sort_order, name').all<{ id: string; name: string }>()).results.filter((r) => comPosts.has(r.id));
    return htmlResponse(indexPage(env, posts, regions));
  }
  const preview = p.match(/^\/blog\/preview\/([0-9a-f-]{36})$/);
  if (preview) {
    const auth = await deps.getAuth(req, env);
    if (!auth?.roles.includes('master')) return htmlResponse(notFoundPage(env), 404, { 'cache-control': 'no-store' });
    const post = await env.DB.prepare(`SELECT ${POST_COLUMNS} FROM blog_posts p JOIN blog_regions r ON r.id=p.region_id WHERE p.id=?`).bind(preview[1]).first<Post>();
    if (!post) return htmlResponse(notFoundPage(env), 404, { 'cache-control': 'no-store' });
    return htmlResponse(postPage(env, post, [], true), 200, { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' });
  }
  const slug = p.match(/^\/blog\/([a-z0-9-]{1,80})\/?$/);
  if (slug) {
    const post = await env.DB.prepare(`SELECT ${POST_COLUMNS} FROM blog_posts p JOIN blog_regions r ON r.id=p.region_id WHERE p.slug=? AND p.status='published'`).bind(slug[1]).first<Post>();
    if (!post) return htmlResponse(notFoundPage(env), 404);
    const outros = (await publishedPosts(env)).filter((o) => o.id !== post.id);
    const related = [...outros.filter((o) => o.region_id === post.region_id), ...outros.filter((o) => o.region_id !== post.region_id)].slice(0, 3);
    return htmlResponse(postPage(env, post, related, false));
  }
  if (p.startsWith('/blog/')) return htmlResponse(notFoundPage(env), 404);
  return null;
}

// ---------- API do editor (somente master) ----------
type PostInput = {
  title: string; titleHighlight: string | null; summary: string; lede: string | null; destination: string | null; ctaTitle: string | null;
  regionId: string; slug: string | null; coverUrl: string | null; coverUrlSmall: string | null; coverAlt: string | null; featured: boolean; body: Block[];
};

function parsePost(b: Row | null): { ok: true; value: PostInput } | { ok: false; field: string } {
  if (!b) return { ok: false, field: 'body' };
  const title = text(b.title, 140, 3); if (!title) return { ok: false, field: 'title' };
  const summary = text(b.summary, 300, 10); if (!summary) return { ok: false, field: 'summary' };
  const regionId = text(b.regionId, 40, 1); if (!regionId) return { ok: false, field: 'regionId' };
  const titleHighlight = optional(b.titleHighlight, 80); if (titleHighlight === undefined) return { ok: false, field: 'titleHighlight' };
  const lede = optional(b.lede, 300); if (lede === undefined) return { ok: false, field: 'lede' };
  const destination = optional(b.destination, 80); if (destination === undefined) return { ok: false, field: 'destination' };
  const ctaTitle = optional(b.ctaTitle, 120); if (ctaTitle === undefined) return { ok: false, field: 'ctaTitle' };
  const coverAlt = optional(b.coverAlt, 200); if (coverAlt === undefined) return { ok: false, field: 'coverAlt' };
  const coverUrl = b.coverUrl ? (isImageUrl(b.coverUrl) ? b.coverUrl : null) : null;
  if (b.coverUrl && !coverUrl) return { ok: false, field: 'coverUrl' };
  const coverUrlSmall = b.coverUrlSmall ? (isImageUrl(b.coverUrlSmall) ? b.coverUrlSmall : null) : null;
  if (b.coverUrlSmall && !coverUrlSmall) return { ok: false, field: 'coverUrlSmall' };
  let slug: string | null = null;
  if (typeof b.slug === 'string' && b.slug.trim()) { slug = slugify(b.slug); if (slug.length < 3) return { ok: false, field: 'slug' }; }
  const body = blocks(b.body); if (!body) return { ok: false, field: 'body' };
  return {
    ok: true,
    value: { title, titleHighlight: titleHighlight && title.includes(titleHighlight) ? titleHighlight : null, summary, lede, destination, ctaTitle, regionId, slug, coverUrl, coverUrlSmall, coverAlt, featured: b.featured === true, body },
  };
}

async function uniqueSlug(env: Env, wanted: string, exceptId: string | null) {
  const base = wanted || 'guia';
  for (let n = 1; n < 50; n++) {
    const candidate = n === 1 ? base : `${base.slice(0, 76)}-${n}`;
    const taken = await env.DB.prepare('SELECT id FROM blog_posts WHERE slug=?').bind(candidate).first<{ id: string }>();
    if (!taken || taken.id === exceptId) return candidate;
  }
  return `${base.slice(0, 70)}-${crypto.randomUUID().slice(0, 6)}`;
}

async function masterOnly(req: Request, env: Env, deps: BlogDeps, mutation: boolean): Promise<{ ok: false; error: Response } | { ok: true; auth: AuthLike }> {
  const auth = mutation ? await deps.mutationAuth(req, env) : await deps.getAuth(req, env);
  if (!auth) return { ok: false, error: deps.reply({ error: 'unauthorized' }, 401) };
  if (!auth.roles.includes('master')) return { ok: false, error: deps.reply({ error: 'forbidden' }, 403) };
  return { ok: true, auth };
}

const POST_ADMIN_COLUMNS = 'id,slug,status,region_id,title,title_highlight,summary,lede,destination,cta_title,cover_url,cover_url_small,cover_alt,featured,body,reading_minutes,published_at,created_at,updated_at';

function adminPost(row: Row) {
  return {
    id: row.id, slug: row.slug, status: row.status, regionId: row.region_id, title: row.title, titleHighlight: row.title_highlight,
    summary: row.summary, lede: row.lede, destination: row.destination, ctaTitle: row.cta_title, coverUrl: row.cover_url,
    coverUrlSmall: row.cover_url_small, coverAlt: row.cover_alt, featured: Boolean(row.featured), body: parseBody(String(row.body)),
    readingMinutes: row.reading_minutes, publishedAt: row.published_at, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function imageType(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}

async function uploadMedia(req: Request, env: Env, userId: string, deps: BlogDeps) {
  let form: FormData;
  try { form = await req.formData(); } catch { return deps.reply({ error: 'invalid_upload' }, 400); }
  const w = Number(form.get('w')); const h = Number(form.get('h')); const wm = Number(form.get('wm')); const hm = Number(form.get('hm'));
  const dims = [w, h, wm, hm];
  if (!dims.every((d) => Number.isInteger(d) && d > 0 && d <= 4000)) return deps.reply({ error: 'invalid_dimensions' }, 400);
  const files = [form.get('g'), form.get('m')];
  const parts: { variant: 'g' | 'm'; type: string; data: string; size: number }[] = [];
  for (const [i, file] of files.entries()) {
    if (!file || typeof file === 'string') return deps.reply({ error: 'missing_file' }, 400);
    const bytes = new Uint8Array(await (file as File).arrayBuffer());
    if (!bytes.length || bytes.length > MAX_MEDIA_BYTES) return deps.reply({ error: 'file_too_large' }, 413);
    const type = imageType(bytes);
    if (!type) return deps.reply({ error: 'unsupported_type' }, 415);
    parts.push({ variant: i === 0 ? 'g' : 'm', type, data: Buffer.from(bytes).toString('base64'), size: bytes.length });
  }
  const id = crypto.randomUUID();
  await env.DB.batch(parts.map((part, i) => env.DB.prepare('INSERT INTO blog_media (id, variant, content_type, data, width, height, size, created_by) VALUES (?,?,?,?,?,?,?,?)')
    .bind(id, part.variant, part.type, part.data, i === 0 ? w : wm, i === 0 ? h : hm, part.size, userId)));
  await deps.audit(env, userId, 'blog.media_uploaded', 'blog_media', id);
  return deps.reply({ id, src: `/media/blog/${id}/g`, small: `/media/blog/${id}/m`, w, h }, 201);
}

/** API do editor: /api/admin/blog, /api/admin/blog/posts[/<id>[/publish|/unpublish]], /api/admin/blog/regions, /api/admin/blog/media. */
export async function blogAdmin(req: Request, env: Env, url: URL, deps: BlogDeps): Promise<Response | null> {
  const p = url.pathname;
  if (!p.startsWith('/api/admin/blog')) return null;
  const mutation = req.method !== 'GET';
  const gate = await masterOnly(req, env, deps, mutation);
  if (!gate.ok) return gate.error;
  const userId = gate.auth.userId;

  if (p === '/api/admin/blog' && req.method === 'GET') {
    const [posts, regions] = await Promise.all([
      env.DB.prepare(`SELECT p.id,p.slug,p.status,p.region_id,p.title,p.cover_url_small,p.cover_url,p.featured,p.published_at,p.updated_at,r.name AS region_name
        FROM blog_posts p JOIN blog_regions r ON r.id=p.region_id ORDER BY p.updated_at DESC`).all(),
      env.DB.prepare('SELECT id, name, sort_order FROM blog_regions ORDER BY sort_order, name').all(),
    ]);
    return deps.reply({ posts: posts.results, regions: regions.results });
  }

  if (p === '/api/admin/blog/regions' && req.method === 'POST') {
    let b: Row | null = null; try { b = await req.json() as Row; } catch { /* corpo inválido */ }
    const name = text(b?.name, 40, 2);
    if (!name) return deps.reply({ error: 'invalid_region' }, 400);
    const id = slugify(name).slice(0, 40);
    if (id.length < 2) return deps.reply({ error: 'invalid_region' }, 400);
    const exists = await env.DB.prepare('SELECT id, name FROM blog_regions WHERE id=?').bind(id).first<{ id: string; name: string }>();
    if (exists) return deps.reply({ region: exists }, 200);
    const order = await env.DB.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM blog_regions').first<{ n: number }>();
    await env.DB.prepare('INSERT INTO blog_regions (id, name, sort_order) VALUES (?,?,?)').bind(id, name, order?.n ?? 1).run();
    await deps.audit(env, userId, 'blog.region_created', 'blog_region', id);
    return deps.reply({ region: { id, name } }, 201);
  }

  if (p === '/api/admin/blog/media' && req.method === 'POST') return uploadMedia(req, env, userId, deps);

  if (p === '/api/admin/blog/posts' && req.method === 'POST') {
    let b: Row | null = null; try { b = await req.json() as Row; } catch { /* corpo inválido */ }
    const parsed = parsePost(b);
    if (!parsed.ok) return deps.reply({ error: 'invalid_post', field: parsed.field }, 400);
    const v = parsed.value;
    if (!(await env.DB.prepare('SELECT 1 FROM blog_regions WHERE id=?').bind(v.regionId).first())) return deps.reply({ error: 'invalid_post', field: 'regionId' }, 400);
    const id = crypto.randomUUID();
    const slug = await uniqueSlug(env, v.slug || slugify(v.title), null);
    const stmts = [
      env.DB.prepare(`INSERT INTO blog_posts (id, slug, status, region_id, title, title_highlight, summary, lede, destination, cta_title, cover_url, cover_url_small, cover_alt, featured, body, reading_minutes, created_by, updated_by)
        VALUES (?,?,'draft',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(id, slug, v.regionId, v.title, v.titleHighlight, v.summary, v.lede, v.destination, v.ctaTitle, v.coverUrl, v.coverUrlSmall, v.coverAlt, v.featured ? 1 : 0, JSON.stringify(v.body), readingMinutes(v, v.body), userId, userId),
    ];
    if (v.featured) stmts.push(env.DB.prepare('UPDATE blog_posts SET featured=0 WHERE id<>?').bind(id));
    await env.DB.batch(stmts);
    await deps.audit(env, userId, 'blog.post_created', 'blog_post', id);
    return deps.reply({ id, slug }, 201);
  }

  const one = p.match(/^\/api\/admin\/blog\/posts\/([0-9a-f-]{36})(?:\/(publish|unpublish))?$/);
  if (one && UUID.test(one[1]!)) {
    const id = one[1]!; const action = one[2];
    const current = await env.DB.prepare(`SELECT ${POST_ADMIN_COLUMNS} FROM blog_posts WHERE id=?`).bind(id).first<Row>();
    if (!current) return deps.reply({ error: 'not_found' }, 404);

    if (!action && req.method === 'GET') return deps.reply({ post: adminPost(current) });

    if (!action && req.method === 'PUT') {
      let b: Row | null = null; try { b = await req.json() as Row; } catch { /* corpo inválido */ }
      const parsed = parsePost(b);
      if (!parsed.ok) return deps.reply({ error: 'invalid_post', field: parsed.field }, 400);
      const v = parsed.value;
      if (!(await env.DB.prepare('SELECT 1 FROM blog_regions WHERE id=?').bind(v.regionId).first())) return deps.reply({ error: 'invalid_post', field: 'regionId' }, 400);
      const slug = v.slug && v.slug !== current.slug ? await uniqueSlug(env, v.slug, id) : String(current.slug);
      const stmts = [
        env.DB.prepare(`UPDATE blog_posts SET slug=?, region_id=?, title=?, title_highlight=?, summary=?, lede=?, destination=?, cta_title=?, cover_url=?, cover_url_small=?, cover_alt=?, featured=?, body=?, reading_minutes=?, updated_by=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
          .bind(slug, v.regionId, v.title, v.titleHighlight, v.summary, v.lede, v.destination, v.ctaTitle, v.coverUrl, v.coverUrlSmall, v.coverAlt, v.featured ? 1 : 0, JSON.stringify(v.body), readingMinutes(v, v.body), userId, id),
      ];
      if (v.featured) stmts.push(env.DB.prepare('UPDATE blog_posts SET featured=0 WHERE id<>?').bind(id));
      await env.DB.batch(stmts);
      await deps.audit(env, userId, 'blog.post_updated', 'blog_post', id);
      return deps.reply({ id, slug });
    }

    if (action === 'publish' && req.method === 'POST') {
      const faltando: string[] = [];
      if (!current.cover_url) faltando.push('coverUrl');
      if (!parseBody(String(current.body)).length) faltando.push('body');
      if (faltando.length) return deps.reply({ error: 'incomplete', missing: faltando }, 422);
      await env.DB.prepare(`UPDATE blog_posts SET status='published', published_at=COALESCE(published_at, CURRENT_TIMESTAMP), updated_by=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(userId, id).run();
      await deps.audit(env, userId, 'blog.post_published', 'blog_post', id);
      return deps.reply({ id, slug: current.slug, status: 'published' });
    }

    if (action === 'unpublish' && req.method === 'POST') {
      await env.DB.prepare(`UPDATE blog_posts SET status='draft', updated_by=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(userId, id).run();
      await deps.audit(env, userId, 'blog.post_unpublished', 'blog_post', id);
      return deps.reply({ id, status: 'draft' });
    }

    if (!action && req.method === 'DELETE') {
      await env.DB.prepare('DELETE FROM blog_posts WHERE id=?').bind(id).run();
      await deps.audit(env, userId, 'blog.post_deleted', 'blog_post', id);
      return deps.reply({ ok: true });
    }
  }
  return deps.reply({ error: 'not_found' }, 404);
}
