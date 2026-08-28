// Cloudflare Pages Function — devolve o país de onde o visitante está a
// aceder, usando os dados que o próprio Cloudflare já recolhe em cada
// pedido (request.cf.country). Não precisa de nenhuma configuração.

export async function onRequest({ request }) {
  const country = (request.cf && request.cf.country) || '';
  return new Response(JSON.stringify({ country }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
