// Carteira de milhas: transforma o texto de um e-mail de programa (Livelo, Smiles, Esfera, LATAM Pass...) num evento
// simples (clube creditou, pagamento do clube falhou, clube cancelado, saldo). Função pura: não lê rede nem banco.
// Quem sincroniza a caixa do Gmail é tools/miles-mail-sync.mjs; quem aplica o evento é worker/finance-wallet.ts.

export type WalletEventKind = 'club_credited' | 'club_payment_ok' | 'club_payment_failed' | 'club_canceled' | 'balance';

export interface WalletMailInput {
  id: string;
  from: string;
  subject: string;
  /** Instante do e-mail em ISO 8601. */
  date: string;
  text: string;
}

export interface WalletMailEvent {
  sourceId: string;
  kind: WalletEventKind;
  program: string;
  holderHint: string | null;
  memberNumber: string | null;
  miles: number | null;
  balance: number | null;
  /** Instante a que o saldo se refere (o e-mail pode citar o saldo de um dia antes dele). null = o próprio instante do e-mail. */
  balanceAt?: string | null;
  planName: string | null;
  monthlyCostCents: number | null;
  occurredAt: string;
  subject: string;
}

export const PROGRAMS = ['LATAM Pass', 'Smiles', 'Livelo', 'Azul Fidelidade', 'Esfera', 'All Accor', 'Ibéria', 'Rakuten', 'True Blue'] as const;

const SENDER_PROGRAMS: Array<[RegExp, string]> = [
  [/livelo|pontolivelo/i, 'Livelo'],
  [/smiles\.com\.br/i, 'Smiles'],
  [/esfera\.com\.vc/i, 'Esfera'],
  [/latampass|latam\.com/i, 'LATAM Pass'],
  [/voeazul|tudoazul|azulfidelidade/i, 'Azul Fidelidade'],
  [/all\.com|accor/i, 'All Accor'],
];

const flat = (value: string) => value.replace(/[   ]/g, ' ').replace(/\s+/g, ' ').trim();
const plain = (value: string) => flat(value).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** "7.230", "33,500" e "556151" viram número inteiro; texto sem dígitos vira null. */
export function parseMiles(value: string | undefined | null): number | null {
  const digits = (value ?? '').replace(/\D/g, '');
  if (!digits) return null;
  const n = Number(digits);
  return Number.isSafeInteger(n) ? n : null;
}
/** "R$ 44,90" ou "356,80" viram centavos (4490, 35680). */
export function parseMoneyCents(value: string | undefined | null): number | null {
  const m = (value ?? '').match(/(\d{1,3}(?:\.\d{3})*|\d+),(\d{2})/);
  if (!m) return null;
  return Number(m[1]!.replace(/\./g, '')) * 100 + Number(m[2]);
}

export function programOfSender(from: string): string | null {
  for (const [pattern, program] of SENDER_PROGRAMS) if (pattern.test(from)) return program;
  return null;
}

function holderOf(text: string): string | null {
  const notNames = new Set(['seu', 'seus', 'sua', 'suas', 'voce', 'você', 'pontos', 'tudo', 'pode', 'que']);
  for (const m of text.matchAll(/(?:Ol[áa]|Oba|Oi),?\s+\*?([\p{L}]{2,})/gu)) {
    const word = m[1]!;
    if (notNames.has(word.toLowerCase())) continue;
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }
  return null;
}

function balanceOf(text: string, program: string): number | null {
  let m: RegExpMatchArray | null;
  if (program === 'Livelo') {
    m = text.match(/Total de pontos:\s*([\d.]+)/i) ?? text.match(/Saldo em \d{2}\/\d{2}\/\d{4}\s*([\d.]+)\s*pts/i);
  } else if (program === 'Smiles') {
    m = text.match(/Saldo de milhas\s*([\d.,]+)/i) ?? text.match(/Saldo em \d{2}\/\d{2}\s*:\s*([\d.,]+)\s*milhas/i);
  } else if (program === 'LATAM Pass') {
    m = text.match(/voc[êe] tem\s*([\d.]+)\s*milhas/i) ?? text.match(/Milhas:\s*([\d.]+)/i);
  } else {
    m = text.match(/Saldo[^\d]{0,30}([\d.]{3,})\s*(?:pts|pontos|milhas)/i);
  }
  return parseMiles(m?.[1]);
}

