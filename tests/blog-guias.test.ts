/**
 * Guias monetizados do blog (shared/blogGuias.ts): validação e desenho dos botões de ação, regra de
 * parceiro sem link (escondido em produção, "inativo" na prévia e no local), parâmetros utm_* e o
 * conteúdo-piloto de Roma (content/guias/roma-em-3-dias.json). Lógica pura: não sobe o Worker.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AVISO_AFILIADO, ctaBlock, isLocalHost, pdfDoTopo, renderBlocks, type Block, type BlogParceiros, type RenderCtx,
} from '../shared/blogGuias.js';

const VAZIO: BlogParceiros = {
  getyourguide: { partnerId: '', baseUrl: 'https://www.getyourguide.com.br' },
  carro: { url: '' },
  contato: { whatsapp: '351925307391', instagramDm: 'https://ig.me/m/rotacerta.passagens', email: 'contato@rotacertapassagens.com' },
};
const CONFIGURADO: BlogParceiros = {
  ...VAZIO,
  getyourguide: { partnerId: 'ABC123', baseUrl: 'https://www.getyourguide.com.br' },
  carro: { url: 'https://parceiro.example/carros?aff=XYZ' },
};
const ctx = (over: Partial<RenderCtx> = {}): RenderCtx => ({ preview: false, local: false, destino: 'Roma', campanha: 'roma', parceiros: VAZIO, ...over });

const passeio: Block = { t: 'passeio', busca: 'Coliseu Roma' };
const carro: Block = { t: 'carro' };
const afiliado: Block = { t: 'afiliado' };

describe('validação dos blocos de ação', () => {
  it('aceita os seis tipos e ignora campos desconhecidos', () => {
    expect(ctaBlock({ t: 'pdf', href: '/guias/roma-em-3-dias.pdf', extra: 1 })).toEqual({ t: 'pdf', href: '/guias/roma-em-3-dias.pdf' });
    expect(ctaBlock({ t: 'passeio', busca: 'Coliseu Roma', title: 'Passeios' })).toEqual({ t: 'passeio', busca: 'Coliseu Roma', title: 'Passeios' });
    expect(ctaBlock({ t: 'whatsapp', message: 'Oi!' })).toEqual({ t: 'whatsapp', message: 'Oi!' });
    expect(ctaBlock({ t: 'carro' })).toEqual({ t: 'carro' });
    expect(ctaBlock({ t: 'contato', title: 'Fale conosco' })).toEqual({ t: 'contato', title: 'Fale conosco' });
    expect(ctaBlock({ t: 'afiliado', text: 'ignorado' })).toEqual({ t: 'afiliado' });
  });
  it('recusa PDF fora de /guias/, passeio sem busca e textos grandes demais', () => {
    expect(ctaBlock({ t: 'pdf', href: 'https://evil.example/x.pdf' })).toBeNull();
    expect(ctaBlock({ t: 'pdf', href: '/guias/../admin.pdf' })).toBeNull();
    expect(ctaBlock({ t: 'pdf', href: '/guias/roma.html' })).toBeNull();
    expect(ctaBlock({ t: 'passeio', busca: '' })).toBeNull();
    expect(ctaBlock({ t: 'whatsapp', message: 'x'.repeat(301) })).toBeNull();
    expect(ctaBlock({ t: 'nao-existe' })).toBeNull();
  });
});

describe('parceiro sem link', () => {
  it('em produção (visitante, host real) passeio e carro somem, sem rastro', () => {
    const html = renderBlocks([passeio, carro, afiliado], ctx());
    expect(html).toBe('');
  });
  it('na prévia do painel aparecem como inativos, sem link', () => {
    const html = renderBlocks([passeio, carro, afiliado], ctx({ preview: true }));
    expect(html.match(/cta-inativo/g)).toHaveLength(2);
    expect(html).toContain('Inativo: falta o ID de parceiro do GetYourGuide');
    expect(html).toContain('Inativo: falta o link do parceiro de carro');
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toContain('<a ');
    expect(html).toContain(AVISO_AFILIADO);
  });
  it('no ambiente local também aparecem como inativos', () => {
    const html = renderBlocks([passeio], ctx({ local: true }));
    expect(html).toContain('data-estado="inativo"');
  });
  it('detecta o ambiente local pelo host', () => {
    for (const h of ['localhost', '127.0.0.1', '[::1]', 'teste.localhost']) expect(isLocalHost(h)).toBe(true);
    for (const h of ['rotacertapassagens.com', 'www.rotacertapassagens.com', 'localhost.evil.com']) expect(isLocalHost(h)).toBe(false);
  });
});

describe('parceiro configurado', () => {
  const html = renderBlocks([passeio, carro, afiliado], ctx({ parceiros: CONFIGURADO }));
  it('mostra os botões como links patrocinados em nova aba, sem texto de inativo', () => {
    expect(html).not.toContain('cta-inativo');
    expect(html.match(/rel="sponsored noopener"/g)).toHaveLength(2);
    expect(html.match(/target="_blank"/g)).toHaveLength(2);
  });
  it('monta o link do GetYourGuide com ID de parceiro e utm_*', () => {
    const href = new DOMParserLike(html).hrefs()[0]!;
    const u = new URL(href);
    expect(u.origin + u.pathname).toBe('https://www.getyourguide.com.br/s/');
    expect(u.searchParams.get('q')).toBe('Coliseu Roma');
    expect(u.searchParams.get('partner_id')).toBe('ABC123');
    expect(Object.fromEntries(['utm_source', 'utm_medium', 'utm_campaign', 'utm_content'].map((k) => [k, u.searchParams.get(k)])))
      .toEqual({ utm_source: 'rotacerta', utm_medium: 'blog', utm_campaign: 'roma', utm_content: 'passeio-1' });
  });
  it('carro leva utm_content próprio e preserva o parâmetro do parceiro', () => {
    const u = new URL(new DOMParserLike(html).hrefs()[1]!);
    expect(u.host).toBe('parceiro.example');
    expect(u.searchParams.get('aff')).toBe('XYZ');
    expect(u.searchParams.get('utm_content')).toBe('carro-1');
  });
  it('exibe o aviso de afiliado perto dos botões de parceiro', () => {
    expect(html).toContain(`<p class="aviso-afiliado" role="note">${AVISO_AFILIADO}</p>`);
  });
  it('recusa link de parceiro que não seja https', () => {
    const inseguro = renderBlocks([carro], ctx({ parceiros: { ...CONFIGURADO, carro: { url: 'javascript:alert(1)' } } }));
    expect(inseguro).toBe('');
  });
  it('numera cada botão do mesmo tipo (utm_content distinto)', () => {
    const dois = renderBlocks([passeio, { t: 'passeio', busca: 'Vaticano Roma' }], ctx({ parceiros: CONFIGURADO }));
    expect(dois).toContain('utm_content=passeio-1');
    expect(dois).toContain('utm_content=passeio-2');
  });
});

describe('aviso de afiliado', () => {
  it('não aparece sozinho em produção quando não há parceiro ativo', () => {
    expect(renderBlocks([afiliado], ctx())).toBe('');
  });
  it('texto fixo, sem travessão', () => {
    expect(AVISO_AFILIADO).toBe('Alguns links são de parceiros: podemos receber uma comissão, sem custo para você.');
    expect(AVISO_AFILIADO).not.toMatch(/—|--/);
  });
});

describe('PDF, WhatsApp e contato', () => {
  it('o PDF é um download direto com utm_* e o primeiro bloco sobe para o topo', () => {
    const pdf: Block = { t: 'pdf', href: '/guias/roma-em-3-dias.pdf' };
    expect(pdfDoTopo([pdf, { t: 'p', text: 'x' }])).toEqual(pdf);
    expect(pdfDoTopo([{ t: 'p', text: 'x' }, pdf])).toBeNull();
    const html = renderBlocks([pdf], ctx());
    expect(html).toContain('href="/guias/roma-em-3-dias.pdf?utm_source=rotacerta&amp;utm_medium=blog&amp;utm_campaign=roma&amp;utm_content=pdf-1"');
    expect(html).toContain(' download ');
    expect(html).toContain('Baixar o guia (PDF)');
    expect(html).toContain('Grátis, sem cadastro.');
  });
  it('com o PDF no topo, não repete o botão no corpo e mantém a numeração', () => {
    const pdf: Block = { t: 'pdf', href: '/guias/roma-em-3-dias.pdf' };
    const html = renderBlocks([pdf, { t: 'p', text: 'Oi' }, pdf], ctx(), true);
    expect(html.match(/btn-pdf/g)).toHaveLength(1);
    expect(html).toContain('utm_content=pdf-2');
  });
  it('WhatsApp usa o número do site, mensagem com o destino e utm_*', () => {
    const u = new URL(new DOMParserLike(renderBlocks([{ t: 'whatsapp' }], ctx())).hrefs()[0]!);
    expect(u.origin + u.pathname).toBe('https://wa.me/351925307391');
    expect(u.searchParams.get('text')).toBe('Oi, Rota Certa! Vi o guia de Roma e quero cotar uma passagem para Roma.');
    expect(u.searchParams.get('utm_content')).toBe('whatsapp-1');
  });
  it('WhatsApp aceita mensagem própria e funciona sem destino', () => {
    const custom = new URL(new DOMParserLike(renderBlocks([{ t: 'whatsapp', message: 'Quero Roma em maio' }], ctx())).hrefs()[0]!);
    expect(custom.searchParams.get('text')).toBe('Quero Roma em maio');
    const semDestino = new URL(new DOMParserLike(renderBlocks([{ t: 'whatsapp' }], ctx({ destino: '', campanha: 'guia' }))).hrefs()[0]!);
    expect(semDestino.searchParams.get('text')).toContain('quero cotar uma passagem');
  });
  it('contato: Instagram Direct e e-mail', () => {
    const html = renderBlocks([{ t: 'contato' }], ctx());
    expect(html).toContain('href="https://ig.me/m/rotacerta.passagens?utm_source=rotacerta');
    expect(html).toContain('href="mailto:contato@rotacertapassagens.com"');
    expect(html).toContain('Falar com a gente');
  });
  it('escapa texto vindo do editor', () => {
    const html = renderBlocks([{ t: 'whatsapp', title: '<img src=x onerror=alert(1)>', text: '"><script>1</script>' }], ctx());
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('blocos antigos continuam iguais', () => {
  it('parágrafo, título, lista e dicas saem como antes', () => {
    const html = renderBlocks([
      { t: 'p', text: 'Um **texto**.' }, { t: 'h', label: 'Dia 1', text: 'Roma' }, { t: 'ul', items: ['a'] }, { t: 'tip', items: ['b'] },
    ], ctx());
    expect(html).toBe([
      '<p>Um <strong>texto</strong>.</p>',
      '<h2><span class="num">Dia 1</span>Roma</h2>',
      '<ul><li>a</li></ul>',
      '<div class="tip"><h3>Dicas práticas</h3><ul><li>b</li></ul></div>',
    ].join('\n'));
  });
});

describe('foto com legenda e crédito (bloco img)', () => {
  const foto = { t: 'img', src: '/assets/blog/roma-forum.jpg', alt: 'Ruínas do Fórum Romano', caption: 'O Fórum.', credit: 'Foto: Fabio Fistarol / Unsplash', w: 1000, h: 667 };
  it('desenha figura lazy, com largura e altura, legenda e crédito escapados', () => {
    const html = renderBlocks([{ ...foto, credit: 'Foto: <b>X</b> / Unsplash' } as Block], ctx());
    expect(html).toContain('<figure class="foto-cred"><img src="/assets/blog/roma-forum.jpg"');
    expect(html).toContain('width="1000" height="667" loading="lazy" decoding="async"');
    expect(html).toContain('<span class="foto-legenda">O Fórum.</span>');
    expect(html).toContain('<span class="foto-credito">Foto: &lt;b&gt;X&lt;/b&gt; / Unsplash</span>');
  });
  it('foto antiga, sem crédito, sai exatamente como antes', () => {
    expect(renderBlocks([{ t: 'img', src: '/assets/blog/roma.jpg', alt: 'a', caption: 'c' }], ctx()))
      .toBe('<figure><img src="/assets/blog/roma.jpg" alt="a" loading="lazy" decoding="async"><figcaption>c</figcaption></figure>');
  });
});

describe('guia piloto de Roma (content/guias/roma-em-3-dias.json)', () => {
  const conteudo = JSON.parse(readFileSync(new URL('../content/guias/roma-em-3-dias.json', import.meta.url), 'utf8')) as { body: Record<string, unknown>[]; [k: string]: unknown };
  const body = conteudo.body.map((b) => ctaBlock(b) ?? (b as unknown as Block));
  const tipos = conteudo.body.map((b) => b.t);

  it('começa pelo botão do PDF, grátis e sem cadastro, do arquivo que já existe', () => {
    expect(tipos[0]).toBe('pdf');
    expect(conteudo.body[0]!.href).toBe('/guias/roma-em-3-dias.pdf');
    expect(readFileSync(new URL('../public/guias/roma-em-3-dias.pdf', import.meta.url)).subarray(0, 5).toString()).toBe('%PDF-');
  });
  it('tem passagem antes do roteiro e no fim, 3 passeios (um por dia), contato no fim e nenhum carro', () => {
    const iDia1 = conteudo.body.findIndex((b) => b.t === 'h' && b.label === 'Dia 1');
    expect(conteudo.body.findIndex((b) => b.t === 'whatsapp')).toBeLessThan(iDia1);
    expect(tipos.filter((t) => t === 'whatsapp')).toHaveLength(2);
    expect(tipos.indexOf('contato')).toBeGreaterThan(tipos.lastIndexOf('passeio'));
    expect(tipos.filter((t) => t === 'passeio')).toHaveLength(3);
    expect(tipos).not.toContain('carro');
    // cada passeio vem logo antes do título do dia seguinte (ou da seção "Como se locomover")
    for (const [i, t] of tipos.entries()) if (t === 'passeio') expect(conteudo.body[i + 1]!.t).toBe('h');
    expect(tipos.filter((t) => t === 'afiliado').length).toBeGreaterThanOrEqual(1);
  });
  it('fotos: capa e cada foto existem no site, pesam menos de 250 KB e têm alt, legenda e crédito do Unsplash', () => {
    const arq = (u: string) => new URL(`../public${u}`, import.meta.url);
    for (const u of [conteudo.coverUrl as string, conteudo.coverUrlSmall as string]) { expect(existsSync(arq(u))).toBe(true); expect(statSync(arq(u)).size).toBeLessThan(250_000); }
    expect(String(conteudo.coverAlt).length).toBeGreaterThan(20);
    const fotos = conteudo.body.filter((b) => b.t === 'img') as Array<Record<string, unknown>>;
    expect(fotos.length).toBeGreaterThanOrEqual(5);
    for (const f of fotos) {
      expect(existsSync(arq(String(f.src)))).toBe(true);
      expect(statSync(arq(String(f.src))).size).toBeLessThan(250_000);
      expect(String(f.alt).length).toBeGreaterThan(20);
      expect(String(f.caption).length).toBeGreaterThan(5);
      expect(f.credit).toMatch(/^Foto: .+ \/ Unsplash$/);
      expect(f.w).toBeTypeOf('number'); expect(f.h).toBeTypeOf('number');
    }
    expect(new Set(fotos.map((f) => f.src)).size).toBe(fotos.length);
  });
  it('nenhuma foto entre o botão do PDF e o primeiro botão de passagem (WhatsApp)', () => {
    expect(tipos.slice(0, tipos.indexOf('whatsapp')).includes('img')).toBe(false);
  });
  it('não tem travessão nem preço de passeio, e destaca estimativas como da Rota Certa', () => {
    const texto = JSON.stringify(conteudo);
    expect(texto).not.toMatch(/—|--/);
    const passeios = JSON.stringify(conteudo.body.filter((b) => b.t === 'passeio'));
    expect(passeios).not.toMatch(/R\$|€|\d+,\d\d/);
    expect(texto).toContain('Estimativa da Rota Certa, não é dado oficial');
  });
  it('desenha em produção sem passeios e sem aviso, e na prévia com 3 inativos', () => {
    const producao = renderBlocks(body, ctx(), true);
    expect(producao).not.toContain('Passeios no');
    expect(producao).not.toContain('aviso-afiliado');
    expect(producao).not.toContain('Inativo');
    expect(producao).toContain('cta-whatsapp');
    expect(producao).toContain('cta-contato');
    const previa = renderBlocks(body, ctx({ preview: true }), true);
    expect(previa.match(/cta-inativo/g)).toHaveLength(3);
    expect(previa.match(/aviso-afiliado/g)).toHaveLength(2);
  });
});

describe('guia de Madri (content/guias/madri-em-4-dias.json)', () => {
  const conteudo = JSON.parse(readFileSync(new URL('../content/guias/madri-em-4-dias.json', import.meta.url), 'utf8')) as { body: Record<string, unknown>[]; [k: string]: unknown };
  const tipos = conteudo.body.map((b) => b.t);
  const arq = (u: string) => new URL(`../public${u}`, import.meta.url);
  it('começa pelo PDF que já existe, tem WhatsApp antes do roteiro e no fim, 4 passeios (um por dia), contato no fim e nenhum carro', () => {
    expect(tipos[0]).toBe('pdf');
    expect(conteudo.body[0]!.href).toBe('/guias/madri-em-4-dias.pdf');
    expect(readFileSync(arq('/guias/madri-em-4-dias.pdf')).subarray(0, 5).toString()).toBe('%PDF-');
    expect(conteudo.body.findIndex((b) => b.t === 'whatsapp')).toBeLessThan(conteudo.body.findIndex((b) => b.t === 'h' && b.label === 'Dia 1'));
    expect(tipos.filter((t) => t === 'whatsapp')).toHaveLength(2);
    expect(tipos.filter((t) => t === 'passeio')).toHaveLength(4);
    expect(tipos.indexOf('contato')).toBeGreaterThan(tipos.lastIndexOf('passeio'));
    expect(tipos).not.toContain('carro');
    expect(tipos.slice(0, tipos.indexOf('whatsapp')).includes('img')).toBe(false);
  });
  it('fotos: existem, pesam menos de 250 KB e têm alt, legenda e crédito do Pexels; sem foto com letreiro de marca', () => {
    for (const u of [conteudo.coverUrl as string, conteudo.coverUrlSmall as string]) { expect(existsSync(arq(u))).toBe(true); expect(statSync(arq(u)).size).toBeLessThan(250_000); }
    const fotos = conteudo.body.filter((b) => b.t === 'img') as Array<Record<string, unknown>>;
    expect(fotos).toHaveLength(6);
    for (const f of fotos) {
      expect(statSync(arq(String(f.src))).size).toBeLessThan(250_000);
      expect(String(f.alt).length).toBeGreaterThan(20);
      expect(String(f.caption).length).toBeGreaterThan(5);
      expect(f.credit).toMatch(/^Foto: .+ \/ Pexels$/);
    }
    expect(new Set(fotos.map((f) => f.src)).size).toBe(fotos.length);
    expect(JSON.stringify(conteudo)).not.toMatch(/gran-via\.jpg|madri-capa/);
  });
  it('não tem travessão nem preço nos passeios, e a frase do Palácio Real segue a fonte oficial', () => {
    const texto = JSON.stringify(conteudo);
    expect(texto).not.toMatch(/—|--/);
    expect(JSON.stringify(conteudo.body.filter((b) => b.t === 'passeio'))).not.toMatch(/R\$|€|\d+,\d\d/);
    expect(texto).toContain('cidadãos latino-americanos, entre eles brasileiros, com documento de nacionalidade');
    expect(texto).not.toContain('Brasileiro entra de graça');
    expect(texto).toContain('Reina Sofía');
    expect(texto).toMatch(/fecha às terças/i);
  });
});

describe('guia de Buenos Aires (content/guias/buenos-aires-em-3-dias.json)', () => {
  const conteudo = JSON.parse(readFileSync(new URL('../content/guias/buenos-aires-em-3-dias.json', import.meta.url), 'utf8')) as { body: Record<string, unknown>[]; [k: string]: unknown };
  const body = conteudo.body.map((b) => ctaBlock(b) ?? (b as unknown as Block));
  const tipos = conteudo.body.map((b) => b.t);

  it('começa pelo botão do PDF do arquivo que já existe, com passagem antes do roteiro e contato no fim, sem carro', () => {
    expect(tipos[0]).toBe('pdf');
    expect(conteudo.body[0]!.href).toBe('/guias/buenos-aires-em-3-dias.pdf');
    expect(readFileSync(new URL('../public/guias/buenos-aires-em-3-dias.pdf', import.meta.url)).subarray(0, 5).toString()).toBe('%PDF-');
    const iDia1 = conteudo.body.findIndex((b) => b.t === 'h' && String(b.label).startsWith('Dia 1'));
    expect(conteudo.body.findIndex((b) => b.t === 'whatsapp')).toBeLessThan(iDia1);
    expect(tipos.filter((t) => t === 'whatsapp')).toHaveLength(2);
    expect(tipos.indexOf('contato')).toBeGreaterThan(tipos.lastIndexOf('passeio'));
    expect(tipos.filter((t) => t === 'passeio')).toHaveLength(3);
    expect(tipos).not.toContain('carro');
    for (const [i, t] of tipos.entries()) if (t === 'passeio') expect(conteudo.body[i + 1]!.t).toBe('h');
  });
  it('fotos: existem no site, pesam menos de 250 KB e têm alt, legenda e crédito do Pexels; nenhuma antes do primeiro CTA', () => {
    const arq = (u: string) => new URL(`../public${u}`, import.meta.url);
    for (const u of [conteudo.coverUrl as string, conteudo.coverUrlSmall as string]) { expect(existsSync(arq(u))).toBe(true); expect(statSync(arq(u)).size).toBeLessThan(250_000); }
    const fotos = conteudo.body.filter((b) => b.t === 'img') as Array<Record<string, unknown>>;
    expect(fotos).toHaveLength(5);
    for (const f of fotos) {
      expect(existsSync(arq(String(f.src)))).toBe(true);
      expect(statSync(arq(String(f.src))).size).toBeLessThan(250_000);
      expect(String(f.alt).length).toBeGreaterThan(20);
      expect(String(f.caption).length).toBeGreaterThan(5);
      expect(f.credit).toMatch(/^Foto: .+ \/ Pexels$/);
    }
    expect(tipos.slice(0, tipos.indexOf('whatsapp')).includes('img')).toBe(false);
  });
  it('não tem travessão nem preço em pesos, e em produção não mostra passeios nem aviso', () => {
    const texto = JSON.stringify(conteudo);
    expect(texto).not.toMatch(/—|--/);
    expect(JSON.stringify(conteudo.body)).not.toMatch(/ARS|\$ ?\d|pesos? argentinos? \d/);
    expect(JSON.stringify(conteudo.body.filter((b) => b.t === 'passeio'))).not.toMatch(/R\$|€|\d+,\d\d/);
    const producao = renderBlocks(body, ctx({ destino: 'Buenos Aires', campanha: 'buenos-aires' }), true);
    expect(producao).not.toContain('Passeios em');
    expect(producao).not.toContain('aviso-afiliado');
    expect(renderBlocks(body, ctx({ preview: true, destino: 'Buenos Aires', campanha: 'buenos-aires' }), true).match(/cta-inativo/g)).toHaveLength(3);
  });
});
describe('guia de Lisboa (content/guias/guia-lisboa-em-3-dias.json)', () => {
  const conteudo = JSON.parse(readFileSync(new URL('../content/guias/guia-lisboa-em-3-dias.json', import.meta.url), 'utf8')) as { body: Record<string, unknown>[]; [k: string]: unknown };
  const body = conteudo.body.map((b) => ctaBlock(b) ?? (b as unknown as Block));
  const tipos = conteudo.body.map((b) => b.t);

  it('não usa o slug do post antigo e começa pelo PDF que já está no ar', () => {
    expect(conteudo.slug).toBe('guia-lisboa-em-3-dias');
    expect(conteudo.slug).not.toBe('lisboa-em-3-dias');
    expect(tipos[0]).toBe('pdf');
    expect(conteudo.body[0]!.href).toBe('/guias/lisboa-em-3-dias.pdf');
    expect(readFileSync(new URL('../public/guias/lisboa-em-3-dias.pdf', import.meta.url)).subarray(0, 5).toString()).toBe('%PDF-');
  });
  it('mesma ordem de botões de Roma: passagem antes do roteiro e no fim, 3 passeios, contato no fim, sem carro', () => {
    const iDia1 = conteudo.body.findIndex((b) => b.t === 'h' && b.label === 'Dia 1');
    expect(tipos.indexOf('whatsapp')).toBeLessThan(iDia1);
    expect(tipos.filter((t) => t === 'whatsapp')).toHaveLength(2);
    expect(tipos.indexOf('contato')).toBeGreaterThan(tipos.lastIndexOf('passeio'));
    expect(tipos.filter((t) => t === 'passeio')).toHaveLength(3);
    expect(tipos).not.toContain('carro');
    for (const [i, t] of tipos.entries()) if (t === 'passeio') expect(conteudo.body[i + 1]!.t).toBe('h');
    expect(tipos.slice(0, tipos.indexOf('whatsapp')).includes('img')).toBe(false);
  });
  it('fotos existem, pesam menos de 250 KB e têm alt, legenda e crédito do Pexels, no máximo 2 por dia', () => {
    const arq = (u: string) => new URL(`../public${u}`, import.meta.url);
    for (const u of [conteudo.coverUrl as string, conteudo.coverUrlSmall as string]) { expect(existsSync(arq(u))).toBe(true); expect(statSync(arq(u)).size).toBeLessThan(250_000); }
    const fotos = conteudo.body.filter((b) => b.t === 'img') as Array<Record<string, unknown>>;
    expect(fotos).toHaveLength(5);
    for (const f of fotos) {
      expect(existsSync(arq(String(f.src)))).toBe(true);
      expect(statSync(arq(String(f.src))).size).toBeLessThan(250_000);
      expect(String(f.alt).length).toBeGreaterThan(20);
      expect(String(f.caption).length).toBeGreaterThan(5);
      expect(f.credit).toMatch(/^Foto: .+ \/ Pexels$/);
    }
    let porDia = 0;
    for (const b of conteudo.body) { if (b.t === 'h') porDia = 0; if (b.t === 'img') expect(++porDia).toBeLessThanOrEqual(2); }
  });
  it('sem travessão nem preço de passeio, e guarda os fatos não óbvios do guia', () => {
    const texto = JSON.stringify(conteudo);
    expect(texto).not.toMatch(/—|--/);
    expect(JSON.stringify(conteudo.body.filter((b) => b.t === 'passeio'))).not.toMatch(/R\$|€|\d+,\d\d/);
    for (const trecho of ['reabriu em maio de 2026', '€ 45', 'não há tolerância de atraso', 'EES', 'ETIAS', 'não fixa o preço do trem']) expect(texto).toContain(trecho);
    expect(texto).not.toMatch(/aluguel de carro|alugar um carro/i);
  });
  it('desenha em produção sem passeios e na prévia com 3 inativos', () => {
    const producao = renderBlocks(body, ctx({ destino: 'Lisboa', campanha: 'lisboa' }), true);
    expect(producao).not.toContain('Passeios em');
    expect(producao).not.toContain('Inativo');
    expect(renderBlocks(body, ctx({ preview: true }), true).match(/cta-inativo/g)).toHaveLength(3);
  });
});

describe('guia de Paris (content/guias/paris-em-4-dias.json)', () => {
  const conteudo = JSON.parse(readFileSync(new URL('../content/guias/paris-em-4-dias.json', import.meta.url), 'utf8')) as { body: Record<string, unknown>[]; [k: string]: unknown };
  const body = conteudo.body.map((b) => ctaBlock(b) ?? (b as unknown as Block));
  const tipos = conteudo.body.map((b) => b.t);
  const arq = (u: string) => new URL(`../public${u}`, import.meta.url);

  it('começa pelo botão do PDF que já existe e tem passagem antes do roteiro e no fim, 4 passeios, contato no fim e nenhum carro', () => {
    expect(tipos[0]).toBe('pdf');
    expect(conteudo.body[0]!.href).toBe('/guias/paris-em-4-dias.pdf');
    expect(readFileSync(arq('/guias/paris-em-4-dias.pdf')).subarray(0, 5).toString()).toBe('%PDF-');
    expect(conteudo.body.findIndex((b) => b.t === 'whatsapp')).toBeLessThan(conteudo.body.findIndex((b) => b.t === 'h' && b.label === 'Dia 1'));
    expect(tipos.filter((t) => t === 'whatsapp')).toHaveLength(2);
    expect(tipos.indexOf('contato')).toBeGreaterThan(tipos.lastIndexOf('passeio'));
    expect(tipos.filter((t) => t === 'passeio')).toHaveLength(4);
    expect(tipos).not.toContain('carro');
    for (const [i, t] of tipos.entries()) if (t === 'passeio') expect(conteudo.body[i + 1]!.t).toBe('h');
  });
  it('fotos: existem, pesam menos de 250 KB, têm alt, legenda e crédito do Pexels; nenhuma antes do primeiro WhatsApp; no máximo 2 por dia', () => {
    for (const u of [conteudo.coverUrl as string, conteudo.coverUrlSmall as string]) { expect(existsSync(arq(u))).toBe(true); expect(statSync(arq(u)).size).toBeLessThan(250_000); }
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
    expect(tipos.slice(0, tipos.indexOf('whatsapp')).includes('img')).toBe(false);
    let dia = 0; const porDia: number[] = [];
    for (const b of conteudo.body) { if (b.t === 'h') { dia += 1; porDia[dia] = 0; } else if (b.t === 'img' && dia > 0) porDia[dia]! += 1; }
    expect(Math.max(...porDia.filter((n) => n !== undefined))).toBeLessThanOrEqual(2);
  });
  it('sem travessão, sem preço no passeio, com os fatos não óbvios do guia e link para o post antigo de Paris', () => {
    const texto = JSON.stringify(conteudo);
    expect(texto).not.toMatch(/—|--/);
    expect(JSON.stringify(conteudo.body.filter((b) => b.t === 'passeio'))).not.toMatch(/R\$|€|\d+,\d\d/);
    expect(texto).toContain('Estimativa da Rota Certa, não é dado oficial');
    expect(texto).toContain('€ 32');
    expect(texto).toContain('reserva obrigatória de 17/10 a 1/11/2026');
    expect(texto).toContain('ETIAS');
    expect(texto).toContain('/blog/paris-primeira-viagem');
    expect(conteudo.slug).toBe('paris-em-4-dias');
  });
  it('desenha em produção sem passeios e sem aviso, e na prévia com 4 inativos', () => {
    const producao = renderBlocks(body, ctx({ destino: 'Paris', campanha: 'paris' }), true);
    expect(producao).not.toContain('Passeios na');
    expect(producao).not.toContain('aviso-afiliado');
    expect(producao).not.toContain('Inativo');
    const previa = renderBlocks(body, ctx({ preview: true, destino: 'Paris', campanha: 'paris' }), true);
    expect(previa.match(/cta-inativo/g)).toHaveLength(4);
    expect(previa.match(/aviso-afiliado/g)).toHaveLength(2);
  });
});

/** Extrai os href dos <a> do HTML, em ordem (sem depender de DOM no Node). */
class DOMParserLike {
  constructor(private readonly html: string) {}
  hrefs() { return [...this.html.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1]!.replace(/&amp;/g, '&')); }
}
