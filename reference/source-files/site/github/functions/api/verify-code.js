// Cloudflare Pages Function — confirma se o código de 6 dígitos que o
// cliente digitou corresponde ao que foi enviado por email (send-code.js).
// Usa o mesmo namespace de Cloudflare KV: VERIFY_CODES.

export async function onRequestPost({ request, env }) {
  let data;
  try {
    data = await request.json();
  } catch (e) {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  const email = String(data.email || '').trim().toLowerCase();
  const code = String(data.code || '').trim();

  if (!email || !code) {
    return json({ ok: false, error: 'missing_fields' }, 400);
  }
  if (!env.VERIFY_CODES) {
    return json({ ok: false, error: 'not_configured' }, 500);
  }

  const saved = await env.VERIFY_CODES.get(`code:${email}`);
  if (!saved) {
    return json({ ok: false, error: 'expired_or_missing' });
  }
  if (saved !== code) {
    return json({ ok: false, error: 'wrong_code' });
  }

  await env.VERIFY_CODES.delete(`code:${email}`);
  return json({ ok: true });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
