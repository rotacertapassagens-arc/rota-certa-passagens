// Cloudflare Pages Function — gera um código de 6 dígitos, guarda-o
// temporariamente no Cloudflare KV (10 minutos) e envia-o por email
// através da Resend (https://resend.com).
//
// Configuração necessária no painel do Cloudflare Pages:
//
//   RESEND_API_KEY        → chave da API da Resend
//   EMAIL_FROM (opcional)  → remetente, ex: "Rota Certa Passagens <naoresponder@rotacertapassagens.pt>"
//   VERIFY_CODES (KV)      → namespace do Cloudflare KV para guardar os códigos temporários
//
// Ver README-NOTION.md / LEIA-ME-CONFIGURACAO.md para o passo a passo.

export async function onRequestPost({ request, env }) {
  let data;
  try {
    data = await request.json();
  } catch (e) {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  const email = String(data.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    return json({ ok: false, error: 'invalid_email' }, 400);
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));

  if (env.VERIFY_CODES) {
    await env.VERIFY_CODES.put(`code:${email}`, code, { expirationTtl: 600 }); // 10 minutos
  } else {
    return json({ ok: false, error: 'not_configured' }, 500);
  }

  const sent = await sendEmail(env, email, code);
  return json({ ok: true, sent });
}

async function sendEmail(env, email, code) {
  if (!env.RESEND_API_KEY) return false;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM || 'Rota Certa Passagens <onboarding@resend.dev>',
        to: [email],
        subject: 'O seu código de confirmação — Rota Certa Passagens',
        html: `<div style="font-family:sans-serif;color:#0D1B2A">
          <p>Olá!</p>
          <p>Use o código abaixo para confirmar o seu email e concluir o cadastro no Planejador Rota Certa:</p>
          <p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:24px 0">${code}</p>
          <p style="color:#7a8290;font-size:13px">Este código expira em 10 minutos. Se não foi você que pediu, pode ignorar este email.</p>
        </div>`,
      }),
    });
    return res.ok;
  } catch (e) {
    return false;
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
