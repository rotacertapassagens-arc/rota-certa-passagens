/**
 * Layout de marca dos e-mails transacionais da Rota Certa Passagens.
 *
 * Um ponto só: o sendEmail() do Worker passa o corpo de cada mensagem (hoje só <p>, <strong> e <a>)
 * por emailLayout(), que devolve o documento HTML completo: cabeçalho marinho com o logo, título,
 * conteúdo num cartão branco e rodapé com os contatos. As mensagens não são reescritas aqui.
 *
 * Feito para clientes de e-mail (Gmail, Outlook, Apple Mail): tabelas, CSS inline, largura máxima
 * de 600 px, sem JavaScript e sem fonte web. O <style> do <head> só acrescenta o que é opcional
 * (telas estreitas e modo escuro); sem ele o e-mail continua legível.
 *
 * Dois atributos opcionais no corpo da mensagem ligam os destaques:
 *   <a data-cta href="...">Texto</a>        vira o botão dourado (a ação principal do e-mail)
 *   <strong data-code>123456</strong>       vira a caixa do código de ativação
 * O destaque sai do parágrafo e ocupa uma linha própria. O texto que vinha antes continua como
 * parágrafo; o que sobra depois continua também, a não ser que seja só pontuação (o ponto final
 * que fechava a frase), que deixa de fazer sentido depois de um botão ou de uma caixa.
 *
 * Módulo puro (sem banco nem rede), para o Worker, a prévia e os testes usarem a mesma fonte.
 */

export interface EmailLayoutOptions {
  /** Origem pública do site (APP_ORIGIN). Usada no logo e no link do cabeçalho. */
  origin: string;
  /** Título acima do conteúdo, em geral o assunto. Texto puro: é escapado aqui. */
  title?: string;
  /**
   * Texto de prévia (preheader), em geral a versão em texto da mensagem. Texto puro: é escapado
   * aqui. Sem ele, a prévia sai do começo do próprio conteúdo.
   */
  preheader?: string;
  /** Ano do rodapé. Padrão: o ano corrente. */
  year?: number;
}

export const EMAIL_CONTACT = 'contato@rotacertapassagens.com';
export const EMAIL_INSTAGRAM_URL = 'https://instagram.com/rotacerta.passagens/';

const NAVY = '#0D1B2A';
const BLUE = '#1B4965';
const GOLD = '#D4AF37';
const OFF_WHITE = '#F4F4F4';
const SANS = 'Arial,Helvetica,sans-serif';
const SERIF = "Georgia,'Times New Roman',serif";
const MONO = "'Courier New',Courier,monospace";
const PREHEADER_MAX = 150;

const CTA_RE = /<a\b[^>]*\sdata-cta\b[^>]*>[\s\S]*?<\/a>/i;
const CODE_RE = /<strong\b[^>]*\sdata-code\b[^>]*>[\s\S]*?<\/strong>/i;
const HIGHLIGHT_RE = new RegExp(`${CTA_RE.source}|${CODE_RE.source}`, 'i');
const HIGHLIGHT_ALL_RE = new RegExp(HIGHLIGHT_RE.source, 'gi');
/** Sobra de frase depois de um destaque: só espaço, pontuação ou quebra de linha. */
const ONLY_PUNCTUATION_RE = /^(?:\s|[.!:;,]|<br\s*\/?>)*$/i;

function escapeText(value: string) {
  return value.replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' } as Record<string, string>)[c]!);
}

function stripTags(html: string) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function paragraph(inner: string) {
  return `<p class="rc-text" style="margin:0 0 16px 0;font-family:${SANS};font-size:16px;line-height:24px;color:${NAVY};">${inner.trim()}</p>`;
}

