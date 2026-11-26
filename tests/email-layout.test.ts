/**
 * Layout de marca dos e-mails transacionais (shared/emailLayout.ts): o que envolve o corpo de cada
 * mensagem dentro do sendEmail() do Worker.
 */
import { describe, expect, it } from 'vitest';
import { emailLayout } from '../shared/emailLayout.js';

const ORIGIN = 'https://rotacertapassagens.com';
const render = (body: string, extra: { title?: string; preheader?: string } = {}) => emailLayout(body, { origin: ORIGIN, year: 2026, ...extra });
/** Só o cartão do conteúdo, sem cabeçalho, prévia nem rodapé. */
const card = (html: string) => html.slice(html.indexOf('class="rc-card'), html.indexOf('class="rc-foot'));

describe('emailLayout', () => {
  it('envolve o conteúdo com cabeçalho, título e rodapé da marca', () => {
    const html = render('<p>Olá, Maria.</p>', { title: 'Confirme seu e-mail' });
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain(`<img src="${ORIGIN}/assets/logo-simbolo-claro.png"`);
    expect(html).toContain('Rota Certa <span style="color:#D4AF37;">Passagens</span>');
    expect(html).toContain('>Confirme seu e-mail</h1>');
    expect(html).toContain('Olá, Maria.');
    expect(html).toContain('href="mailto:contato@rotacertapassagens.com"');
    expect(html).toContain('href="https://instagram.com/rotacerta.passagens/"');
    expect(html).toContain('&copy; 2026 Rota Certa Passagens');
    expect(html).toContain('max-width:600px');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain(String.fromCharCode(0x2014)); // sem travessão no que o layout acrescenta
  });

  it('não repete a barra quando a origem termina com "/"', () => {
    expect(emailLayout('<p>x</p>', { origin: `${ORIGIN}/` })).toContain(`src="${ORIGIN}/assets/logo-simbolo-claro.png"`);
  });

  it('transforma o link marcado com data-cta em botão dourado e tira o atributo', () => {
    const html = card(render('<p>Nova proposta.</p><p><a data-cta href="https://rotacertapassagens.com/admin.html">Abrir Central de Propostas</a></p>'));
    expect(html).toContain('bgcolor="#D4AF37"');
    expect(html).toMatch(/<a href="https:\/\/rotacertapassagens\.com\/admin\.html" target="_blank" style="[^"]*background-color:#D4AF37[^"]*">Abrir Central de Propostas<\/a>/);
    expect(html).not.toContain('data-cta');
    expect(html).not.toMatch(/<p[^>]*>\s*<\/p>/);
  });

  it('tira o botão do meio da frase, mantém o texto de antes e descarta só a pontuação que sobra', () => {
    const html = card(render('<p>É só tocar aqui: <a data-cta href="https://wa.me/351925307391?text=Ol%C3%A1&amp;x=1">Continuar atendimento pelo WhatsApp</a>.</p><p>Rota Certa Passagens</p>'));
    expect(html).toMatch(/<p [^>]*>É só tocar aqui:<\/p><table/);
    expect(html).toContain('href="https://wa.me/351925307391?text=Ol%C3%A1&amp;x=1"');
    expect(html).toMatch(/Continuar atendimento pelo WhatsApp<\/a><\/td><\/tr><\/table><\/td><\/tr><\/table><p [^>]*>Rota Certa Passagens<\/p>/);
  });

  it('mantém como parágrafo o texto que vem depois do destaque', () => {
    const html = card(render('<p>Código: <strong data-code>123456</strong> vale por 15 minutos.</p>'));
    expect(html).toMatch(/<p [^>]*>Código:<\/p>/);
    expect(html).toMatch(/<p [^>]*>vale por 15 minutos\.<\/p>/);
  });

  it('põe o código marcado com data-code numa caixa em destaque, com fonte monoespaçada', () => {
    const html = card(render('<p>Seu código de confirmação é <strong data-code>048213</strong>.</p><p>Ele expira em 10 minutos.</p>'));
    expect(html).toMatch(/<p [^>]*>Seu código de confirmação é<\/p>/);
    expect(html).toMatch(/<span class="rc-code" style="font-family:'Courier New',Courier,monospace;[^"]*">048213<\/span>/);
    expect(html).not.toContain('data-code');
    expect(html).toContain('Ele expira em 10 minutos.');
  });

  it('deixa <strong> e links comuns no texto, só com a cor da marca no link', () => {
    const html = card(render('<p>Protocolo: <strong>RC-2026-00042</strong></p><p>Digite-o em <a href="https://rotacertapassagens.com/master-invite.html">https://rotacertapassagens.com/master-invite.html</a>. Ele expira em 15 minutos.</p>'));
    expect(html).toContain('Protocolo: <strong>RC-2026-00042</strong>');
    expect(html).toContain('<a class="rc-link" style="color:#1B4965;text-decoration:underline;" href="https://rotacertapassagens.com/master-invite.html">');
    expect(html).not.toContain('bgcolor="#D4AF37"');
  });

  it('usa a versão em texto como prévia oculta, escapada e sem o endereço cru', () => {
    const html = render('<p>Olá.</p>', { preheader: 'Olá, <b>Maria</b> & cia. Protocolo: RC-2026-00042. O atendimento continua pelo WhatsApp: https://wa.me/351925307391?text=abc' });
    const preheader = /<div style="display:none;[^"]*">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
    expect(preheader.startsWith('Olá, &lt;b&gt;Maria&lt;/b&gt; &amp; cia. Protocolo: RC-2026-00042.')).toBe(true);
    expect(preheader).not.toContain('wa.me');
    expect(preheader).not.toContain('<b>');
  });

  it('corta a prévia antes do endereço quando a mensagem em texto é uma frase só', () => {
    const html = render('<p>Olá.</p>', { preheader: 'O seu voo GRU para LIS já está no seu Planner: https://rotacertapassagens.com/#/planner/itinerario' });
    expect(html).toMatch(/<div style="display:none;[^"]*">O seu voo GRU para LIS já está no seu Planner&#847;/);
  });

  it('sem versão em texto, tira a prévia do próprio conteúdo', () => {
    const html = render('<p>Olá, João.</p><p>Chegou uma nova indicação pelo seu link de parceiro.</p>');
    expect(html).toMatch(/<div style="display:none;[^"]*">Olá, João\. Chegou uma nova indicação pelo seu link de parceiro\.<\/div>/);
  });

  it('escapa o título', () => {
    expect(render('<p>x</p>', { title: 'Viagem <script>alert(1)</script>' })).not.toContain('<script>');
  });
});
