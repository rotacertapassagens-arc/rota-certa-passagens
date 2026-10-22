/**
 * Guia de Orlando no blog (content/guias/orlando-a-ordem-dos-parques.json), no mesmo molde do piloto de Roma
 * (tests/blog-guias.test.ts). Lógica pura: não sobe o Worker.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GUIAS_CURTOS } from '../worker/blog-parceiros.js';
import { ctaBlock, renderBlocks, type Block, type BlogParceiros, type RenderCtx } from '../shared/blogGuias.js';

const VAZIO: BlogParceiros = {
  getyourguide: { partnerId: '', baseUrl: 'https://www.getyourguide.com.br' },
  carro: { url: '' },
  contato: { whatsapp: '351925307391', instagramDm: 'https://ig.me/m/rotacerta.passagens', email: 'contato@rotacertapassagens.com' },
};
const ctx = (over: Partial<RenderCtx> = {}): RenderCtx => ({ preview: false, local: false, destino: 'Orlando', campanha: 'orlando', parceiros: VAZIO, ...over });

describe('guia de Orlando (content/guias/orlando-a-ordem-dos-parques.json)', () => {
  const conteudo = JSON.parse(readFileSync(new URL('../content/guias/orlando-a-ordem-dos-parques.json', import.meta.url), 'utf8')) as { body: Record<string, unknown>[]; [k: string]: unknown };
  const body = conteudo.body.map((b) => ctaBlock(b) ?? (b as unknown as Block));
  const tipos = conteudo.body.map((b) => b.t);
  const arq = (u: string) => new URL(`../public${u}`, import.meta.url);

  it('todos os blocos são válidos; começa pelo botão do PDF que já existe', () => {
    expect(conteudo.body.filter((b) => ['pdf', 'passeio', 'whatsapp', 'carro', 'contato', 'afiliado'].includes(String(b.t))).every((b) => ctaBlock(b) !== null)).toBe(true);
    expect(tipos[0]).toBe('pdf');
    expect(conteudo.body[0]!.href).toBe('/guias/orlando-a-ordem-dos-parques.pdf');
    expect(readFileSync(arq('/guias/orlando-a-ordem-dos-parques.pdf')).subarray(0, 5).toString()).toBe('%PDF-');
  });
  it('atalho /guia/orlando aponta para o slug do guia', () => {
    expect(GUIAS_CURTOS.orlando).toBe(conteudo.slug);
  });
  it('tem WhatsApp antes do roteiro e no fim, 7 passeios (um por dia, no fim de cada dia), carro e contato no fim', () => {
    const iDia1 = conteudo.body.findIndex((b) => b.t === 'h' && String(b.label).startsWith('Dia 1'));
    expect(tipos.indexOf('whatsapp')).toBeLessThan(iDia1);
    expect(tipos.filter((t) => t === 'whatsapp')).toHaveLength(2);
    expect(tipos.filter((t) => t === 'passeio')).toHaveLength(7);
    expect(tipos.filter((t) => t === 'carro')).toHaveLength(1);
    expect(tipos.indexOf('contato')).toBeGreaterThan(tipos.lastIndexOf('passeio'));
    expect(tipos.indexOf('carro')).toBeGreaterThan(tipos.lastIndexOf('passeio'));
    for (const [i, t] of tipos.entries()) if (t === 'passeio') expect(conteudo.body[i + 1]!.t).toBe('h');
    expect(tipos.filter((t) => t === 'afiliado').length).toBeGreaterThanOrEqual(1);
  });
  it('uma seção por parque, na ordem do PDF', () => {
    const parques = conteudo.body.filter((b) => b.t === 'h' && String(b.label).startsWith('Dia ')).map((b) => b.text);
    expect(parques).toEqual(['Magic Kingdom', 'EPCOT', 'Hollywood Studios', 'Animal Kingdom', 'Universal Studios Florida', 'Islands of Adventure', 'Epic Universe']);
  });
  it('fotos: existem, pesam menos de 250 KB, têm alt, legenda e crédito do Pexels, e no máximo 2 por dia', () => {
    for (const u of [conteudo.coverUrl as string, conteudo.coverUrlSmall as string]) { expect(existsSync(arq(u))).toBe(true); expect(statSync(arq(u)).size).toBeLessThan(250_000); }
    expect(existsSync(arq('/assets/blog/orlando-parques-p.webp'))).toBe(true);
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
    // nenhuma foto entre o botão do PDF e o primeiro WhatsApp
    expect(tipos.slice(0, tipos.indexOf('whatsapp')).includes('img')).toBe(false);
    // no máximo 2 fotos entre dois títulos
    let seguidas = 0;
    for (const t of tipos) { if (t === 'h') seguidas = 0; if (t === 'img' && ++seguidas > 2) throw new Error('mais de 2 fotos numa seção'); }
  });
  it('sem travessão, sem preço de passeio, sem taxa de visto fixada, com nota de guia independente', () => {
    const texto = JSON.stringify(conteudo);
    expect(texto).not.toMatch(/—|--/);
    expect(JSON.stringify(conteudo.body.filter((b) => b.t === 'passeio'))).not.toMatch(/R\$|US\$|€|\d+,\d\d/);
    expect(texto).not.toMatch(/US\$ ?\d{3}|taxa de (US\$|R\$)/i);
    expect(texto).toContain('Guia independente');
    expect(texto).toContain('Park-to-Park');
    expect(texto).toContain('Epic Universe');
  });
  it('desenha em produção sem passeios, carro e aviso, e na prévia com 7 passeios e 1 carro inativos', () => {
    const producao = renderBlocks(body, ctx(), true);
    expect(producao).not.toContain('passeios no');
    expect(producao).not.toContain('Vai alugar um carro');
    expect(producao).not.toContain('aviso-afiliado');
    expect(producao).not.toContain('Inativo');
    expect(producao).toContain('cta-whatsapp');
    expect(producao).toContain('cta-contato');
    const previa = renderBlocks(body, ctx({ preview: true }), true);
    expect(previa.match(/cta-inativo/g)).toHaveLength(8);
    expect(previa.match(/cta-carro cta-inativo/g)).toHaveLength(1);
  });
});
