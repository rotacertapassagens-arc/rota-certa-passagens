/**
 * Guias do Lote 3 no blog: Cartagena, Praga, Miami, Atacama e Barcelona (content/guias/<guia>.json),
 * no mesmo molde dos guias de destino (tests/blog-guia-escala-istambul.test.ts, tests/blog-guias.test.ts).
 * Lógica pura e arquivos: não sobe o Worker. As chaves /guia/<chave> são usadas pelo ManyRota e pelos Reels: não podem mudar.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GUIAS_CURTOS } from '../worker/blog-parceiros.js';
import { ctaBlock, renderBlocks, type Block, type BlogParceiros, type RenderCtx } from '../shared/blogGuias.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VAZIO: BlogParceiros = {
  getyourguide: { partnerId: '', baseUrl: 'https://www.getyourguide.com.br' },
  carro: { url: '' },
  contato: { whatsapp: '351925307391', instagramDm: 'https://ig.me/m/rotacerta.passagens', email: 'contato@rotacertapassagens.com' },
};
const ctx = (destino: string, campanha: string, over: Partial<RenderCtx> = {}): RenderCtx => ({ preview: false, local: false, destino, campanha, parceiros: VAZIO, ...over });

type Conteudo = {
  id: string; slug: string; regionId: string; title: string; titleHighlight: string | null; summary: string; lede: string | null;
  destination: string; coverUrl: string; coverUrlSmall: string; coverAlt: string; body: Record<string, unknown>[];
};

const GUIAS = [
  { chave: 'cartagena', slug: 'cartagena-em-4-dias', destino: 'Cartagena', regiao: 'america-do-sul', migration: '0043_blog_guia_cartagena.sql', paginas: 16, fotos: 5, prefixo: 'cartagena', carros: 0 },
  { chave: 'praga', slug: 'praga-em-4-dias', destino: 'Praga', regiao: 'europa', migration: '0044_blog_guia_praga.sql', paginas: 16, fotos: 6, prefixo: 'praga', carros: 0 },
  { chave: 'miami', slug: 'miami-em-4-dias', destino: 'Miami', regiao: 'americas', migration: '0045_blog_guia_miami.sql', paginas: 16, fotos: 6, prefixo: 'miami', carros: 1 },
  { chave: 'atacama', slug: 'atacama-em-4-dias', destino: 'San Pedro de Atacama', regiao: 'america-do-sul', migration: '0046_blog_guia_atacama.sql', paginas: 17, fotos: 5, prefixo: 'atacama', carros: 0 },
  { chave: 'barcelona', slug: 'barcelona-em-4-dias', destino: 'Barcelona', regiao: 'europa', migration: '0047_blog_guia_barcelona.sql', paginas: 16, fotos: 6, prefixo: 'barcelona', carros: 0 },
] as const;

const arq = (u: string) => new URL(`../public${u}`, import.meta.url);

describe('atalhos /guia/<chave> do Lote 3 (o ManyRota e os Reels dependem destas chaves)', () => {
  it('as 5 chaves apontam para o slug certo e as chaves anteriores não mudaram', () => {
    expect(GUIAS_CURTOS.cartagena).toBe('cartagena-em-4-dias');
    expect(GUIAS_CURTOS.praga).toBe('praga-em-4-dias');
    expect(GUIAS_CURTOS.miami).toBe('miami-em-4-dias');
    expect(GUIAS_CURTOS.atacama).toBe('atacama-em-4-dias');
    expect(GUIAS_CURTOS.barcelona).toBe('barcelona-em-4-dias');
    expect(GUIAS_CURTOS.escala).toBe('escala-em-istambul');
    expect(GUIAS_CURTOS.madri).toBe('madri-em-4-dias');
    expect(GUIAS_CURTOS.roma).toBe('roma-em-3-dias');
    expect(new Set(Object.values(GUIAS_CURTOS)).size).toBe(Object.values(GUIAS_CURTOS).length);
  });
});

for (const g of GUIAS) {
  describe(`guia ${g.destino} (content/guias/${g.slug}.json)`, () => {
    const conteudo = JSON.parse(readFileSync(new URL(`../content/guias/${g.slug}.json`, import.meta.url), 'utf8')) as Conteudo;
    const body = conteudo.body.map((b) => ctaBlock(b) ?? (b as unknown as Block));
    const tipos = conteudo.body.map((b) => b.t);
    const texto = JSON.stringify(conteudo);

    it('campos do post dentro dos limites do editor, região existente e atalho', () => {
      expect(conteudo.slug).toBe(g.slug);
      expect(conteudo.regionId).toBe(g.regiao);
      expect(conteudo).not.toHaveProperty('regionName'); // nenhuma região nova
      expect(conteudo.destination).toBe(g.destino);
      expect(conteudo.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(conteudo.title.length).toBeLessThanOrEqual(140);
      expect(conteudo.summary.length).toBeGreaterThanOrEqual(10);
      expect(conteudo.summary.length).toBeLessThanOrEqual(300);
      expect((conteudo.lede ?? '').length).toBeLessThanOrEqual(300);
      expect(conteudo.coverAlt.length).toBeGreaterThan(20);
      expect(conteudo.coverAlt.length).toBeLessThanOrEqual(200);
      expect(conteudo.title).toContain(String(conteudo.titleHighlight));
      expect(GUIAS_CURTOS[g.chave]).toBe(conteudo.slug);
    });

    it('começa pelo botão do PDF, que existe, é o do guia e tem o número de páginas esperado', () => {
      expect(conteudo.body.filter((b) => ['pdf', 'passeio', 'whatsapp', 'carro', 'contato', 'afiliado'].includes(String(b.t))).every((b) => ctaBlock(b) !== null)).toBe(true);
      expect(tipos[0]).toBe('pdf');
      expect(conteudo.body[0]!.href).toBe(`/guias/${g.slug}.pdf`);
      expect(conteudo.body.filter((b) => b.t === 'pdf').every((b) => b.href === `/guias/${g.slug}.pdf`)).toBe(true);
      expect(tipos.filter((t) => t === 'pdf')).toHaveLength(2);
      const pdf = readFileSync(arq(`/guias/${g.slug}.pdf`));
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
      expect(pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g)).toHaveLength(g.paginas);
    });

    it('WhatsApp antes do primeiro dia e no fim, 4 passeios (sem preço), contato no fim', () => {
      const iDia1 = conteudo.body.findIndex((b) => b.t === 'h' && b.label === 'Dia 1');
      expect(iDia1).toBeGreaterThan(0);
      expect(tipos.indexOf('whatsapp')).toBeLessThan(iDia1);
      expect(tipos.filter((t) => t === 'whatsapp')).toHaveLength(2);
      expect(tipos.filter((t) => t === 'passeio')).toHaveLength(4);
      expect(tipos.filter((t) => t === 'carro')).toHaveLength(g.carros);
      expect(tipos.indexOf('contato')).toBeGreaterThan(tipos.lastIndexOf('passeio'));
      expect(tipos.filter((t) => t === 'afiliado').length).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(conteudo.body.filter((b) => b.t === 'passeio'))).not.toMatch(/R\$|US\$|€|\d+,\d\d/);
    });

    it('os quatro dias vêm em ordem, cada um com estimativa marcada como da Rota Certa', () => {
      const dias = conteudo.body.filter((b) => b.t === 'h' && /^Dia \d$/.test(String(b.label))).map((b) => b.label);
      expect(dias).toEqual(['Dia 1', 'Dia 2', 'Dia 3', 'Dia 4']);
      expect(texto).toContain('Estimativa da Rota Certa, não é dado oficial');
      expect(texto).toContain('Fontes ');
      expect(texto).toContain('conferidas em 27/10/2026');
    });

    it('fotos: existem, pesam menos de 250 KB, têm alt, legenda e crédito Pexels; nenhuma antes do primeiro CTA; no máximo 2 por seção', () => {
      for (const u of [conteudo.coverUrl, conteudo.coverUrlSmall]) { expect(existsSync(arq(u))).toBe(true); expect(statSync(arq(u)).size).toBeLessThan(250_000); }
      expect(conteudo.coverUrl).toBe(`/assets/blog/${g.prefixo}-4-dias.jpg`);
      expect(conteudo.coverUrlSmall).toBe(`/assets/blog/${g.prefixo}-4-dias-m.jpg`);
      expect(existsSync(arq(`/assets/blog/${g.prefixo}-4-dias-p.webp`))).toBe(true);
      const fotos = conteudo.body.filter((b) => b.t === 'img') as Array<Record<string, unknown>>;
      expect(fotos).toHaveLength(g.fotos);
      for (const f of fotos) {
        expect(existsSync(arq(String(f.src)))).toBe(true);
        expect(statSync(arq(String(f.src))).size).toBeLessThan(250_000);
        expect(String(f.alt).length).toBeGreaterThan(20);
        expect(String(f.caption).length).toBeGreaterThan(5);
        expect(String(f.credit)).toMatch(/^Foto: .+ \/ Pexels$/);
        expect(f.w).toBeTypeOf('number'); expect(f.h).toBeTypeOf('number');
      }
      expect(new Set(fotos.map((f) => f.src)).size).toBe(fotos.length);
      expect(tipos.slice(0, tipos.indexOf('whatsapp')).includes('img')).toBe(false);
      let seguidas = 0;
      for (const t of tipos) { if (t === 'h') seguidas = 0; if (t === 'img' && ++seguidas > 2) throw new Error('mais de 2 fotos numa seção'); }
      expect(texto).toMatch(/Foto de capa: .+ \/ Pexels\./);
    });

    it('sem travessão, sem promessa, com a seção do que o guia não informa e o aviso de que estimativas são da Rota Certa', () => {
      expect(texto).not.toMatch(/—|--/);
      expect(texto).not.toMatch(/promet|garant/i);
      expect(texto).toContain('O que este guia não informa');
      expect(texto).toContain('recomendações nossas, não dados oficiais');
    });

    it('desenha em produção sem passeios nem aviso, e na prévia com os passeios inativos', () => {
      const campanha = g.chave;
      const producao = renderBlocks(body, ctx(g.destino, campanha), true);
      expect(producao).not.toContain('aviso-afiliado');
      expect(producao).not.toContain('Inativo');
      expect(producao).toContain('cta-whatsapp');
      expect(producao).toContain('cta-contato');
      const previa = renderBlocks(body, ctx(g.destino, campanha, { preview: true }), true);
      expect(previa.match(/cta-inativo/g)).toHaveLength(4 + g.carros);
    });

    it(`migration ${g.migration}: só insere o rascunho e é a que o gerador produz a partir do conteúdo`, () => {
      const sql = readFileSync(join(ROOT, 'd1', 'migrations', g.migration), 'utf8');
      expect(sql).toContain(`'${g.slug}', 'draft', '${g.regiao}'`);
      expect(sql).not.toMatch(/\b(UPDATE|DELETE|DROP|ALTER)\b/);
      expect(sql).not.toContain('blog_regions');
      expect(sql.match(/INSERT INTO blog_posts/g)).toHaveLength(1);
      expect(sql).not.toMatch(/—|--(?! )/);
      const dir = mkdtempSync(join(tmpdir(), `gerador-${g.chave}-`));
      try {
        const saida = join(dir, 'x.sql');
        execFileSync(process.execPath, ['--import', 'tsx', join(ROOT, 'tools', 'gerar-migration-guia.ts'), `content/guias/${g.slug}.json`, saida], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        const gerado = readFileSync(saida, 'utf8').replace(/a partir de [^\n]*\./, '');
        expect(gerado).toBe(sql.replace(/a partir de [^\n]*\./, ''));
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  });
}

describe('valores em reais do Lote 3 seguem a cotação conferida de 26/10/2026', () => {
  const ler = (slug: string) => JSON.stringify(JSON.parse(readFileSync(new URL(`../content/guias/${slug}.json`, import.meta.url), 'utf8')));
  const confere = (texto: string, moeda: string, taxa: number, tolerancia: number) => {
    // "COP 25.000 (cerca de R$ 43)" ou "350 CZK (cerca de R$ 88)"
    const antes = [...texto.matchAll(new RegExp(`${moeda} ([\\d.]+(?:,\\d+)?) \\(cerca de R\\$ ([\\d.]+)\\)`, 'g'))];
    const depois = [...texto.matchAll(new RegExp(`([\\d.]+(?:,\\d+)?) ${moeda} \\(cerca de R\\$ ([\\d.]+)\\)`, 'g'))];
    const pares = [...antes, ...depois];
    expect(pares.length).toBeGreaterThanOrEqual(2);
    for (const [, valor, reais] of pares) {
      const v = Number(String(valor).replace(/\./g, '').replace(',', '.'));
      const r = Number(String(reais).replace(/\./g, ''));
      expect(Math.abs(r - v * taxa), `${moeda} ${valor} -> R$ ${reais}`).toBeLessThanOrEqual(tolerancia);
    }
  };
  it('Praga: coroa a R$ 0,2526 e euro a R$ 6,1487', () => { confere(ler('praga-em-4-dias'), 'CZK', 0.2526, 1); });
  it('Miami: dólar a R$ 5,50', () => { confere(ler('miami-em-4-dias'), 'US\\$', 5.5, 1); });
  it('Atacama: peso chileno a R$ 0,00554', () => { confere(ler('atacama-em-4-dias'), 'CLP', 0.00554, 1); });
  it('Barcelona: euro a R$ 6,15', () => { confere(ler('barcelona-em-4-dias'), '€', 6.15, 1.5); });
  it('Cartagena: peso colombiano a R$ 0,001733', () => { confere(ler('cartagena-em-4-dias'), 'COP', 0.001733, 1); });
});