/** Botão "à prova de Outlook": a área clicável vem das bordas, que o Outlook respeita (padding em <a> ele ignora). */
function button(href: string, label: string) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding:8px 0 24px 0;">`
    + `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" bgcolor="${GOLD}" style="background-color:${GOLD};border-radius:8px;">`
    + `<a href="${href}" target="_blank" style="display:inline-block;background-color:${GOLD};border-top:13px solid ${GOLD};border-bottom:13px solid ${GOLD};border-left:28px solid ${GOLD};border-right:28px solid ${GOLD};border-radius:8px;font-family:${SANS};font-size:16px;line-height:20px;font-weight:bold;color:${NAVY};text-decoration:none;">${label}</a>`
    + `</td></tr></table></td></tr></table>`;
}

function codeBox(code: string) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:4px 0 20px 0;">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" bgcolor="${OFF_WHITE}" class="rc-codebox" style="background-color:${OFF_WHITE};border:1px solid ${GOLD};border-radius:8px;padding:18px 8px 18px 16px;">`
    + `<span class="rc-code" style="font-family:${MONO};font-size:34px;line-height:40px;font-weight:bold;letter-spacing:8px;color:${NAVY};">${code}</span>`
    + `</td></tr></table></td></tr></table>`;
}

function highlight(tag: string) {
  const inner = tag.replace(/^<[^>]+>/, '').replace(/<\/[a-z]+>$/i, '').trim();
  if (/^<strong/i.test(tag)) return codeBox(inner);
  const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
  // Sem destino não há botão: volta a ser um link comum, sem o atributo.
  if (!href) return paragraph(tag.replace(/\sdata-cta\b(?:="[^"]*")?/i, ''));
  return button(href[1] ?? href[2] ?? '', inner);
}

function renderParagraph(inner: string): string {
  const match = HIGHLIGHT_RE.exec(inner);
  if (!match) return paragraph(inner);
  const before = inner.slice(0, match.index);
  const after = inner.slice(match.index + match[0].length);
  return (stripTags(before) ? paragraph(before) : '') + highlight(match[0]) + (ONLY_PUNCTUATION_RE.test(after) ? '' : renderParagraph(after));
}

function renderBody(htmlBody: string) {
  return htmlBody
    .replace(/<p>([\s\S]*?)<\/p>/gi, (_all, inner: string) => renderParagraph(inner))
    // Destaque fora de <p> (não acontece nas mensagens atuais) também vira botão ou caixa.
    .replace(HIGHLIGHT_ALL_RE, (tag) => highlight(tag))
    // Links comuns, no meio do texto: cor da marca. O botão já tem estilo próprio e fica de fora.
    .replace(/<a\b(?![^>]*\sstyle\s*=)/gi, `<a class="rc-link" style="color:${BLUE};text-decoration:underline;"`);
}

/**
 * Monta o texto de prévia com frases inteiras, até caber. Para na primeira frase que traz um
 * endereço (um link cru não ajuda na prévia). Se nem a primeira frase couber ou se ela já trouxer o
 * endereço, usa o começo dela.
 */
function previewFrom(units: string[]) {
  let out = '';
  for (const raw of units) {
    const unit = raw.replace(/\s+/g, ' ').trim();
    if (!unit) continue;
    const url = unit.search(/https?:\/\//);
    if (url >= 0) { if (!out) out = unit.slice(0, url).replace(/[\s:;,]+$/, ''); break; }
    const next = out ? `${out} ${unit}` : unit;
    if (next.length > PREHEADER_MAX) {
      if (!out) { const cut = unit.slice(0, PREHEADER_MAX); out = `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 1))}...`; }
      break;
    }
    out = next;
  }
  return out;
}

function preheaderBlock(htmlBody: string, preheader: string | undefined) {
  const fromText = preheader?.trim();
  const preview = fromText
    ? escapeText(previewFrom(fromText.split(/(?<=[.!?])\s+/)))
    : previewFrom(htmlBody.split(/<\/p>/i).map(stripTags)); // já vem escapado do próprio HTML
  if (!preview) return '';
  // O enchimento invisível impede que o cliente complete a prévia com o texto do cabeçalho. Só entra
  // quando a mensagem tem versão em texto própria: sem ela, o provedor gera o texto a partir deste
  // HTML e o enchimento viraria sujeira lá.
  const filler = fromText ? '&#847;&zwnj;&nbsp;'.repeat(60) : '';
  return `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;color:${OFF_WHITE};">${preview}${filler}</div>`;
}

