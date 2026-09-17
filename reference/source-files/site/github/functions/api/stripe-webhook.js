// Cloudflare Pages Function — recebe os eventos que o Stripe envia
// automaticamente (webhook) sempre que um pagamento é concluído, e
// regista-o na mesma base de dados do Notion usada para os outros
// leads do site. Isto é um registo de apoio/reconciliação — o acesso
// ao Planejador já é liberado antes disto, pelo verify-session.js.
//
// Configuração necessária no painel do Cloudflare Pages:
//   STRIPE_WEBHOOK_SECRET → gerado quando cria o webhook no painel Stripe
//   NOTION_TOKEN / NOTION_DATABASE_ID → os mesmos já usados em lead.js
//
// Configuração necessária no painel do Stripe (Developers → Webhooks):
//   URL do endpoint: https://SEUDOMINIO/api/stripe-webhook
//   Evento a escutar: checkout.session.completed

export async function onRequestPost({ request, env }) {
  const sig = request.headers.get('stripe-signature');
  const body = await request.text();

  if (!env.STRIPE_WEBHOOK_SECRET || !sig) {
    return new Response('missing signature', { status: 400 });
  }

  const valid = await verifyStripeSignature(body, sig, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) return new Response('invalid signature', { status: 400 });

  let event;
  try {
    event = JSON.parse(body);
  } catch (e) {
    return new Response('invalid payload', { status: 400 });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    await notifyNotionPayment(env, session);
  }

  return new Response('ok');
}

async function verifyStripeSignature(payload, sigHeader, secret) {
  const parts = Object.fromEntries(sigHeader.split(',').map(p => p.split('=')));
  const t = parts.t, v1 = parts.v1;
  if (!t || !v1) return false;

  const signedPayload = `${t}.${payload}`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(signedPayload));
  const hex = [...new Uint8Array(sigBuf)].map(b => b.toString(16).padStart(2, '0')).join('');
  return hex === v1;
}

async function notifyNotionPayment(env, session) {
  if (!env.NOTION_TOKEN || !env.NOTION_DATABASE_ID) return;
  const plan = session.metadata?.plan;
  const planLabel = plan === 'personalizado'
    ? 'Planejador Personalizado 49,99€'
    : 'Planejador 9,99€ (30 dias)';

  try {
    await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        parent: { database_id: env.NOTION_DATABASE_ID },
        properties: {
          'Nome': { title: [{ text: { content: session.metadata?.name || session.customer_details?.name || 'Cliente' } }] },
          'Email': { email: session.customer_details?.email || session.metadata?.email || '' },
          'Plano': { select: { name: planLabel } },
          'Tipo': { select: { name: 'Pagamento confirmado (Stripe)' } },
          'Data': { date: { start: new Date().toISOString() } },
        },
      }),
    });
  } catch (e) {
    // não bloqueia o webhook se o Notion estiver indisponível
  }
}
