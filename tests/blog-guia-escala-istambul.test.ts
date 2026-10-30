/**
 * Guia "Escala em Istambul" no blog (content/guias/escala-em-istambul.json), no mesmo molde dos guias de destino
 * (tests/blog-guia-orlando.test.ts, bloco de Madri em tests/blog-guias.test.ts). Lógica pura e arquivos: não sobe o Worker.
 * O atalho é /guia/escala (palavra-chave do Reel D12) e a migration entra como rascunho, como as dos outros guias.
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
const ctx = (over: Partial<RenderCtx> = {}): RenderCtx => ({ preview: false, local: false, destino: 'Istambul', campanha: 'escala', parceiros: VAZIO, ...over });

type Conteudo = {
  id: string; slug: string; regionId: string; title: string; titleHighlight: string | null; summary: string; lede: string | null;
  destination: string; coverUrl: string; coverUrlSmall: string; coverAlt: string; body: Record<string, unknown>[];
};

describe('guia Escala em Istambul (content/guias/escala-em-istambul.json)', () => {
  const conteudo = JSON.parse(readFileSync(new URL('../content/guias/escala-em-istambul.json', import.meta.url), 'utf8')) as Conteudo;
  const body = conteudo.body.map((b) => ctaBlock(b) ?? (b as unknown as Block));
  const tipos = conteudo.body.map((b) => b.t);
  const arq = (u: string) => new URL(`../public${u}`, import.meta.url);
  const texto = JSON.stringify(conteudo);

  it('campos do post dentro dos limites do editor, região existente e atalho /guia/escala', () => {
    expect(conteudo.slug).toBe('escala-em-istambul');
    expect(conteudo.regionId).toBe('europa');
    expect(conteudo.destination).toBe('Istambul');
    expect(conteudo.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(conteudo.title.length).toBeLessThanOrEqual(140);
    expect(conteudo.summary.length).toBeGreaterThanOrEqual(10);
    expect(conteudo.summary.length).toBeLessThanOrEqual(300);
    expect((conteudo.lede ?? '').length).toBeLessThanOrEqual(300);
    expect(conteudo.coverAlt.length).toBeGreaterThan(20);
    expect(conteudo.coverAlt.length).toBeLessThanOrEqual(200);
    expect(conteudo.title).toContain(String(conteudo.titleHighlight));
    expect(GUIAS_CURTOS.escala).toBe(conteudo.slug);
    // as chaves dos outros guias continuam como estavam
    expect(GUIAS_CURTOS.madri).toBe('madri-em-4-dias');
    expect(GUIAS_CURTOS.roma).toBe('roma-em-3-dias');
  });

  it('todos os blocos de ação são válidos e o guia começa pelo botão do PDF, que existe e é a v0.3 de 13 páginas', () => {
    expect(conteudo.body.filter((b) => ['pdf', 'passeio', 'whatsapp', 'carro', 'contato', 'afiliado'].includes(String(b.t))).every((b) => ctaBlock(b) !== null)).toBe(true);
    expect(tipos[0]).toBe('pdf');
    expect(conteudo.body[0]!.href).toBe('/guias/escala-em-istambul.pdf');
    const pdf = readFileSync(arq('/guias/escala-em-istambul.pdf'));
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g)).toHaveLength(13);
    expect(conteudo.body.filter((b) => b.t === 'pdf').every((b) => b.href === '/guias/escala-em-istambul.pdf')).toBe(true);
  });

  it('WhatsApp antes do roteiro e no fim, 2 passeios (sem preço), contato no fim e nenhum carro', () => {
    const iPasso1 = conteudo.body.findIndex((b) => b.t === 'h' && b.label === 'Passo 1');
    expect(tipos.indexOf('whatsapp')).toBeLessThan(iPasso1);
    expect(tipos.filter((t) => t === 'whatsapp')).toHaveLength(2);
    expect(tipos.filter((t) => t === 'passeio')).toHaveLength(2);
    expect(tipos).not.toContain('carro');
    expect(tipos.indexOf('contato')).toBeGreaterThan(tipos.lastIndexOf('passeio'));
    expect(tipos.filter((t) => t === 'afiliado').length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(conteudo.body.filter((b) => b.t === 'passeio'))).not.toMatch(/R\$|US\$|€|\d+,\d\d/);
    for (const b of conteudo.body.filter((x) => x.t === 'whatsapp')) expect(String(b.message)).toContain('Escala em Istambul');
  });

  it('as seções do guia estão na ordem do PDF', () => {
    const secoes = conteudo.body.filter((b) => b.t === 'h' && b.label).map((b) => `${b.label}: ${b.text}`);
    expect(secoes).toEqual([
      'Passo 1: A conta do tempo',
      'Passo 2: Entrada, bagagem e guarda-volumes',
      'Passo 3: Do aeroporto à cidade',
      'Como foi: Minha escala de 19 horas',
      'Passo 4: Roteiros de 10, 14 e 19 horas',
      'Fim da tarde: Barco no Bósforo e Torre da Donzela',
      'Sultanahmet: Mesquita Azul e Santa Sofia',
      'Passo 5: A volta ao aeroporto',
      'Valores: Quanto custa e checklist',
    ]);
    for (const trecho of ['10 h entre os voos', '14 h entre os voos', '19 h 46 entre os voos']) expect(texto).toContain(trecho);
  });

  it('fotos: existem, pesam menos de 250 KB, têm alt, legenda e crédito próprio; nenhuma antes do primeiro CTA; no máximo 2 por seção', () => {
    for (const u of [conteudo.coverUrl, conteudo.coverUrlSmall]) { expect(existsSync(arq(u))).toBe(true); expect(statSync(arq(u)).size).toBeLessThan(250_000); }
    expect(existsSync(arq('/assets/blog/istambul-escala-p.webp'))).toBe(true);
    const fotos = conteudo.body.filter((b) => b.t === 'img') as Array<Record<string, unknown>>;
    expect(fotos).toHaveLength(4);
    for (const f of fotos) {
      expect(existsSync(arq(String(f.src)))).toBe(true);
      expect(statSync(arq(String(f.src))).size).toBeLessThan(250_000);
      expect(String(f.alt).length).toBeGreaterThan(20);
      expect(String(f.caption).length).toBeGreaterThan(5);
      expect(f.credit).toBe('Foto: Carlos Victor / Rota Certa');
      expect(f.w).toBeTypeOf('number'); expect(f.h).toBeTypeOf('number');
    }
    expect(new Set(fotos.map((f) => f.src)).size).toBe(fotos.length);
    expect(tipos.slice(0, tipos.indexOf('whatsapp')).includes('img')).toBe(false);
    let seguidas = 0;
    for (const t of tipos) { if (t === 'h') seguidas = 0; if (t === 'img' && ++seguidas > 2) throw new Error('mais de 2 fotos numa seção'); }
    expect(texto).toContain('Foto de capa: Carlos Victor / Rota Certa.');
  });

  it('sem travessão; estimativas marcadas como da Rota Certa; seção do que o guia não informa; guia independente', () => {
    expect(texto).not.toMatch(/—|--/);
    expect(texto).toContain('Estimativa da Rota Certa, não é dado oficial');
    expect(texto).toContain('são estimativas e sugestões da Rota Certa, não dados oficiais');
    expect(texto).toContain('O que este guia não informa');
    expect(texto).toContain('Guia independente da Rota Certa');
    expect(texto).toContain('consultado em 23/10/2026');
    expect(texto).toContain('22/10/2026');
    // nenhum horário nem tarifa que o guia deixou de fora (M11, Havaist, táxi, barco do Bósforo)
    expect(texto).not.toMatch(/(M11|Havaist|metrô|táxi)[^"]{0,80}(TRY|R\$|€) ?\d/i);
    expect(texto).not.toMatch(/promet|garant/i);
  });

  it('a conta do tempo fecha: 7 h 40 de custo fixo e 2 h 20, 6 h 20 e cerca de 12 h na cidade', () => {
    const custo = 90 + 80 + 80 + 180 + 30; // minutos: imigração, ida, volta, antecedência, margem
    expect(custo).toBe(7 * 60 + 40);
    expect(texto).toContain('**Total que sai da sua escala:** 7 h 40');
    expect(10 * 60 - custo).toBe(2 * 60 + 20);
    expect(14 * 60 - custo).toBe(6 * 60 + 20);
    const entreVoos = (24 * 60 + 8 * 60 + 31) - (12 * 60 + 45); // pouso 12h45, voo 8h31 do dia seguinte
    expect(entreVoos).toBe(19 * 60 + 46);
    expect(Math.round((entreVoos - custo) / 60)).toBe(12);
  });

  it('os valores em reais seguem a cotação do Banco Central de 22/10/2026 (lira 0,1015 e euro 5,6494)', () => {
    const taxa = { TRY: 0.1015, EUR: 5.6494 };
    const pares = [...texto.matchAll(/(TRY|€) (\d+) \(cerca de R\$ (\d+)\)/g)];
    expect(pares.length).toBeGreaterThanOrEqual(7);
    for (const [, moeda, valor, reais] of pares) {
      expect(Number(reais), `${moeda} ${valor}`).toBe(Math.round(Number(valor) * taxa[moeda === '€' ? 'EUR' : 'TRY']));
    }
    // a lista de valores do guia: guarda-volumes 210, 270, 550; Torre 27 € e 75 TRY; Santa Sofia 25 €
    for (const v of ['TRY 210', 'TRY 270', 'TRY 550', '€ 27', 'TRY 75', '€ 25']) expect(texto).toContain(v);
  });

  it('desenha em produção sem passeios nem aviso, e na prévia com 2 passeios inativos', () => {
    const producao = renderBlocks(body, ctx(), true);
    expect(producao).not.toContain('Passeios de barco no Bósforo');
    expect(producao).not.toContain('aviso-afiliado');
    expect(producao).not.toContain('Inativo');
    expect(producao).toContain('cta-whatsapp');
    expect(producao).toContain('cta-contato');
    expect(producao).toContain('https://wa.me/351925307391?text=Oi%2C%20Rota%20Certa!%20Vi%20o%20guia%20Escala%20em%20Istambul');
    const previa = renderBlocks(body, ctx({ preview: true }), true);
    expect(previa.match(/cta-inativo/g)).toHaveLength(2);
    expect(previa.match(/aviso-afiliado/g)).toHaveLength(2);
  });

  it('migration 0042: só insere o rascunho (como os demais guias) e é a que o gerador produz a partir do conteúdo', () => {
    const arquivo = join(ROOT, 'd1', 'migrations', '0042_blog_guia_escala_istambul.sql');
    const sql = readFileSync(arquivo, 'utf8');
    expect(sql).toContain("'escala-em-istambul', 'draft', 'europa'");
    expect(sql).not.toMatch(/\b(UPDATE|DELETE|DROP|ALTER)\b/);
    expect(sql.match(/INSERT INTO blog_posts/g)).toHaveLength(1);
    expect(sql).not.toMatch(/—|--(?! )/);
    const dir = mkdtempSync(join(tmpdir(), 'gerador-escala-'));
    try {
      const saida = join(dir, 'x.sql');
      execFileSync(process.execPath, ['--import', 'tsx', join(ROOT, 'tools', 'gerar-migration-guia.ts'), 'content/guias/escala-em-istambul.json', saida], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      const gerado = readFileSync(saida, 'utf8').replace(/a partir de [^\n]*\./, '');
      expect(gerado).toBe(sql.replace(/a partir de [^\n]*\./, ''));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
