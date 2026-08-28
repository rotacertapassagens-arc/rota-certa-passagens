// Cloudflare Pages Function — depois do cliente voltar do Stripe
// Checkout, o site chama isto para confirmar (do lado do servidor,
// diretamente junto do Stripe) se o pagamento foi mesmo efetuado,
// antes de liberar o acesso ao Planejador.
//
// Configuração necessária: a mesma STRIPE_SECRET_KEY do create-checkout.js

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get('session_id');

  if (!sessionId) return json({ ok: false, error: 'missing_session_id' }, 400);
  if (!env.STRIPE_SECRET_KEY) return json({ ok: false, error: 'not_configured' }, 500);

  try {
    const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
      headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}` },
    });
    const session = await res.json();
    if (!res.ok) return json({ ok: false, error: 'stripe_error' }, 400);

    const paid = session.payment_status === 'paid';
    return json({
      ok: true,
      paid,
      plan: session.metadata?.plan || null,
      email: session.customer_details?.email || session.metadata?.email || null,
    });
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
