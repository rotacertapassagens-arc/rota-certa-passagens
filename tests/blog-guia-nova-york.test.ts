/**
 * Guia de Nova York (content/guias/nova-york-em-4-dias.json): mesma estrutura do piloto de Roma.
 * Lógica pura, não sobe o Worker.
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
const ctx = (over: Partial<RenderCtx> = {}): RenderCtx => ({ preview: false, local: false, destino: 'Nova York', campanha: 'novayork', parceiros: VAZIO, ...over });

const conteudo = JSON.parse(readFileSync(new URL('../content/guias/nova-york-em-4-dias.json', import.meta.url), 'utf8')) as { body: Record<string, unknown>[]; [k: string]: unknown };
const body = conteudo.body.map((b) => ctaBlock(b) ?? (b as unknown as Block));
const tipos = conteudo.body.map((b) => b.t);
const arq = (u: string) => new URL(`../public${u}`, import.meta.url);

describe('guia de Nova York (content/guias/nova-york-em-4-dias.json)', () => {
  it('começa pelo botão do PDF que já existe e tem atalho /guia/novayork', () => {
    expect(tipos[0]).toBe('pdf');
    expect(conteudo.body[0]!.href).toBe('/guias/nova-york-em-4-dias.pdf');
    expect(readFileSync(arq('/guias/nova-york-em-4-dias.pdf')).subarray(0, 5).toString()).toBe('%PDF-');
    expect(GUIAS_CURTOS.novayork).toBe(conteudo.slug);
  });
  it('passagem antes do roteiro e no fim, 4 passeios (um por dia), contato no fim e nenhum carro', () => {
    const iDia1 = conteudo.body.findIndex((b) => b.t === 'h' && b.label === 'Dia 1');
    expect(tipos.indexOf('whatsapp')).toBeLessThan(iDia1);
    expect(tipos.filter((t) => t === 'whatsapp')).toHaveLength(2);
    expect(tipos.indexOf('contato')).toBeGreaterThan(tipos.lastIndexOf('passeio'));
    expect(tipos.filter((t) => t === 'passeio')).toHaveLength(4);
    expect(tipos).not.toContain('carro');
    for (const [i, t] of tipos.entries()) if (t === 'passeio') expect(conteudo.body[i + 1]!.t).toBe('h');
  });
  it('fotos: existem, pesam menos de 250 KB, têm alt, legenda e crédito do Pexels; nenhuma antes do primeiro CTA', () => {
    for (const u of [conteudo.coverUrl as string, conteudo.coverUrlSmall as string]) { expect(existsSync(arq(u))).toBe(true); expect(statSync(arq(u)).size).toBeLessThan(250_000); }
    const fotos = conteudo.body.filter((b) => b.t === 'img') as Array<Record<string, unknown>>;
    expect(fotos).toHaveLength(3);
    for (const f of fotos) {
      expect(statSync(arq(String(f.src))).size).toBeLessThan(250_000);
      expect(String(f.alt).length).toBeGreaterThan(20);
      expect(String(f.caption).length).toBeGreaterThan(5);
      expect(f.credit).toMatch(/^Foto: .+ \/ Pexels$/);
    }
    expect(tipos.slice(0, tipos.indexOf('whatsapp')).includes('img')).toBe(false);
  });
  it('sem travessão, sem taxa do visto e sem preço por viagem do metrô, nem preço em passeio', () => {
    const texto = JSON.stringify(conteudo);
    expect(texto).not.toMatch(/—|--/);
    expect(texto).not.toMatch(/US\$ ?3\b(?![\d,.])/);
    expect(texto).not.toMatch(/US\$ ?(185|2\d\d)\b/);
    expect(JSON.stringify(conteudo.body.filter((b) => b.t === 'passeio'))).not.toMatch(/R\$|US\$|\d+,\d\d/);
    expect(texto).toContain('Statue City Cruises');
    expect(texto).toContain('US$ 35');
    expect(texto).toContain('inclusive para fazer só uma conexão');
  });
  it('em produção esconde os passeios e o aviso; na prévia mostra 4 inativos; WhatsApp cita Nova York', () => {
    const producao = renderBlocks(body, ctx(), true);
    expect(producao).not.toContain('cta-inativo');
    expect(producao).not.toContain('aviso-afiliado');
    expect(producao).toContain('Vi%20o%20guia%20de%20Nova%20York');
    expect(renderBlocks(body, ctx({ preview: true }), true).match(/cta-inativo/g)).toHaveLength(4);
  });
});
