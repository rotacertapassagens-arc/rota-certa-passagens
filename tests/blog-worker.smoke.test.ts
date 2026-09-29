/**
 * Guias de viagem (blog) editáveis no painel: Worker real + D1 local isolado, no mesmo molde de
 * tests/worker-d1.smoke.test.ts (wrangler unstable_dev, migrations aplicadas do zero num diretório
 * temporário, nenhum acesso à Cloudflare de verdade).
 *
 * Cobre: páginas públicas montadas do D1 (índice, post, 404, sitemap), bloqueio do editor para quem
 * não é master, criação de região, upload de foto (e recusa de arquivo que não é imagem), rascunho
 * invisível ao público, pré-visualização só para master, publicação com capa obrigatória, texto
 * escapado (nada de HTML/JS vindo do editor), destaque único, tirar do ar e excluir.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unstable_dev, type Unstable_DevWorker } from 'wrangler';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const WRANGLER_BIN = join(REPO_ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const VARS = {
  TOKEN_PEPPER: 'blog-smoke-token-pepper-at-least-32-characters',
  RATE_LIMIT_SECRET: 'blog-smoke-rate-limit-secret-32-characters-long',
  RESEND_API_KEY: 'unused-in-capture-mode',
  MASTER_BOOTSTRAP_TOKEN: 'blog-smoke-bootstrap-token-long-enough-0000',
  EMAIL_MODE: 'capture',
};
const ORIGIN = 'https://rotacertapassagens.com';

function runWrangler(args: string[]) {
  try {
    return execFileSync(process.execPath, [WRANGLER_BIN, ...args], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    throw new Error(`wrangler ${args.join(' ')} failed.\nstdout: ${(error as { stdout?: string }).stdout ?? ''}\nstderr: ${(error as { stderr?: string }).stderr ?? ''}`);
  }
}
function d1Query<T = Record<string, unknown>>(persistTo: string, sql: string): T[] {
  const output = runWrangler(['d1', 'execute', 'DB', '--local', '--persist-to', persistTo, '--config', 'wrangler.jsonc', '--json', '--command', sql]);
  return (JSON.parse(output) as Array<{ results: T[] }>)[0]?.results ?? [];
}
/** Mesmo truque do smoke test principal: grava um código conhecido no convite master (o hash é de mão única). */
async function knownInviteCode(persistTo: string, email: string, code: string) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(VARS.TOKEN_PEPPER), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const hash = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(code)))].map((b) => b.toString(16).padStart(2, '0')).join('');
  runWrangler(['d1', 'execute', 'DB', '--local', '--persist-to', persistTo, '--config', 'wrangler.jsonc', '--json', '--command',
    `UPDATE account_tokens SET token_hash='${hash}' WHERE id=(SELECT t.id FROM account_tokens t JOIN users u ON u.id=t.user_id WHERE u.email='${email}' AND t.purpose='master_invite' AND t.used_at IS NULL ORDER BY t.created_at DESC LIMIT 1)`]);
  return code;
}

/** Monta um corpo multipart na mão: o fetch do unstable_dev não serializa o FormData nativo do Node. */
function multipart(fields: Record<string, string | { filename: string; type: string; bytes: Uint8Array }>) {
  const boundary = `----rotacerta${Math.random().toString(16).slice(2)}`;
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const CRLF = '\r\n';
  for (const [name, value] of Object.entries(fields)) {
    if (typeof value === 'string') {
      chunks.push(enc.encode(`--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}${value}${CRLF}`));
      continue;
    }
    chunks.push(
      enc.encode(`--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"; filename="${value.filename}"${CRLF}Content-Type: ${value.type}${CRLF}${CRLF}`),
      value.bytes,
      enc.encode(CRLF),
    );
  }
  chunks.push(enc.encode(`--${boundary}--${CRLF}`));
  const body = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) { body.set(c, offset); offset += c.length; }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

