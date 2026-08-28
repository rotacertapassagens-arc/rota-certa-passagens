// Cloudflare Pages Function — cria uma sessão do Stripe Checkout para
// os planos pagos do Planejador (9,99€/30 dias e Personalizado 49,99€)
// e devolve o link de pagamento para onde o navegador é redirecionado.
//
// Configuração necessária no painel do Cloudflare Pages:
//   STRIPE_SECRET_KEY → chave secreta da sua conta Stripe (sk_live_... ou sk_test_...)
//
// Não é preciso criar Produtos/Preços no painel do Stripe: o preço é
// enviado diretamente aqui (price_data), já com o valor certo consoante
// o país do cliente (EUR ou BRL).

const PRICES = {
  plus:          { EUR: 999,  BRL: 4997,  name: 'Planejador Rota Certa — 30 dias' },
  personalizado: { EUR: 4999, BRL: 29997, name: 'Planejador Rota Certa Personalizado' },
};

export async function onRequestPost({ request, env }) {
  let data;
  try {
    data = await request.json();
  } catch (e) {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  const plan = data.plan;
  const email = String(data.email || '').trim().toLowerCase();
  const name = String(data.name || '');
  const currency = data.currency === 'BRL' ? 'BRL' : 'EUR';

  if (!PRICES[plan]) return json({ ok: false, error: 'invalid_plan' }, 400);
  if (!email) return json({ ok: false, error: 'missing_email' }, 400);
  if (!env.STRIPE_SECRET_KEY) return json({ ok: false, error: 'not_configured' }, 500);

  const price = PRICES[plan];
  const amount = currency === 'BRL' ? price.BRL : price.EUR;
  const cur = currency === 'BRL' ? 'brl' : 'eur';
  const origin = new URL(request.url).origin;

  const params = new URLSearchParams();
  params.append('mode', 'payment');
  params.append('success_url', `${origin}/#/pagamento-sucesso?session_id={CHECKOUT_SESSION_ID}`);
  params.append('cancel_url', `${origin}/#/cliente?plan=${plan}&canceled=1`);
  params.append('customer_email', email);
  params.append('line_items[0][quantity]', '1');
  params.append('line_items[0][price_data][currency]', cur);
  params.append('line_items[0][price_data][unit_amount]', String(amount));
  params.append('line_items[0][price_data][product_data][name]', price.name);
  params.append('metadata[plan]', plan);
  params.append('metadata[email]', email);
  params.append('metadata[name]', name);

  try {
    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    const session = await res.json();
    if (!res.ok) return json({ ok: false, error: session.error?.message || 'stripe_error' }, 400);
    return json({ ok: true, url: session.url });
  } catch (e) {
    return json({ ok: false, error: 'stripe_unreachable' }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