/** Data citada junto do saldo ("Saldo em 23/10/2026", "Saldo em 06/10 :"); sem data, o saldo vale na hora do e-mail. */
function balanceDateOf(text: string, program: string, emailDate: Date): string | null {
  // O "Total de pontos" depois do crédito do clube é do momento do e-mail, não do "Saldo em ..." do cabeçalho.
  if (program === 'Livelo' && /Total de pontos:/i.test(text)) return null;
  const m = text.match(/Saldo em (\d{2})\/(\d{2})(?:\/(\d{4}))?/i);
  if (!m) return null;
  const year = m[3] ? Number(m[3]) : emailDate.getUTCFullYear();
  const at = new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[1]), 12));
  return Number.isNaN(at.getTime()) || at > emailDate ? null : at.toISOString();
}

/** Devolve o evento do e-mail ou null quando não é assunto de clube ou saldo de um programa conhecido. */
export function parseWalletMail(mail: WalletMailInput): WalletMailEvent | null {
  const program = programOfSender(mail.from);
  if (!program) return null;
  const text = flat(mail.text);
  const subject = flat(mail.subject);
  const haystack = plain(`${subject} ${text}`);
  const mentionsClub = haystack.includes('clube');

  let kind: WalletEventKind | null = null;
  // "pode ser cancelado em breve" é aviso de pagamento, não cancelamento: só vale "foi cancelad(o/a)" e "cancelamento da sua assinatura".
  if (mentionsClub && /(assinatura|plano|clube)[^.]{0,60}foi cancelad|cancelamento da sua assinatura/.test(haystack)) kind = 'club_canceled';
  else if (mentionsClub && /nao identificamos pagamento|pagamento (do seu clube )?(\w+ )?nao (foi )?(realizado|concluido)|imprevisto com o pagamento|ultima chance para manter|pode ser cancelado em breve|falha na validacao do seu cartao/.test(haystack)) kind = 'club_payment_failed';
  else if (mentionsClub && /mensalidade foi aprovada|pagamento foi aprovado/.test(haystack)) kind = 'club_payment_ok';
  else if (mentionsClub && !/conte pra gente/.test(haystack) && /pontos( bonus)?( do clube( \w+)?| \w+)? (ja )?chegaram|pontos do seu clube \w* ?ja estao disponiveis/.test(haystack)) kind = 'club_credited';

  const balance = balanceOf(text, program);
  if (!kind) {
    if (balance === null) return null;
    kind = 'balance';
  }

  const plan = text.match(/\[\s*(Clube [^\]]+?)\s*\]/i)?.[1] ?? text.match(/Plano:\s*(.+?)\s*Valor do Plano/i)?.[1] ?? text.match(/(Clube Smiles [\d.]+)/i)?.[1] ?? null;
  const cost = text.match(/Valor mensal:\s*R?\$?\s*([\d.,]+)/i)?.[1] ?? text.match(/Valor d[oa] plano:?\s*R?\$?\s*([\d.,]+)/i)?.[1];
  const credited = text.match(/Pontos creditados:\s*([\d.]+)/i)?.[1] ?? text.match(/Os\s+([\d.]+)\s+pontos do seu Clube/i)?.[1] ?? text.match(/Milhas Mensais:\s*(\d+)/i)?.[1];
  const date = new Date(mail.date);

  return {
    sourceId: mail.id,
    kind,
    program,
    holderHint: holderOf(text),
    memberNumber: text.match(/N[úu]mero Smiles:?\s*(\d{6,})/i)?.[1] ?? text.match(/N[°ºo]\s*LATAM Pass:\s*([\d*]{6,})/i)?.[1] ?? null,
    miles: parseMiles(credited),
    balance,
    balanceAt: balance === null || Number.isNaN(date.getTime()) ? null : balanceDateOf(text, program, date),
    planName: plan ? plan.slice(0, 80) : null,
    monthlyCostCents: parseMoneyCents(cost),
    occurredAt: Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString(),
    subject: subject.slice(0, 200),
  };
}
