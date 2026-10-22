/**
 * Guia de Londres no blog (content/guias/londres-em-4-dias.json): mesma estrutura do piloto de Roma.
 * Lógica pura: não sobe o Worker. Confere blocos, ordem dos botões, fotos com crédito, ausência de travessão,
 * PDF existente, migration 0027 (só rascunho) e o atalho /guia/londres.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderBlocks, ctaBlock, type Block, type BlogParceiros, type RenderCtx } from '../shared/blogGuias.js';
import { GUIAS_CURTOS } from '../worker/blog-parceiros.js';

// A validação dos blocos é a do editor (worker/blog.ts), exercitada pelo gerador, que recusa bloco inválido:
// o teste não importa o Worker para não puxar o tipo global Env para o typecheck de tests/.
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const VAZIO: BlogParceiros = {
  getyourguide: { partnerId: '', baseUrl: 'https://www.getyourguide.com.br' },
  carro: { url: '' },
  contato: { whatsapp: '351925307391', instagramDm: 'https://ig.me/m/rotacerta.passagens', email: 'contato@rotacertapassagens.com' },
};
const ctx = (over: Partial<RenderCtx> = {}): RenderCtx => ({ preview: false, local: false, destino: 'Londres', campanha: 'londres', parceiros: VAZIO, ...over });
const arq = (u: string) => new URL(`../public${u}`, import.meta.url);

describe('guia de Londres (content/guias/londres-em-4-dias.json)', () => {
  const conteudo = JSON.parse(readFileSync(new URL('../content/guias/londres-em-4-dias.json', import.meta.url), 'utf8')) as { body: Record<string, unknown>[]; [k: string]: unknown };
  const body = conteudo.body.map((b) => ctaBlock(b) ?? (b as unknown as Block));
  const tipos = conteudo.body.map((b) => b.t);

  it('passa na validação do editor (pelo gerador), a 0027 é o que ele gera hoje e usa um slug novo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gerador-'));
    try {
      const saida = join(dir, '0027.sql');
      execFileSync(process.execPath, ['--import', 'tsx', join(ROOT, 'tools', 'gerar-migration-guia.ts'), 'content/guias/londres-em-4-dias.json', saida], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
      expect(readFileSync(saida, 'utf8')).toBe(readFileSync(join(ROOT, 'd1', 'migrations', '0027_blog_guia_londres.sql'), 'utf8').replace(/\r\n/g, '\n')); // o checkout no Windows pode trazer CRLF
    } finally { rmSync(dir, { recursive: true, force: true }); }
    expect(conteudo.slug).toBe('londres-em-4-dias');
    expect(['roma-em-4-dias', 'roma-em-3-dias', 'istambul-primeira-visita', 'albania-praias-e-cidades-historicas', 'lisboa-em-3-dias', 'voltar-ao-brasil-nas-ferias', 'paris-primeira-viagem']).not.toContain(conteudo.slug);
  });
  it('começa pelo botão do PDF que já existe e repete no fim', () => {
    expect(tipos[0]).toBe('pdf');
    expect(conteudo.body[0]!.href).toBe('/guias/londres-em-4-dias.pdf');
    expect(readFileSync(new URL('../public/guias/londres-em-4-dias.pdf', import.meta.url)).subarray(0, 5).toString()).toBe('%PDF-');
    expect(tipos.filter((t) => t === 'pdf')).toHaveLength(2);
  });
  it('tem WhatsApp antes do roteiro e no fim, 4 passeios (um por dia), contato no fim e nenhum carro', () => {
    const iDia1 = conteudo.body.findIndex((b) => b.t === 'h' && b.label === 'Dia 1');
    expect(conteudo.body.findIndex((b) => b.t === 'whatsapp')).toBeLessThan(iDia1);
    expect(tipos.filter((t) => t === 'whatsapp')).toHaveLength(2);
    expect(tipos.indexOf('contato')).toBeGreaterThan(tipos.lastIndexOf('passeio'));
    expect(tipos.filter((t) => t === 'passeio')).toHaveLength(4);
    expect(tipos).not.toContain('carro');
    for (const [i, t] of tipos.entries()) if (t === 'passeio') expect(conteudo.body[i + 1]!.t).toBe('h');
    expect(tipos.filter((t) => t === 'afiliado').length).toBeGreaterThanOrEqual(1);
  });
  it('fotos: existem, pesam menos de 250 KB e têm alt, legenda e crédito do Pexels; sem repetir', () => {
    for (const u of [conteudo.coverUrl as string, conteudo.coverUrlSmall as string]) { expect(existsSync(arq(u))).toBe(true); expect(statSync(arq(u)).size).toBeLessThan(250_000); }
    expect(String(conteudo.coverAlt).length).toBeGreaterThan(20);
    const fotos = conteudo.body.filter((b) => b.t === 'img') as Array<Record<string, unknown>>;
    expect(fotos).toHaveLength(3);
    for (const f of fotos) {
      expect(existsSync(arq(String(f.src)))).toBe(true);
      expect(statSync(arq(String(f.src))).size).toBeLessThan(250_000);
      expect(String(f.alt).length).toBeGreaterThan(20);
      expect(String(f.caption).length).toBeGreaterThan(5);
      expect(f.credit).toMatch(/^Foto: .+ \/ Pexels$/);
      expect(f.w).toBeTypeOf('number'); expect(f.h).toBeTypeOf('number');
    }
    expect(new Set(fotos.map((f) => f.src)).size).toBe(fotos.length);
    expect(fotos.map((f) => f.src)).not.toContain(conteudo.coverUrl);
  });
  it('nenhuma foto entre o botão do PDF e o primeiro botão de passagem (WhatsApp)', () => {
    expect(tipos.slice(0, tipos.indexOf('whatsapp')).includes('img')).toBe(false);
  });
  it('no máximo 2 fotos por dia', () => {
    let fotos = 0;
    for (const b of conteudo.body) {
      if (b.t === 'h') fotos = 0;
      if (b.t === 'img') expect(++fotos).toBeLessThanOrEqual(2);
    }
  });
  it('não tem travessão nem preço de passeio, e destaca estimativas como da Rota Certa', () => {
    const texto = JSON.stringify(conteudo);
    expect(texto).not.toMatch(/—|--/);
    expect(JSON.stringify(conteudo.body.filter((b) => b.t === 'passeio'))).not.toMatch(/R\$|£|€|\d+,\d\d/);
    expect(texto).toContain('Estimativa da Rota Certa, não é dado oficial');
    expect(texto).toContain('ETA');
  });
  it('desenha em produção sem passeios e sem aviso, e na prévia com 4 inativos', () => {
    const producao = renderBlocks(body, ctx(), true);
    expect(producao).not.toContain('Passeios em');
    expect(producao).not.toContain('aviso-afiliado');
    expect(producao).not.toContain('Inativo');
    expect(producao).toContain('cta-whatsapp');
    expect(producao).toContain('cta-contato');
    const previa = renderBlocks(body, ctx({ preview: true }), true);
    expect(previa.match(/cta-inativo/g)).toHaveLength(4);
    expect(previa.match(/aviso-afiliado/g)).toHaveLength(2);
    expect(producao).toContain('https://wa.me/351925307391?text=Oi%2C%20Rota%20Certa!%20Vi%20o%20guia%20de%20Londres');
  });
  it('migration 0027 só insere o rascunho e o atalho /guia/londres aponta para o slug', () => {
    const sql = readFileSync(new URL('../d1/migrations/0027_blog_guia_londres.sql', import.meta.url), 'utf8');
    expect(sql).toContain("'londres-em-4-dias', 'draft'");
    expect(sql).not.toMatch(/\b(UPDATE|DELETE|DROP|ALTER)\b/);
    expect(sql.match(/INSERT INTO blog_posts/g)).toHaveLength(1);
    expect(GUIAS_CURTOS.londres).toBe('londres-em-4-dias');
    expect(GUIAS_CURTOS.roma).toBe('roma-em-3-dias');
  });
});
