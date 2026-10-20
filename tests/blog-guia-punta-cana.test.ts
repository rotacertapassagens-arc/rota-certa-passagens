/**
 * Guia de Punta Cana no blog (content/guias/punta-cana-praias-e-passeios.json): mesma estrutura do piloto de Roma.
 * Lógica pura: não sobe o Worker.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ctaBlock, renderBlocks, type Block, type BlogParceiros, type RenderCtx } from '../shared/blogGuias.js';

const VAZIO: BlogParceiros = {
  getyourguide: { partnerId: '', baseUrl: 'https://www.getyourguide.com.br' },
  carro: { url: '' },
  contato: { whatsapp: '351925307391', instagramDm: 'https://ig.me/m/rotacerta.passagens', email: 'contato@rotacertapassagens.com' },
};
const ctx = (over: Partial<RenderCtx> = {}): RenderCtx => ({ preview: false, local: false, destino: 'Punta Cana', campanha: 'punta-cana', parceiros: VAZIO, ...over });

const conteudo = JSON.parse(readFileSync(new URL('../content/guias/punta-cana-praias-e-passeios.json', import.meta.url), 'utf8')) as { body: Record<string, unknown>[]; [k: string]: unknown };
const body = conteudo.body.map((b) => ctaBlock(b) ?? (b as unknown as Block));
const tipos = conteudo.body.map((b) => b.t);
const arq = (u: string) => new URL(`../public${u}`, import.meta.url);

describe('guia de Punta Cana (content/guias/punta-cana-praias-e-passeios.json)', () => {
  it('começa pelo botão do PDF que já existe no site', () => {
    expect(tipos[0]).toBe('pdf');
    expect(conteudo.body[0]!.href).toBe('/guias/punta-cana-praias-e-passeios.pdf');
    expect(readFileSync(arq('/guias/punta-cana-praias-e-passeios.pdf')).subarray(0, 5).toString()).toBe('%PDF-');
  });
  it('mesma ordem de botões de Roma: passagem antes do roteiro e no fim, 3 passeios, contato no fim', () => {
    const iDia1 = conteudo.body.findIndex((b) => b.t === 'h' && b.label === 'Dias 1 e 2');
    expect(conteudo.body.findIndex((b) => b.t === 'whatsapp')).toBeLessThan(iDia1);
    expect(tipos.filter((t) => t === 'whatsapp')).toHaveLength(2);
    expect(tipos.filter((t) => t === 'pdf')).toHaveLength(2);
    expect(tipos.filter((t) => t === 'passeio')).toHaveLength(3);
    expect(tipos.indexOf('contato')).toBeGreaterThan(tipos.lastIndexOf('passeio'));
    for (const [i, t] of tipos.entries()) if (t === 'passeio') expect(conteudo.body[i + 1]!.t).toBe('h');
    expect(tipos.slice(-3)).toEqual(['whatsapp', 'contato', 'afiliado']);
  });
  it('tem o botão de carro só na parte de deslocamento (Chegada)', () => {
    expect(tipos.filter((t) => t === 'carro')).toHaveLength(1);
    const iCarro = tipos.indexOf('carro');
    const iHead = conteudo.body.findIndex((b) => b.t === 'h' && b.label === 'Na prática');
    expect(iCarro).toBeGreaterThan(iHead);
  });
  it('fotos: capa e cada foto existem, pesam menos de 250 KB e têm alt, legenda e crédito do Pexels', () => {
    for (const u of [conteudo.coverUrl as string, conteudo.coverUrlSmall as string, '/assets/blog/punta-cana-5-dias-p.webp']) { expect(existsSync(arq(u))).toBe(true); expect(statSync(arq(u)).size).toBeLessThan(250_000); }
    expect(String(conteudo.coverAlt).length).toBeGreaterThan(20);
    const fotos = conteudo.body.filter((b) => b.t === 'img') as Array<Record<string, unknown>>;
    expect(fotos.length).toBeGreaterThanOrEqual(3);
    for (const f of fotos) {
      expect(existsSync(arq(String(f.src)))).toBe(true);
      expect(statSync(arq(String(f.src))).size).toBeLessThan(250_000);
      expect(String(f.alt).length).toBeGreaterThan(20);
      expect(String(f.caption).length).toBeGreaterThan(5);
      expect(f.credit).toMatch(/^Foto: .+ \/ Pexels$/);
    }
    expect(new Set(fotos.map((f) => f.src)).size).toBe(fotos.length);
    expect(tipos.slice(0, tipos.indexOf('whatsapp')).includes('img')).toBe(false);
    expect(JSON.stringify(conteudo.body)).toContain('Foto de capa: Talita Kriunas / Pexels.');
  });
  it('não tem travessão, não nomeia Saona nem Hoyo Azul em legenda de foto e não põe preço em passeio', () => {
    const texto = JSON.stringify(conteudo);
    expect(texto).not.toMatch(/—|--/);
    for (const f of conteudo.body.filter((b) => b.t === 'img')) expect(`${f.alt} ${f.caption}`).not.toMatch(/Saona|Hoyo|Bávaro/);
    expect(JSON.stringify(conteudo.body.filter((b) => b.t === 'passeio'))).not.toMatch(/R\$|US\$|€|\d+,\d\d/);
    expect(texto).toContain('Estimativa da Rota Certa, não é dado oficial');
    expect(texto).toContain('CIVP');
    expect(texto).toContain('e-Ticket');
  });
  it('em produção sem parceiros esconde passeios e carro; na prévia mostra 4 inativos', () => {
    const producao = renderBlocks(body, ctx(), true);
    expect(producao).not.toContain('Passeios à Ilha Saona');
    expect(producao).not.toContain('Vai alugar um carro');
    expect(producao).not.toContain('aviso-afiliado');
    expect(producao).not.toContain('Inativo');
    expect(producao).toContain('Oi%2C%20Rota%20Certa!%20Vi%20o%20guia%20de%20Punta%20Cana');
    const previa = renderBlocks(body, ctx({ preview: true }), true);
    expect(previa.match(/cta-inativo/g)).toHaveLength(4);
  });
});
