/**
 * Guias do Lote 4 no blog: Cancún, Amsterdã, Montevidéu, Dubai e Porto (content/guias/<guia>.json),
 * no mesmo molde dos guias do Lote 3 (tests/blog-guias-lote3.test.ts).
 * Lógica pura e arquivos: não sobe o Worker. As chaves /guia/<chave> são as palavras dos Reels (ManyRota): não podem mudar.
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
  id: string; slug: string; regionId: string; regionName?: string; regionOrder?: number; title: string; titleHighlight: string | null; summary: string; lede: string | null;
  destination: string; coverUrl: string; coverUrlSmall: string; coverAlt: string; body: Record<string, unknown>[];
};

const GUIAS = [
  { chave: 'cancun', slug: 'cancun-em-4-dias', destino: 'Cancún', regiao: 'caribe', migration: '0048_blog_guia_cancun.sql', paginas: 16, dias: 4, prefixo: 'cancun-4-dias' },
  { chave: 'amsterda', slug: 'amsterda-em-4-dias', destino: 'Amsterdã', regiao: 'europa', migration: '0049_blog_guia_amsterda.sql', paginas: 16, dias: 4, prefixo: 'amsterda-4-dias' },
  { chave: 'montevideu', slug: 'montevideu-em-3-dias', destino: 'Montevidéu', regiao: 'america-do-sul', migration: '0050_blog_guia_montevideu.sql', paginas: 16, dias: 3, prefixo: 'montevideu-3-dias' },
  { chave: 'dubai', slug: 'dubai-em-4-dias', destino: 'Dubai', regiao: 'oriente-medio', migration: '0051_blog_guia_dubai.sql', paginas: 16, dias: 4, prefixo: 'dubai-4-dias', regiaoNova: 'Oriente Médio' },
  { chave: 'porto', slug: 'porto-em-3-dias', destino: 'Porto', regiao: 'portugal', migration: '0052_blog_guia_porto.sql', paginas: 16, dias: 3, prefixo: 'porto-3-dias' },
] as const;

const arq = (u: string) => new URL(`../public${u}`, import.meta.url);

describe('atalhos /guia/<chave> do Lote 4 (o ManyRota e os Reels dependem destas chaves)', () => {
  it('as 5 chaves apontam para o slug certo e as chaves anteriores não mudaram', () => {
    expect(GUIAS_CURTOS.cancun).toBe('cancun-em-4-dias');
    expect(GUIAS_CURTOS.amsterda).toBe('amsterda-em-4-dias');
    expect(GUIAS_CURTOS.montevideu).toBe('montevideu-em-3-dias');
    expect(GUIAS_CURTOS.dubai).toBe('dubai-em-4-dias');
    expect(GUIAS_CURTOS.porto).toBe('porto-em-3-dias');
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

    it('campos do post dentro dos limites do editor, região e atalho', () => {
      expect(conteudo.slug).toBe(g.slug);
      expect(conteudo.regionId).toBe(g.regiao);
      if ('regiaoNova' in g) expect(conteudo.regionName).toBe(g.regiaoNova); else expect(conteudo).not.toHaveProperty('regionName');
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
      // a nota do botão cita o número de páginas do PDF publicado
      expect(String(conteudo.body[0]!.note)).toContain(`${g.paginas} páginas`);
    });

    it('PDF sem metadado pessoal (só Chromium como ferramenta) e sem "v0.1" no nome', () => {
      const bruto = readFileSync(arq(`/guias/${g.slug}.pdf`)).toString('latin1');
      expect(bruto).not.toMatch(/\/Author\s*\(/);
      expect(existsSync(arq(`/guias/${g.slug}-v0.1.pdf`))).toBe(false);
    });

    it('WhatsApp antes do primeiro dia e no fim, um passeio por dia (sem preço), contato no fim', () => {
      const iDia1 = conteudo.body.findIndex((b) => b.t === 'h' && b.label === 'Dia 1');
      expect(iDia1).toBeGreaterThan(0);
      expect(tipos.indexOf('whatsapp')).toBeLessThan(iDia1);
      expect(tipos.filter((t) => t === 'whatsapp')).toHaveLength(2);
      expect(tipos.filter((t) => t === 'passeio')).toHaveLength(g.dias);
      expect(tipos.filter((t) => t === 'carro')).toHaveLength(0);
      expect(tipos.indexOf('contato')).toBeGreaterThan(tipos.lastIndexOf('passeio'));
      expect(tipos.filter((t) => t === 'afiliado').length).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(conteudo.body.filter((b) => b.t === 'passeio'))).not.toMatch(/R\$|US\$|€|\d+,\d\d/);
    });

    it('os dias vêm em ordem, cada um com o quadro "Para planejar" e estimativa marcada como da Rota Certa', () => {
      const dias = conteudo.body.filter((b) => b.t === 'h' && /^Dia \d$/.test(String(b.label))).map((b) => b.label);
      expect(dias).toEqual(Array.from({ length: g.dias }, (_, i) => `Dia ${i + 1}`));
      for (let i = 1; i <= g.dias; i++) expect(texto).toContain(`Para planejar o Dia ${i}`);
      expect(texto).toMatch(/Estimativas? da Rota Certa/);
      expect(texto).toContain('Fontes oficiais, conferidas em 12/11/2026');
    });

    it('fotos: existem, pesam menos de 250 KB, têm alt, legenda e crédito Pexels; uma por dia; nenhuma antes do primeiro CTA', () => {
      for (const u of [conteudo.coverUrl, conteudo.coverUrlSmall]) { expect(existsSync(arq(u))).toBe(true); expect(statSync(arq(u)).size).toBeLessThan(250_000); }
      expect(conteudo.coverUrl).toBe(`/assets/blog/${g.prefixo}.jpg`);
      expect(conteudo.coverUrlSmall).toBe(`/assets/blog/${g.prefixo}-m.jpg`);
      expect(existsSync(arq(`/assets/blog/${g.prefixo}-p.webp`))).toBe(true);
      const fotos = conteudo.body.filter((b) => b.t === 'img') as Array<Record<string, unknown>>;
      expect(fotos).toHaveLength(g.dias);
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
      expect(texto).toMatch(/Foto de capa: .+ \/ Pexels\./);
    });

    it('sem travessão, sem promessa, sem "página" do PDF e com a seção do que o guia não informa', () => {
      expect(texto).not.toMatch(/—|–|--/);
      // frases do guia que negam uma promessa (ou citam a regra da livraria) são permitidas
      expect(texto.replace(/Não prometemos que[^"]*/g, '').replace(/não garante[^"]*/g, '').replace(/para garantir o acesso/g, '')).not.toMatch(/promet|garant/i);
      expect(texto).not.toMatch(/[Vv]oltar ao índice|(?:Leia|Veja|veja|leia) a página [A-Z]|\(página [A-Z]/);
      expect(texto).toContain('O que este guia não informa');
      expect(texto).toContain('recomendações nossas, não dados oficiais');
      expect(texto).not.toContain('____');
    });

    it('desenha em produção sem passeios nem aviso, e na prévia com os passeios inativos', () => {
      const producao = renderBlocks(body, ctx(g.destino, g.chave), true);
      expect(producao).not.toContain('aviso-afiliado');
      expect(producao).not.toContain('Inativo');
      expect(producao).toContain('cta-whatsapp');
      expect(producao).toContain('cta-contato');
      const previa = renderBlocks(body, ctx(g.destino, g.chave, { preview: true }), true);
      expect(previa.match(/cta-inativo/g)).toHaveLength(g.dias);
    });

    it(`migration ${g.migration}: só insere o rascunho e é a que o gerador produz a partir do conteúdo`, () => {
      const sql = readFileSync(join(ROOT, 'd1', 'migrations', g.migration), 'utf8');
      expect(sql).toContain(`'${g.slug}', 'draft', '${g.regiao}'`);
      expect(sql).not.toMatch(/\b(UPDATE|DELETE|DROP|ALTER)\b/);
      if ('regiaoNova' in g) expect(sql).toContain(`INSERT OR IGNORE INTO blog_regions (id, name, sort_order) VALUES ('${g.regiao}', '${g.regiaoNova}', 7)`);
      else expect(sql).not.toContain('blog_regions');
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

describe('valores em reais do Lote 4 seguem a cotação de venda do BCB de 11/11/2026 (a que o guia declara)', () => {
  const ler = (slug: string) => JSON.stringify(JSON.parse(readFileSync(new URL(`../content/guias/${slug}.json`, import.meta.url), 'utf8')));
  // "MXN 145 (cerca de R$ 43)", "€ 16,50 (R$ 102)", "$ 200 (R$ 27,44)"
  const confere = (texto: string, simbolo: string, taxa: number, tolerancia: number, minimo = 2) => {
    const pares = [...texto.matchAll(new RegExp(`${simbolo} ([\\d.]+(?:,\\d+)?) \\((?:cerca de )?R\\$ ([\\d.]+(?:,\\d+)?)\\)`, 'g'))];
    expect(pares.length).toBeGreaterThanOrEqual(minimo);
    for (const [, valor, reais] of pares) {
      const v = Number(String(valor).replace(/\./g, '').replace(',', '.'));
      const r = Number(String(reais).replace(/\./g, '').replace(',', '.'));
      expect(Math.abs(r - v * taxa), `${simbolo} ${valor} -> R$ ${reais}`).toBeLessThanOrEqual(tolerancia);
    }
  };
  it('Cancún: peso mexicano a R$ 0,2986', () => { confere(ler('cancun-em-4-dias'), 'MXN', 0.2986, 1); });
  it('Amsterdã: euro a R$ 6,1706', () => { confere(ler('amsterda-em-4-dias'), '€', 6.1706, 1); });
  it('Montevidéu: peso uruguaio a R$ 0,1372', () => { confere(ler('montevideu-em-3-dias'), '(?<!US)\\$', 0.1372, 0.05); });
  it('Porto: euro a R$ 6,1706', () => { confere(ler('porto-em-3-dias'), '€', 6.1706, 1); });
  it('Dubai: dirham a R$ 1,5141 (AED 10 valem cerca de R$ 15,14)', () => {
    const t = ler('dubai-em-4-dias');
    expect(t).toContain('AED 1 = R$ 1,5141');
    expect(t).toContain('AED 10 valem cerca de R$ 15,14');
  });
});
