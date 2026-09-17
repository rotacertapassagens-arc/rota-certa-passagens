const status = document.getElementById('status');
const token = new URLSearchParams(location.search).get('token') || '';
async function send(path, body) {
  const response = await fetch(path, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body), credentials:'same-origin' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'request_failed');
}
document.getElementById('resetForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const password = document.getElementById('newPassword').value;
  if (password !== document.getElementById('confirmPassword').value) { status.textContent='As senhas não coincidem.'; return; }
  try { await send('/api/auth/password-reset/confirm', { token, password }); status.textContent='Senha alterada. Você já pode entrar na sua conta.'; event.target.reset(); }
  catch { status.textContent='O link é inválido ou expirou. Solicite uma nova recuperação.'; }
});
document.getElementById('masterForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const password = document.getElementById('masterPassword').value;
  if (password !== document.getElementById('masterPasswordConfirm').value) { status.textContent='As senhas não coincidem.'; return; }
  try { await send('/api/admin/master-invites/accept', { token, password }); status.textContent='Acesso master ativado. Entre na Área do cliente e abra o painel administrativo.'; event.target.reset(); }
  catch { status.textContent='O convite é inválido, já foi usado ou expirou.'; }
});
