// Lê no Gmail os e-mails dos programas de milhas (Livelo, Smiles, Esfera, LATAM Pass, Azul, All) e transforma em eventos
// da carteira: clube creditou, pagamento do clube falhou, clube cancelado, saldo. Cada e-mail só conta uma vez (o servidor
// guarda o id da mensagem). Só lê a caixa; nunca apaga, move nem marca nada.
//
// Uso (na pasta do site):
//   npx tsx tools/miles-mail-sync/sync.mts --days 120 --dry-run        # só mostra o que achou
//   npx tsx tools/miles-mail-sync/sync.mts --days 3                    # manda para o painel (rotina de todo dia)
//   npx tsx tools/miles-mail-sync/sync.mts --days 120 --dry-run --out eventos.json
//
// Variáveis (ou arquivo .env indicado em MILES_SYNC_ENV; por padrão usa o .env do verificador da LATAM):
//   GMAIL_USER, GMAIL_APP_PASSWORD        senha de app do Google, não a senha normal
//   WALLET_API_URL                        padrão https://rotacertapassagens.com
//   ROTA_CERTA_SITE_API_TOKEN             token do servidor (o mesmo da rota interna do WHA-04)
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { parseWalletMail, type WalletMailEvent } from '../../shared/walletMail.js';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string, fallback: string) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1]! : fallback; };

function loadEnv(path: string) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
  }
}
loadEnv(process.env.MILES_SYNC_ENV ?? 'C:/Users/usuario05/Documents/Carlos/Claude/verificador-latam/.env');
loadEnv('.local/miles-sync.env');

// Domínios exatos: o filtro "from:" do Gmail casa a palavra inteira, então "latampass" não acha "latampassmail.com".
const SENDERS = [
  'latampassmail.com', 'info.latam.com', 'mails.latam.com', 'latam.com',
  'mail.infolivelo.com.br', 'mail.pontolivelo.com.br', 'livelofidelidade.com.br', 'livelo.com.br',
  'comunicado.smiles.com.br', 'smiles.com.br',
  'info.esfera.com.vc', 'esfera.com.vc',
  'voeazul.com.br', 'voeazul-news.com.br', 'tudoazul.com', 'info.voeazul.com.br',
  'all.com', 'confirmation.all.com', 'accor.com',
];
const recipientHolders = (process.env.MILES_RECIPIENT_HOLDERS ?? '').split(';').map((pair) => pair.split('=').map((part) => part.trim())).filter((pair): pair is [string, string] => Boolean(pair[0] && pair[1])).map(([address, holder]) => [address.toLowerCase(), holder] as [string, string]);
const days = Math.max(1, Number(option('days', '3')) || 3);
const dryRun = flag('dry-run');

const user = process.env.GMAIL_USER;
const pass = (process.env.GMAIL_APP_PASSWORD ?? '').replace(/\s+/g, '');
if (!user || !pass) { console.error('Faltam GMAIL_USER e GMAIL_APP_PASSWORD.'); process.exit(2); }

const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user, pass }, logger: false });
const events: WalletMailEvent[] = [];
let scanned = 0;
let skipped = 0;

await client.connect();
try {
  // "Todos os e-mails" inclui o que foi arquivado ou apagado da caixa de entrada.
  const lock = await client.getMailboxLock('[Gmail]/Todos os e-mails').catch(() => client.getMailboxLock('[Gmail]/All Mail'));
  try {
    const query = `from:(${SENDERS.join(' OR ')}) newer_than:${days}d`;
    const ids = (await client.search({ gmraw: query }, { uid: true })) || [];
    for await (const msg of client.fetch(ids, { uid: true, source: true, internalDate: true, emailId: true }, { uid: true })) {
      scanned += 1;
      const parsed = await simpleParser(msg.source as Buffer);
      const from = parsed.from?.text ?? '';
      const text = parsed.text ?? (typeof parsed.html === 'string' ? parsed.html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ') : '');
      const event = parseWalletMail({
        id: `gmail:${msg.emailId ?? msg.uid}`,
        from,
        subject: parsed.subject ?? '',
        date: (parsed.date ?? (msg.internalDate as Date | undefined) ?? new Date()).toISOString(),
        text,
      });
      if (!event) { skipped += 1; continue; }
      // E-mail sem saudação ("Olá, Fulano"): vale quem recebeu. MILES_RECIPIENT_HOLDERS="a@gmail.com=Carlos;b@gmail.com=Mateus".
      if (!event.holderHint) {
        const to = (parsed.to ? (Array.isArray(parsed.to) ? parsed.to.map((t) => t.text).join(',') : parsed.to.text) : '').toLowerCase();
        const owner = recipientHolders.find(([address]) => to.includes(address));
        if (owner) event.holderHint = owner[1];
      }
      events.push(event);
    }
  } finally { lock.release(); }
} finally { await client.logout().catch(() => undefined); }

// Dezenas de e-mails só de saldo (bilhetes, promoções) não ajudam: de cada programa/pessoa/conta fica só o saldo mais novo.
const latestBalance = new Map<string, WalletMailEvent>();
for (const e of events) {
  if (e.kind !== 'balance') continue;
  const key = `${e.program}|${e.holderHint}|${e.memberNumber}`;
  const current = latestBalance.get(key);
  if (!current || current.occurredAt < e.occurredAt) latestBalance.set(key, e);
}
const kept = events.filter((e) => e.kind !== 'balance' || latestBalance.get(`${e.program}|${e.holderHint}|${e.memberNumber}`) === e);
events.length = 0;
events.push(...kept);

console.log(`Gmail: ${scanned} e-mails dos programas nos últimos ${days} dias, ${events.length} viraram evento, ${skipped} ignorados (propaganda, viagem etc.).`);
const byKind: Record<string, number> = {};
for (const e of events) byKind[`${e.program} · ${e.kind}`] = (byKind[`${e.program} · ${e.kind}`] ?? 0) + 1;
for (const [key, count] of Object.entries(byKind).sort()) console.log(`  ${String(count).padStart(3)}  ${key}`);

const out = option('out', '');
if (out) writeFileSync(out, JSON.stringify(events, null, 2));
if (dryRun || events.length === 0) {
  if (dryRun) console.log('Teste: nada foi enviado ao painel.');
  process.exit(0);
}

const base = (process.env.WALLET_API_URL ?? 'https://rotacertapassagens.com').replace(/\/$/, '');
const token = process.env.ROTA_CERTA_SITE_API_TOKEN;
if (!token) { console.error('Falta ROTA_CERTA_SITE_API_TOKEN para enviar ao painel.'); process.exit(2); }
const total = { created: 0, applied: 0, unmatched: 0, invalid: 0 };
for (let i = 0; i < events.length; i += 100) {
  const response = await fetch(`${base}/api/internal/wallet/events`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ events: events.slice(i, i + 100) }),
  });
  if (!response.ok) { console.error(`O painel recusou o lote (HTTP ${response.status}).`); process.exit(1); }
  const result = await response.json() as typeof total;
  for (const key of Object.keys(total) as Array<keyof typeof total>) total[key] += result[key] ?? 0;
}
console.log(`Painel: ${total.created} novos, ${total.applied} aplicados às contas, ${total.unmatched} sem dono (ligar na tela Carteira), ${total.invalid} inválidos.`);
