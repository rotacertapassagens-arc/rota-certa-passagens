/**
 * Artigos da categoria "Dicas de viagem" (content/guias/*.json, migrations 0036 e 0037) e a opção
 * --publicado do gerador de migration. Lógica pura e arquivos: não sobe o Worker (o teste de ponta a
 * ponta com D1 local está em tests/blog-worker.smoke.test.ts). A validação dos blocos é a do editor
 * (worker/blog.ts), exercitada pelo próprio gerador, que recusa qualquer bloco inválido: o teste não
 * importa o Worker para não puxar o tipo global Env para o typecheck de tests/.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ctaBlock } from '../shared/blogGuias.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SLUGS = ['milhas-sem-misterio', 'promocao-e-real', 'erros-ao-comprar-passagem', 'modelo-de-roteiro', 'checklist-antes-de-viajar'];
type Artigo = {
  id: string; slug: string; regionId: string; title: string; titleHighlight: string | null; summary: string; lede: string | null;
  destination: string | null; coverUrl: string; coverUrlSmall: string; coverAlt: string; body: Array<Record<string, unknown>>;
};
const ler = (slug: string) => JSON.parse(readFileSync(join(ROOT, 'content', 'guias', `${slug}.json`), 'utf8')) as Artigo;
const publico = (u: string) => join(ROOT, 'public', u);
const artigos = SLUGS.map(ler);
const rodar = (...args: string[]) => execFileSync(process.execPath, ['--import', 'tsx', join(ROOT, 'tools', 'gerar-migration-guia.ts'), ...args], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const fotosDe = (a: Artigo) => a.body.filter((b) => b.t === 'img') as Array<Record<string, unknown>>;

describe.each(artigos)('artigo $slug', (a) => {
  it('usa a categoria nova, o slug do arquivo e os limites do editor', () => {
    expect(a.regionId).toBe('dicas-de-viagem');
    expect(a.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(a.title.length).toBeLessThanOrEqual(140);
    expect(a.summary.length).toBeGreaterThanOrEqual(10);
    expect(a.summary.length).toBeLessThanOrEqual(300);
    expect((a.lede ?? '').length).toBeLessThanOrEqual(300);
    expect(a.coverAlt.length).toBeGreaterThan(20);
    expect(a.coverAlt.length).toBeLessThanOrEqual(200);
    if (a.titleHighlight) expect(a.title).toContain(a.titleHighlight);
    expect(a.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('todos os blocos passam na mesma validação do editor (o gerador recusa bloco inválido)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gerador-'));
    try {
      expect(() => rodar(`content/guias/${a.slug}.json`, join(dir, 'x.sql'), '--publicado')).not.toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('começa pelo botão do PDF, que aponta para /guias/<slug>.pdf', () => {
    const primeiro = a.body[0]!;
    expect(primeiro.t).toBe('pdf');
    expect(primeiro.href).toBe(`/guias/${a.slug}.pdf`);
    expect(ctaBlock(primeiro)).not.toBeNull();
    expect(String(primeiro.note).length).toBeGreaterThan(10);
    // nenhum outro botão de PDF aponta para um guia diferente
    for (const b of a.body.filter((x) => x.t === 'pdf')) expect(b.href).toBe(`/guias/${a.slug}.pdf`);
  });

  it('não tem travessão (— ou –), "--" nem R$ em nenhum texto', () => {
    const texto = JSON.stringify(a);
    expect(texto).not.toMatch(/—|–|--/);
    expect(texto).not.toContain('R$');
  });

  it('mantém as etiquetas Recomendação, a seção Não verificado e as Fontes com links oficiais', () => {
    const texto = JSON.stringify(a.body);
    expect(texto).toContain('**Recomendação:**');
    const titulos = a.body.filter((b) => b.t === 'h').map((b) => b.text);
    expect(titulos).toContain('Não verificado');
    const fontes = a.body.find((b) => b.t === 'tip' && String(b.title).startsWith('Fontes')) as { items: string[] } | undefined;
    expect(fontes).toBeDefined();
    for (const item of fontes!.items) {
      const link = item.match(/\]\((https:\/\/[^)\s]+)\)/);
      expect(link, item).not.toBeNull();
      expect(new URL(link![1]!).hostname).toMatch(/(\.gov\.br|\.europa\.eu|\.rs\.gov\.br|\.mg\.gov\.br|^www\.smiles\.com\.br|^web\.latampass\.latam\.com|\.museoreinasofia\.es|^europa\.eu)$/);
    }
    // só o roteiro não cita a Resolução 400 (a única fonte dele é o Museu Reina Sofía)
    if (a.slug !== 'modelo-de-roteiro') expect(texto).toContain('**Versão da norma.**');
  });

  it('convida para o Direct (bloco contato) e para o WhatsApp, sem botão de parceiro', () => {
    const tipos = a.body.map((b) => b.t);
    expect(tipos).toContain('contato');
    expect(tipos.filter((t) => t === 'whatsapp')).toHaveLength(2);
    expect(tipos).not.toContain('passeio');
    expect(tipos).not.toContain('carro');
    expect(tipos).not.toContain('afiliado');
    // nenhuma foto entre o PDF do topo e o primeiro convite de WhatsApp
    expect(tipos.slice(0, tipos.indexOf('whatsapp')).includes('img')).toBe(false);
  });

  it('capa, miniatura e card (webp) existem e são leves', () => {
    const base = a.coverUrl.replace(/\.jpg$/, '');
    expect(a.coverUrlSmall).toBe(`${base}-m.jpg`);
    for (const u of [a.coverUrl, a.coverUrlSmall, `${base}-p.webp`]) {
      expect(existsSync(publico(u)), u).toBe(true);
      expect(statSync(publico(u)).size, u).toBeLessThan(250_000);
    }
  });

  it('tem de 4 a 6 fotos no texto, com alt, legenda e crédito do Pexels, leves e sem repetição', () => {
    const fotos = fotosDe(a);
    expect(fotos.length).toBeGreaterThanOrEqual(4);
    expect(fotos.length).toBeLessThanOrEqual(6);
    for (const f of fotos) {
      expect(String(f.src)).toMatch(/^\/assets\/blog\/[a-z0-9-]+\.jpg$/);
      expect(existsSync(publico(String(f.src))), String(f.src)).toBe(true);
      expect(statSync(publico(String(f.src))).size).toBeLessThan(250_000);
      expect(String(f.alt).length).toBeGreaterThan(20);
      expect(String(f.alt).length).toBeLessThanOrEqual(200);
      expect(String(f.caption).length).toBeGreaterThan(5);
      expect(f.credit).toMatch(/^Foto: .+ \/ Pexels$/);
      expect(f.w).toBe(1000);
      expect(f.h).toBe(667);
    }
    expect(new Set(fotos.map((f) => f.src)).size).toBe(fotos.length);
  });

  it('o crédito da foto de capa está no fim do texto', () => {
    expect(JSON.stringify(a.body)).toMatch(/Foto de capa: .+ \/ Pexels\./);
  });
});

describe('os 5 artigos juntos', () => {
  it('têm ids, slugs e fotos distintos (nenhuma foto repetida entre artigos)', () => {
    expect(new Set(artigos.map((a) => a.id)).size).toBe(5);
    expect(new Set(artigos.map((a) => a.slug)).size).toBe(5);
    const todas = artigos.flatMap((a) => [a.coverUrl, ...fotosDe(a).map((f) => String(f.src))]);
    expect(new Set(todas).size).toBe(todas.length);
  });
  it('só usam o texto de PDF que o PR dos mini guias entrega (nomes dos 5 arquivos)', () => {
    expect(artigos.map((a) => `/guias/${a.slug}.pdf`)).toEqual(SLUGS.map((s) => `/guias/${s}.pdf`));
  });
});

describe('migrations 0036 e 0037', () => {
  const m36 = readFileSync(join(ROOT, 'd1', 'migrations', '0036_blog_regiao_dicas_de_viagem.sql'), 'utf8');
  const m37 = readFileSync(join(ROOT, 'd1', 'migrations', '0037_blog_dicas_de_viagem.sql'), 'utf8');
  it('0036 cria a categoria só se ainda não existir e coloca no fim da lista', () => {
    expect(m36).toContain("INSERT OR IGNORE INTO blog_regions (id, name, sort_order)");
    expect(m36).toContain("'dicas-de-viagem', 'Dicas de viagem'");
    expect(m36).toContain('MAX(sort_order)');
    expect(m36).not.toMatch(/DELETE|DROP|UPDATE/i);
  });
  it('0037 cria os 5 artigos já publicados, com published_at, e não mexe em outros posts', () => {
    expect(m37.match(/^INSERT INTO blog_posts/gm)).toHaveLength(5);
    expect(m37.match(/'published'/g)).toHaveLength(5);
    expect(m37).not.toContain("'draft'");
    expect(m37.match(/datetime\('now', '-\d+ minutes'\)/g)).toHaveLength(5);
    expect(m37).not.toMatch(/\b(UPDATE|DELETE|DROP|ALTER)\b/);
    for (const a of artigos) {
      expect(m37).toContain(`'${a.id}', '${a.slug}', 'published', 'dicas-de-viagem'`);
      expect(m37).toContain(a.coverUrl);
    }
  });
  it('a 0037 é exatamente o que o gerador produz hoje a partir dos JSONs (migration em dia com o conteúdo)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gerador-'));
    try {
      const saida = join(dir, '0037.sql');
      rodar(...SLUGS.map((s) => `content/guias/${s}.json`), saida, '--publicado');
      expect(readFileSync(saida, 'utf8')).toBe(m37);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('gerador de migration (--publicado)', () => {
  it('sem a opção continua gerando rascunho, sem published_at', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gerador-'));
    try {
      const saida = join(dir, 'rascunho.sql');
      rodar(join(ROOT, 'content', 'guias', 'modelo-de-roteiro.json'), saida);
      const sql = readFileSync(saida, 'utf8');
      expect(sql).toContain("'draft'");
      expect(sql).not.toContain("'published'");
      expect(sql).not.toContain('published_at');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('com --publicado gera status published e published_at escalonado; o primeiro arquivo é o mais recente', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gerador-'));
    try {
      const saida = join(dir, 'publicado.sql');
      rodar(join(ROOT, 'content', 'guias', 'modelo-de-roteiro.json'), join(ROOT, 'content', 'guias', 'checklist-antes-de-viajar.json'), saida, '--publicado');
      const sql = readFileSync(saida, 'utf8');
      expect(sql.match(/'published'/g)).toHaveLength(2);
      expect(sql).not.toContain("'draft'");
      expect(sql).toContain("datetime('now', '-0 minutes')");
      expect(sql).toContain("datetime('now', '-1 minutes')");
      expect(sql.indexOf('modelo-de-roteiro')).toBeLessThan(sql.indexOf("datetime('now', '-1 minutes')"));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('recusa conteúdo inválido (bloco de PDF fora de /guias/)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gerador-'));
    try {
      const ruim = join(dir, 'ruim.json');
      const a = ler('modelo-de-roteiro');
      a.body[0] = { t: 'pdf', href: 'https://evil.example/x.pdf' };
      writeFileSync(ruim, JSON.stringify(a), 'utf8');
      expect(() => rodar(ruim, join(dir, 'x.sql'), '--publicado')).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
