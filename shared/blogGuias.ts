// Blocos dos guias do blog: tipos, validação e desenho dos botões de ação (PDF, passeios, WhatsApp, carro,
// contato, aviso de afiliado). Lógica pura, sem acesso ao D1, para poder ser testada sem subir o Worker
// (tests/blog-guias.test.ts) e reaproveitada por quem gerar páginas de guia a partir do guide.json.

/** Configuração de parceiros e contatos. Os valores ficam em worker/blog-parceiros.ts. */
export type BlogParceiros = {
  getyourguide: { partnerId: string; baseUrl: string };
  carro: { url: string };
  contato: { whatsapp: string; instagramDm: string; email: string };
};

export type Block =
  | { t: 'p'; text: string }
  | { t: 'h'; label?: string; text: string }
  | { t: 'ul'; items: string[] }
  | { t: 'tip'; title?: string; items: string[] }
  | { t: 'img'; src: string; small?: string; alt?: string; caption?: string; credit?: string; w?: number; h?: number }
  | { t: 'quote'; text: string }
  // Blocos de ação dos guias monetizados (ver renderCta). Texto vazio = texto padrão.
  | { t: 'pdf'; href: string; label?: string; note?: string }
  | { t: 'passeio'; busca: string; title?: string; text?: string; label?: string }
  | { t: 'whatsapp'; title?: string; text?: string; label?: string; message?: string }
  | { t: 'carro'; title?: string; text?: string; label?: string }
  | { t: 'contato'; title?: string; text?: string }
  | { t: 'afiliado' };

