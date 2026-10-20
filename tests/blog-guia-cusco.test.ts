/**
 * Guia de Cusco e Machu Picchu no blog (content/guias/cusco-e-machu-picchu-em-4-dias.json): mesma estrutura
 * do piloto de Roma. Lógica pura: não sobe o Worker.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ctaBlock, renderBlocks, type Block, type BlogParceiros, type RenderCtx } from '../shared/blogGuias.js';
import { GUIAS_CURTOS } from '../worker/blog-parceiros.js';

const VAZIO: BlogParceiros = {
  getyourguide: { partnerId: '', baseUrl: 'https://www.getyourguide.com.br' },
  carro: { url: '' },
  contato: { whatsapp: '351925307391', instagramDm: 'https://ig.me/m/rotacerta.passagens', email: 'contato@rotacertapassagens.com' },
};
const ctx = (over: Partial<RenderCtx> = {}): RenderCtx => ({ preview: false, local: false, destino: 'Cusco', campanha: 'cusco', parceiros: VAZIO, ...over });

describe('guia de Cusco e Machu Picchu (content/guias/cusco-e-machu-picchu-em-4-dias.json)', () => {
  const conteudo = JSON.parse(readFileSync(new URL('../content/guias/cusco-e-machu-picchu-em-4-dias.json', import.meta.url), 'utf8')) as { body: Record<string, unknown>[]; [k: string]: unknown };
  const body = conteudo.body.map((b) => ctaBlock(b) ?? (b as unknown as Block));
  const tipos = conteudo.body.map((b) => b.t);
  const arq = (u: string) => new URL(`../public${u}`, import.meta.url);

  it('começa pelo botão do PDF, do arquivo que já existe, e o atalho curto aponta para o guia', () => {
    expect(tipos[0]).toBe('pdf');
    expect(conteudo.body[0]!.href).toBe('/guias/cusco-e-machu-picchu-em-4-dias.pdf');
    expect(readFileSync(arq('/guias/cusco-e-machu-picchu-em-4-dias.pdf')).subarray(0, 5).toString()).toBe('%PDF-');
    expect(GUIAS_CURTOS.cusco).toBe(conteudo.slug);
  });
  it('tem passagem antes do roteiro e no fim, um passeio por dia, contato no fim e nenhum carro', () => {
    const iDia1 = conteudo.body.findIndex((b) => b.t === 'h' && b.label === 'Dia 1');
    expect(tipos.indexOf('whatsapp')).toBeLessThan(iDia1);
    expect(tipos.filter((t) => t === 'whatsapp')).toHaveLength(2);
    expect(tipos.indexOf('contato')).toBeGreaterThan(tipos.lastIndexOf('passeio'));
    expect(tipos.filter((t) => t === 'passeio')).toHaveLength(4);
    expect(tipos).not.toContain('carro');
    for (const [i, t] of tipos.entries()) if (t === 'passeio') expect(conteudo.body[i + 1]!.t).toBe('h');
    expect(tipos.filter((t) => t === 'afiliado').length).toBeGreaterThanOrEqual(1);
  });
  it('fotos: existem, pesam menos de 250 KB e têm alt, legenda e crédito do Pexels; no máximo 2 por dia', () => {
    for (const u of [conteudo.coverUrl as string, conteudo.coverUrlSmall as string]) { expect(existsSync(arq(u))).toBe(true); expect(statSync(arq(u)).size).toBeLessThan(250_000); }
    expect(String(conteudo.coverAlt).length).toBeGreaterThan(20);
    const fotos = conteudo.body.filter((b) => b.t === 'img') as Array<Record<string, unknown>>;
    expect(fotos.length).toBeGreaterThanOrEqual(5);
    for (const f of fotos) {
      expect(existsSync(arq(String(f.src)))).toBe(true);
      expect(statSync(arq(String(f.src))).size).toBeLessThan(250_000);
      expect(String(f.alt).length).toBeGreaterThan(20);
      expect(String(f.caption).length).toBeGreaterThan(5);
      expect(f.credit).toMatch(/^Foto: .+ \/ Pexels$/);
      expect(f.w).toBeTypeOf('number'); expect(f.h).toBeTypeOf('number');
    }
    expect(new Set(fotos.map((f) => f.src)).size).toBe(fotos.length);
    let dia = 0; const porDia: number[] = [0];
    for (const b of conteudo.body) { if (b.t === 'h') porDia[++dia] = 0; if (b.t === 'img') porDia[dia] = (porDia[dia] ?? 0) + 1; }
    for (const n of porDia) expect(n).toBeLessThanOrEqual(2);
  });
  it('nenhuma foto entre o botão do PDF e o primeiro botão de passagem (WhatsApp)', () => {
    expect(tipos.slice(0, tipos.indexOf('whatsapp')).includes('img')).toBe(false);
  });
  it('não tem travessão nem preço de passeio, cita ingresso por circuito e passaporte, e destaca estimativas', () => {
    const texto = JSON.stringify(conteudo);
    expect(texto).not.toMatch(/—|--/);
    expect(JSON.stringify(conteudo.body.filter((b) => b.t === 'passeio'))).not.toMatch(/R\$|€|\d+,\d\d/);
    expect(texto).toContain('Estimativa da Rota Certa, não é dado oficial');
    expect(texto).toContain('Circuito 2, Clássico');
    expect(texto).toContain('passaporte');
  });
  it('desenha em produção sem passeios e sem aviso, e na prévia com 4 inativos', () => {
    const producao = renderBlocks(body, ctx(), true);
    expect(producao).not.toContain('Passeios em');
    expect(producao).not.toContain('Passeios no');
    expect(producao).not.toContain('aviso-afiliado');
    expect(producao).not.toContain('Inativo');
    expect(producao).toContain('cta-whatsapp');
    expect(producao).toContain('cta-contato');
    const previa = renderBlocks(body, ctx({ preview: true }), true);
    expect(previa.match(/cta-inativo/g)).toHaveLength(4);
    expect(previa.match(/aviso-afiliado/g)).toHaveLength(2);
  });
});