export function emailLayout(htmlBody: string, options: EmailLayoutOptions): string {
  const origin = escapeText(options.origin.replace(/\/+$/, ''));
  const title = options.title?.trim() ? escapeText(options.title.trim()) : '';
  const year = options.year ?? new Date().getFullYear();
  const instagramLabel = 'Instagram @rotacerta.passagens';
  return `<!doctype html>
<html lang="pt-BR" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${title || 'Rota Certa Passagens'}</title>
<style>
:root{color-scheme:light dark;supported-color-schemes:light dark}
@media (max-width:620px){
.rc-pad{padding-left:20px!important;padding-right:20px!important}
.rc-code{font-size:28px!important;letter-spacing:5px!important}
.rc-sep{display:none!important}
.rc-foot a{display:block!important}
}
@media (prefers-color-scheme:dark){
.rc-page{background-color:#08121C!important}
.rc-card{background-color:#13263A!important}
.rc-title,.rc-text,.rc-code{color:${OFF_WHITE}!important}
.rc-link{color:${GOLD}!important}
.rc-codebox{background-color:${NAVY}!important}
.rc-foot,.rc-foot a{color:#AAB6C2!important}
}
</style>
</head>
<body class="rc-page" style="margin:0;padding:0;background-color:${OFF_WHITE};">
${preheaderBlock(htmlBody, options.preheader)}
<table role="presentation" class="rc-page" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${OFF_WHITE}" style="background-color:${OFF_WHITE};">
<tr><td align="center" style="padding:24px 12px;">
<!--[if mso]><table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
<tr><td class="rc-pad" bgcolor="${NAVY}" style="background-color:${NAVY};padding:20px 32px;border-radius:12px 12px 0 0;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td width="48" valign="middle" style="padding-right:14px;"><a href="${origin}/" target="_blank" style="text-decoration:none;"><img src="${origin}/assets/logo-simbolo-claro.png" width="48" height="48" alt="" style="display:block;width:48px;height:48px;border:0;outline:none;"></a></td>
<td valign="middle" style="font-family:${SERIF};font-size:22px;line-height:28px;color:${OFF_WHITE};"><a href="${origin}/" target="_blank" style="color:${OFF_WHITE};text-decoration:none;">Rota Certa <span style="color:${GOLD};">Passagens</span></a></td>
</tr></table>
</td></tr>
<tr><td bgcolor="${GOLD}" height="3" style="background-color:${GOLD};height:3px;font-size:1px;line-height:3px;mso-line-height-rule:exactly;">&nbsp;</td></tr>
<tr><td class="rc-card rc-pad rc-text" bgcolor="#FFFFFF" style="background-color:#FFFFFF;padding:32px 32px 16px 32px;border-radius:0 0 12px 12px;font-family:${SANS};font-size:16px;line-height:24px;color:${NAVY};">
${title ? `<h1 class="rc-title" style="margin:0 0 20px 0;font-family:${SERIF};font-size:24px;line-height:30px;font-weight:normal;color:${NAVY};">${title}</h1>\n` : ''}${renderBody(htmlBody)}
</td></tr>
<tr><td class="rc-foot rc-pad" align="center" style="padding:24px 32px 8px 32px;font-family:${SANS};font-size:13px;line-height:20px;color:${BLUE};">
<a href="mailto:${EMAIL_CONTACT}" style="color:${BLUE};text-decoration:underline;white-space:nowrap;">${EMAIL_CONTACT}</a><span class="rc-sep"> &nbsp;&middot;&nbsp; </span><a href="${EMAIL_INSTAGRAM_URL}" target="_blank" style="color:${BLUE};text-decoration:underline;white-space:nowrap;">${instagramLabel}</a><br>
&copy; ${year} Rota Certa Passagens
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`;
}