export const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export function text(value: unknown, max: number, min = 0): string | null {
  const v = typeof value === 'string' ? value.trim() : '';
  return v.length >= min && v.length <= max ? v : null;
}
export function optional(value: unknown, max: number): string | null | undefined {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return null;
  return text(value, max) ?? undefined; // undefined = inválido
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

const PDF_URL = /^\/guias\/[a-z0-9-]{1,80}\.pdf$/;

/** Valida os blocos de ação. Devolve null para qualquer outro tipo ou para campos inválidos. */
export function ctaBlock(b: Record<string, unknown>): Block | null {
  switch (b.t) {
    case 'pdf': {
      if (typeof b.href !== 'string' || !PDF_URL.test(b.href)) return null;
      const label = optional(b.label, 60); const note = optional(b.note, 160);
      return label !== undefined && note !== undefined ? { t: 'pdf', href: b.href, ...(label ? { label } : {}), ...(note ? { note } : {}) } : null;
    }
    case 'passeio': {
      const busca = text(b.busca, 80, 2); const title = optional(b.title, 100); const txt = optional(b.text, 300); const label = optional(b.label, 40);
      return busca && title !== undefined && txt !== undefined && label !== undefined
        ? { t: 'passeio', busca, ...(title ? { title } : {}), ...(txt ? { text: txt } : {}), ...(label ? { label } : {}) } : null;
    }
    case 'whatsapp': {
      const title = optional(b.title, 100); const txt = optional(b.text, 300); const label = optional(b.label, 40); const message = optional(b.message, 300);
      return title !== undefined && txt !== undefined && label !== undefined && message !== undefined
        ? { t: 'whatsapp', ...(title ? { title } : {}), ...(txt ? { text: txt } : {}), ...(label ? { label } : {}), ...(message ? { message } : {}) } : null;
    }
    case 'carro': {
      const title = optional(b.title, 100); const txt = optional(b.text, 300); const label = optional(b.label, 40);
      return title !== undefined && txt !== undefined && label !== undefined
        ? { t: 'carro', ...(title ? { title } : {}), ...(txt ? { text: txt } : {}), ...(label ? { label } : {}) } : null;
    }
    case 'contato': {
      const title = optional(b.title, 100); const txt = optional(b.text, 300);
      return title !== undefined && txt !== undefined ? { t: 'contato', ...(title ? { title } : {}), ...(txt ? { text: txt } : {}) } : null;
    }
    case 'afiliado': return { t: 'afiliado' };
    default: return null;
  }
}

// ---------- blocos de ação (CTAs) dos guias monetizados ----------
export type RenderCtx = {
  /** Pré-visualização do painel: mostra botões de parceiro sem link como "inativos". */
  preview: boolean;
  /** Ambiente local (localhost): mesmo comportamento da pré-visualização. */
  local: boolean;
  destino: string;
  /** Vai em utm_campaign. */
  campanha: string;
  parceiros: BlogParceiros;
};
export const AVISO_AFILIADO = 'Alguns links são de parceiros: podemos receber uma comissão, sem custo para você.';

export const isLocalHost = (host: string) => /^(localhost|127\.0\.0\.1|\[::1\])$/.test(host) || host.endsWith('.localhost');
const mostrarInativos = (ctx: RenderCtx) => ctx.preview || ctx.local;

function utm(ctx: RenderCtx, content: string): [string, string][] {
  return [['utm_source', 'rotacerta'], ['utm_medium', 'blog'], ['utm_campaign', ctx.campanha], ['utm_content', content]];
}
function comUtm(base: string, ctx: RenderCtx, content: string, extra: [string, string][] = []): string {
  const u = new URL(base);
  for (const [k, v] of [...extra, ...utm(ctx, content)]) u.searchParams.set(k, v);
  return u.toString();
}
const httpsUrl = (v: string) => { try { return new URL(v).protocol === 'https:'; } catch { return false; } };

/** Link final do botão de parceiro, ou null quando o parceiro ainda não foi configurado. */
function linkPasseio(ctx: RenderCtx, b: Extract<Block, { t: 'passeio' }>, content: string): string | null {
  const g = ctx.parceiros.getyourguide;
  if (!g.partnerId.trim() || !httpsUrl(g.baseUrl)) return null;
  return comUtm(`${g.baseUrl.replace(/\/$/, '')}/s/`, ctx, content, [['q', b.busca], ['partner_id', g.partnerId.trim()], ['cmp', `blog-${ctx.campanha}`]]);
}
function linkCarro(ctx: RenderCtx, content: string): string | null {
  const url = ctx.parceiros.carro.url.trim();
  return url && httpsUrl(url) ? comUtm(url, ctx, content) : null;
}
function mensagemWhats(ctx: RenderCtx, custom?: string) {
  if (custom) return custom;
  return ctx.destino
    ? `Oi, Rota Certa! Vi o guia de ${ctx.destino} e quero cotar uma passagem para ${ctx.destino}.`
    : 'Oi, Rota Certa! Vi um guia de viagem no site e quero cotar uma passagem.';
}
function linkWhats(ctx: RenderCtx, mensagem: string, content: string) {
  const qs = [`text=${encodeURIComponent(mensagem)}`, ...utm(ctx, content).map(([k, v]) => `${k}=${encodeURIComponent(v)}`)].join('&');
  return `https://wa.me/${ctx.parceiros.contato.whatsapp}?${qs}`;
}
const temParceiroAtivo = (body: Block[], ctx: RenderCtx) => body.some((b) =>
  (b.t === 'passeio' && linkPasseio(ctx, b, 'x')) || (b.t === 'carro' && linkCarro(ctx, 'x')));

const SETA = '<span aria-hidden="true">→</span>';
const ABRE_ABA = '<span class="sr-only"> (abre em nova aba)</span>';

function ctaCard(kind: string, id: string, titulo: string, texto: string, acao: string) {
  return `<div class="cta cta-${kind}" data-cta="${esc(id)}"><div class="cta-txt"><h3>${esc(titulo)}</h3><p>${esc(texto)}</p></div>${acao}</div>`;
}
function ctaInativo(kind: string, id: string, titulo: string, texto: string, label: string, motivo: string) {
  return `<div class="cta cta-${kind} cta-inativo" data-cta="${esc(id)}" data-estado="inativo"><p class="cta-badge" role="note">Inativo: ${esc(motivo)} Visitantes não veem este botão.</p><div class="cta-txt"><h3>${esc(titulo)}</h3><p>${esc(texto)}</p></div><span class="btn btn-gold btn-off" aria-disabled="true">${esc(label)} ${SETA}</span></div>`;
}
const linkExterno = (href: string, label: string, patrocinado: boolean, id: string) =>
  `<a class="btn btn-gold" href="${esc(href)}" target="_blank" rel="${patrocinado ? 'sponsored ' : ''}noopener" data-cta-link="${esc(id)}">${esc(label)} ${SETA}${ABRE_ABA}</a>`;

const ICONE_PDF = '<svg class="ic" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M5 20h14"/></svg>';

export function renderPdf(b: Extract<Block, { t: 'pdf' }>, ctx: RenderCtx, id: string, noTopo: boolean) {
  const href = `${b.href}?${utm(ctx, id).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
  const nota = b.note ?? 'Grátis, sem cadastro.';
  return `<div class="cta-pdf${noTopo ? ' cta-pdf-topo' : ''}" data-cta="${esc(id)}"><a class="btn btn-gold btn-pdf" href="${esc(href)}" download data-cta-link="${esc(id)}">${ICONE_PDF}<span>${esc(b.label || 'Baixar o guia (PDF)')}</span></a><p class="cta-pdf-note">${esc(nota)}</p></div>`;
}

function renderCta(b: Block, ctx: RenderCtx, n: number, temAtivo: boolean): string {
  const id = `${b.t}-${n}`;
  const destino = ctx.destino;
  switch (b.t) {
    case 'pdf': return renderPdf(b, ctx, id, false);
    case 'passeio': {
      const titulo = b.title || (destino ? `Passeios em ${destino}` : 'Passeios para este dia');
      const texto = b.text || 'Compare passeios e ingressos de parceiros para este dia.';
      const label = b.label || 'Ver passeios';
      const href = linkPasseio(ctx, b, id);
      if (href) return ctaCard('passeio', id, titulo, texto, linkExterno(href, label, true, id));
      return mostrarInativos(ctx) ? ctaInativo('passeio', id, titulo, texto, label, 'falta o ID de parceiro do GetYourGuide (worker/blog-parceiros.ts).') : '';
    }
    case 'carro': {
      const titulo = b.title || (destino ? `Vai alugar um carro em ${destino}?` : 'Vai alugar um carro?');
      const texto = b.text || 'Compare opções de aluguel de carro de parceiros.';
      const label = b.label || 'Ver carros';
      const href = linkCarro(ctx, id);
      if (href) return ctaCard('carro', id, titulo, texto, linkExterno(href, label, true, id));
      return mostrarInativos(ctx) ? ctaInativo('carro', id, titulo, texto, label, 'falta o link do parceiro de carro (worker/blog-parceiros.ts).') : '';
    }
    case 'whatsapp': {
      const titulo = b.title || (destino ? `Cotar passagem para ${destino}` : 'Cotar sua passagem');
      const texto = b.text || 'Conte de onde você sai e o mês da viagem. Nós respondemos o mais rápido possível.';
      const href = linkWhats(ctx, mensagemWhats(ctx, b.message), id);
      return ctaCard('whatsapp', id, titulo, texto, linkExterno(href, b.label || 'Cotar pelo WhatsApp', false, id));
    }
    case 'contato': {
      const titulo = b.title || 'Falar com a gente';
      const texto = b.text || 'Tem dúvida sobre o roteiro ou quer ajuda com a viagem? Mande uma mensagem.';
      const c = ctx.parceiros.contato;
      const acao = `<div class="cta-acoes">${linkExterno(comUtm(c.instagramDm, ctx, id), 'Chamar no Instagram', false, id)}<a class="cta-mail" href="mailto:${esc(c.email)}" data-cta-link="${esc(id)}-email">ou escreva para ${esc(c.email)}</a></div>`;
      return ctaCard('contato', id, titulo, texto, acao);
    }
    case 'afiliado':
      return temAtivo || mostrarInativos(ctx) ? `<p class="aviso-afiliado" role="note">${esc(AVISO_AFILIADO)}</p>` : '';
    default: return '';
  }
}
const ACOES = new Set(['pdf', 'passeio', 'carro', 'whatsapp', 'contato', 'afiliado']);

/** `hoisted`: o primeiro bloco é o botão do PDF e já foi desenhado no topo da página (conta como pdf-1). */
export function renderBlocks(body: Block[], ctx: RenderCtx, hoisted = false) {
  const contagem: Record<string, number> = {};
  const temAtivo = temParceiroAtivo(body, ctx);
  return body.map((b, i) => {
    if (ACOES.has(b.t)) {
      const n = (contagem[b.t] = (contagem[b.t] ?? 0) + 1);
      return hoisted && i === 0 ? '' : renderCta(b, ctx, n, temAtivo);
    }
    switch (b.t) {
      case 'p': return `<p>${inline(b.text)}</p>`;
      case 'h': return `<h2>${b.label ? `<span class="num">${esc(b.label)}</span>` : ''}${esc(b.text)}</h2>`;
      case 'ul': return `<ul>${b.items.map((i) => `<li>${inline(i)}</li>`).join('')}</ul>`;
      case 'tip': return `<div class="tip"><h3>${esc(b.title || 'Dicas práticas')}</h3><ul>${b.items.map((i) => `<li>${inline(i)}</li>`).join('')}</ul></div>`;
      case 'quote': return `<blockquote class="post-quote"><p>${inline(b.text)}</p></blockquote>`;
      case 'img': {
        const srcset = b.small ? ` srcset="${esc(b.small)} 900w, ${esc(b.src)} 1600w" sizes="(max-width: 820px) 100vw, 760px"` : '';
        const dims = b.w && b.h ? ` width="${b.w}" height="${b.h}"` : '';
        // Sem crédito, a legenda sai exatamente como antes (posts antigos não mudam). Com crédito, legenda e crédito em linhas próprias.
        const legenda = b.credit
          ? `<figcaption>${b.caption ? `<span class="foto-legenda">${esc(b.caption)}</span>` : ''}<span class="foto-credito">${esc(b.credit)}</span></figcaption>`
          : b.caption ? `<figcaption>${esc(b.caption)}</figcaption>` : '';
        return `<figure${b.credit ? ' class="foto-cred"' : ''}><img src="${esc(b.src)}"${srcset} alt="${esc(b.alt || '')}"${dims} loading="lazy" decoding="async">${legenda}</figure>`;
      }
      default: return '';
    }
  }).filter(Boolean).join('\n');
}

/** Primeiro bloco = botão do PDF: sobe para o topo da página (visível sem rolar). */
export function pdfDoTopo(body: Block[]): Extract<Block, { t: 'pdf' }> | null {
  const b = body[0];
  return b && b.t === 'pdf' ? b : null;
}