interface FetchResponseLike { headers: { getSetCookie?: () => string[] } }
class CookieJar {
  private cookies = new Map<string, string>();
  absorb(response: FetchResponseLike) {
    const lines = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    for (const line of lines) {
      const [pair] = line.split(';');
      const [name, ...rest] = pair!.split('=');
      if (name) this.cookies.set(name.trim(), rest.join('='));
    }
  }
  cookieHeader() { return [...this.cookies.entries()].map(([n, v]) => `${n}=${v}`).join('; '); }
  csrf() { return this.cookies.get('rc_csrf') ?? ''; }
  json() { return { 'content-type': 'application/json', cookie: this.cookieHeader(), 'x-csrf-token': this.csrf(), origin: ORIGIN }; }
  bare() { return { cookie: this.cookieHeader(), 'x-csrf-token': this.csrf(), origin: ORIGIN }; }
}

describe('Guias de viagem (blog) no painel: Worker + D1 local', () => {
  let persistTo: string;
  let worker: Unstable_DevWorker;

  beforeAll(async () => {
    persistTo = mkdtempSync(join(tmpdir(), 'rota-certa-blog-smoke-'));
    runWrangler(['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persistTo, '--config', 'wrangler.jsonc']);
    worker = await unstable_dev('worker/index.ts', { config: 'wrangler.jsonc', local: true, persistTo, vars: VARS, logLevel: 'error', experimental: { disableExperimentalWarning: true } });
  }, 60_000);

  afterAll(async () => {
    if (worker) await worker.stop();
    if (persistTo) rmSync(persistTo, { recursive: true, force: true });
  });

  it('publica, protege e edita os guias de ponta a ponta', async () => {
    // --- páginas públicas montadas a partir da carga inicial ---------------------------------
    const indice = await worker.fetch('/blog/');
    expect(indice.status).toBe(200);
    expect(indice.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(indice.headers.get('x-frame-options')).toBe('DENY');
    const indiceHtml = await indice.text();
    for (const titulo of ['Roma em 4 dias', 'Paris na primeira viagem', 'Istambul entre dois continentes', 'Albânia', 'Lisboa em 3 dias', 'Voltar ao Brasil nas férias']) expect(indiceHtml).toContain(titulo);
    expect(indiceHtml).toContain('data-regiao="europa"');
    expect(indiceHtml).toContain('pc-featured');
    expect((await worker.fetch('/blog', { redirect: 'manual' })).status).toBe(301);

    const roma = await worker.fetch('/blog/roma-em-4-dias');
    expect(roma.status).toBe(200);
    const romaHtml = await roma.text();
    expect(romaHtml).toContain('<span class="num">Dia 1</span>Roma Antiga');
    expect(romaHtml).toContain('<strong>Coliseu</strong>');
    expect(romaHtml).toContain('href="/proposta-voo?destino=Roma"');
    expect(romaHtml).toContain('<link rel="canonical" href="https://rotacertapassagens.com/blog/roma-em-4-dias">');
    expect(romaHtml).toContain('"@type":"BlogPosting"');
    expect(romaHtml).toContain('Outros <em>guias</em>');
    expect((await worker.fetch('/blog/voltar-ao-brasil-nas-ferias').then((r) => r.text()))).toContain('Vai voltar ao Brasil?');

    const inexistente = await worker.fetch('/blog/nao-existe');
    expect(inexistente.status).toBe(404);
    expect(await inexistente.text()).toContain('Não encontramos este');

    const sitemap = await worker.fetch('/sitemap.xml');
    expect(sitemap.status).toBe(200);
    const sitemapXml = await sitemap.text();
    expect(sitemapXml).toContain('https://rotacertapassagens.com/blog/roma-em-4-dias');
    expect(sitemapXml).toContain('https://rotacertapassagens.com/proposta-voo');

    // --- o editor é só para master --------------------------------------------------------
    expect((await worker.fetch('/api/admin/blog')).status).toBe(401);
    expect((await worker.fetch('/api/admin/blog/posts', { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: '{}' })).status).toBe(401);

    const email = 'blog-master@example.com';
    const convite = await worker.fetch('/api/admin/bootstrap/master-invites', {
      method: 'POST', headers: { authorization: `Bearer ${VARS.MASTER_BOOTSTRAP_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ email, name: 'Master Blog' }),
    });
    expect(convite.status).toBe(201);
    const code = await knownInviteCode(persistTo, email, '313131');
    const senha = 'SenhaMasterBlog123';
    expect((await worker.fetch('/api/admin/master-invites/accept', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, code, password: senha }) })).status).toBe(200);
    const login = await worker.fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: senha }) });
    expect(login.status).toBe(200);
    const jar = new CookieJar();
    jar.absorb(login);

    const lista = await worker.fetch('/api/admin/blog', { headers: { cookie: jar.cookieHeader() } });
    expect(lista.status).toBe(200);
    const listaJson = await lista.json() as { posts: unknown[]; regions: Array<{ id: string }> };
    expect(listaJson.posts).toHaveLength(6);
    expect(listaJson.regions.map((r) => r.id)).toEqual(['brasil', 'portugal', 'europa']);

    // sem o token CSRF a alteração é recusada
    const semCsrf = await worker.fetch('/api/admin/blog/regions', { method: 'POST', headers: { 'content-type': 'application/json', cookie: jar.cookieHeader(), origin: ORIGIN }, body: JSON.stringify({ name: 'Ásia' }) });
    expect(semCsrf.status).toBe(401);

    const regiao = await worker.fetch('/api/admin/blog/regions', { method: 'POST', headers: jar.json(), body: JSON.stringify({ name: 'Ásia' }) });
    expect(regiao.status).toBe(201);
    expect((await regiao.json() as { region: { id: string } }).region.id).toBe('asia');

    // --- fotos -------------------------------------------------------------------------------
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(300).fill(7)]);
    const form = multipart({ g: { filename: 'g.jpg', type: 'image/jpeg', bytes: jpeg }, m: { filename: 'm.jpg', type: 'image/jpeg', bytes: jpeg.slice(0, 120) }, w: '1600', h: '1000', wm: '900', hm: '563' });
    const upload = await worker.fetch('/api/admin/blog/media', { method: 'POST', headers: { ...jar.bare(), 'content-type': form.contentType }, body: form.body });
    expect(upload.status, await upload.clone().text()).toBe(201);
    const foto = await upload.json() as { id: string; src: string; small: string };
    expect(foto.src).toBe(`/media/blog/${foto.id}/g`);
    const servida = await worker.fetch(foto.src);
    expect(servida.status).toBe(200);
    expect(servida.headers.get('content-type')).toBe('image/jpeg');
    expect(servida.headers.get('cache-control')).toContain('immutable');
    expect(new Uint8Array(await servida.arrayBuffer())).toEqual(jpeg);

    const svg = new TextEncoder().encode('<svg onload=alert(1)>');
    const falsa = multipart({ g: { filename: 'g.jpg', type: 'image/jpeg', bytes: svg }, m: { filename: 'm.jpg', type: 'image/jpeg', bytes: svg }, w: '10', h: '10', wm: '10', hm: '10' });
    expect((await worker.fetch('/api/admin/blog/media', { method: 'POST', headers: { ...jar.bare(), 'content-type': falsa.contentType }, body: falsa.body })).status).toBe(415);

    // --- rascunho, pré-visualização e publicação ----------------------------------------------
    const novo = {
      title: 'Tóquio <script>alert(1)</script> em 5 dias', titleHighlight: 'em 5 dias', summary: 'Um roteiro de teste para Tóquio.', regionId: 'asia', destination: 'Tóquio',
      featured: true,
      body: [
        { t: 'p', text: 'Texto com **negrito**, [link bom](https://example.com) e [link ruim](javascript:alert(1)).' },
        { t: 'h', label: 'Dia 1', text: 'Shibuya' },
        { t: 'img', src: foto.src, small: foto.small, alt: 'Cruzamento de Shibuya', caption: 'Legenda <b>sem HTML</b>', w: 1600, h: 1000 },
        { t: 'tip', title: 'Dicas práticas', items: ['Compre o cartão de transporte.'] },
      ],
    };
    const criado = await worker.fetch('/api/admin/blog/posts', { method: 'POST', headers: jar.json(), body: JSON.stringify(novo) });
    expect(criado.status, await criado.clone().text()).toBe(201);
    const { id, slug } = await criado.json() as { id: string; slug: string };
    expect(slug).toBe('toquio-script-alert-1-script-em-5-dias');
    expect((await worker.fetch(`/blog/${slug}`)).status).toBe(404); // rascunho não aparece
    expect((await worker.fetch(`/blog/preview/${id}`)).status).toBe(404); // pré-visualização só para master
    const previa = await worker.fetch(`/blog/preview/${id}`, { headers: { cookie: jar.cookieHeader() } });
    expect(previa.status).toBe(200);
    expect(previa.headers.get('x-robots-tag')).toContain('noindex');
    expect(await previa.text()).toContain('ainda não está publicado');

    const semCapa = await worker.fetch(`/api/admin/blog/posts/${id}/publish`, { method: 'POST', headers: jar.json() });
    expect(semCapa.status).toBe(422);
    expect((await semCapa.json() as { missing: string[] }).missing).toContain('coverUrl');

    const comCapa = await worker.fetch(`/api/admin/blog/posts/${id}`, { method: 'PUT', headers: jar.json(), body: JSON.stringify({ ...novo, coverUrl: foto.src, coverUrlSmall: foto.small, coverAlt: 'Tóquio à noite' }) });
    expect(comCapa.status, await comCapa.clone().text()).toBe(200);
    expect((await worker.fetch(`/api/admin/blog/posts/${id}/publish`, { method: 'POST', headers: jar.json() })).status).toBe(200);

    const publicado = await worker.fetch(`/blog/${slug}`);
    expect(publicado.status).toBe(200);
    const html = await publicado.text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('<strong>negrito</strong>');
    expect(html).toContain('<a href="https://example.com" target="_blank" rel="noopener">link bom</a>');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('Legenda &lt;b&gt;sem HTML&lt;/b&gt;');
    expect(html).toContain(`srcset="${foto.small} 900w, ${foto.src} 1600w"`);
    expect(html).toContain('href="/proposta-voo?destino=T%C3%B3quio"');

    const indiceNovo = await worker.fetch('/blog/').then((r) => r.text());
    expect(indiceNovo).toContain('data-regiao="asia"');
    const destaques = d1Query<{ n: number }>(persistTo, 'SELECT COUNT(*) AS n FROM blog_posts WHERE featured=1');
    expect(destaques[0]?.n).toBe(1); // o destaque novo tirou o antigo
    expect(await worker.fetch('/sitemap.xml').then((r) => r.text())).toContain(`/blog/${slug}`);

    // --- tirar do ar e excluir ------------------------------------------------------------------
    expect((await worker.fetch(`/api/admin/blog/posts/${id}/unpublish`, { method: 'POST', headers: jar.json() })).status).toBe(200);
    expect((await worker.fetch(`/blog/${slug}`)).status).toBe(404);
    expect((await worker.fetch(`/api/admin/blog/posts/${id}`, { method: 'DELETE', headers: jar.json() })).status).toBe(200);
    const depois = await worker.fetch('/api/admin/blog', { headers: { cookie: jar.cookieHeader() } }).then((r) => r.json()) as { posts: unknown[] };
    expect(depois.posts).toHaveLength(6);
  }, 120_000);
});
