import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Real-browser end-to-end smoke test of the partner referral program, against the real Fastify
 * app + real static HTML/JS pages (tests/e2e/bootstrap-server.ts — see its docstring for exactly
 * what is a real app vs. test-only plumbing). Covers the checklist from the task spec:
 *   1. master cria parceiro
 *   2. link é copiado/aberto
 *   3. banner aparece no formulário
 *   4. proposta é enviada
 *   5. origem aparece no painel master
 *   6. parceiro autenticado vê métricas e ledger
 *   7. parceiro desativado perde acesso
 *
 * The only non-UI step is reading a one-time invite/activation code from the test-only
 * /__test__/emails introspection route (EMAIL_MODE=capture never sends anything real, and a
 * genuine browser has no real inbox to read from in this environment) — every other step drives
 * the real pages a human would use.
 */

const MASTER_EMAIL = 'e2e-master@example.com';
const MASTER_PASSWORD = 'SenhaMasterE2E123';
const PARTNER_EMAIL = 'e2e-partner@example.com';
const PARTNER_PASSWORD = 'SenhaParceiroE2E123';
const PARTNER_CODE = 'e2e-partner-code';
const PARTNER_DISPLAY_NAME = 'Parceiro E2E';
const BUYER_EMAIL = 'e2e-buyer@example.com';

async function latestCode(request: APIRequestContext, template: string, to: string): Promise<string> {
  const response = await request.get('/__test__/emails');
  const messages = (await response.json()) as Array<{ template: string; to: string; html: string }>;
  const match = messages.filter((message) => message.template === template && message.to === to).at(-1);
  const code = match ? /<strong>(\d{6})<\/strong>/.exec(match.html)?.[1] : undefined;
  if (!code) throw new Error(`no ${template} code found for ${to}`);
  return code;
}

async function loginViaUi(page: Page, email: string, password: string) {
  // Switching accounts within the same browser context: log out first (if a session cookie is
  // already set for a different account) so the real login form is shown instead of the
  // already-authenticated dashboard view.
  await page.goto('/');
  const session = await page.request.get('/api/auth/session');
  if (session.ok()) {
    const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'rc_csrf')?.value ?? '';
    await page.request.post('/api/auth/logout', { headers: { 'x-csrf-token': csrf, origin: 'http://localhost:4173' } });
    // site.js only re-checks /api/auth/session on a real page load, not on a same-document
    // hash-only navigation — a hard reload is required so its in-memory `session` state (and
    // therefore which DOM it shows) reflects the logout that just happened server-side.
    await page.reload({ waitUntil: 'load' });
  }
  await page.goto('/#/cliente');
  await page.locator('#loginEmail').fill(email);
  await page.locator('#loginPassword').fill(password);
  await page.locator('#clientLoginForm button[type=submit]').click();
  await expect(page.locator('#clientDashboard')).toBeVisible({ timeout: 10_000 });
}

test.describe.serial('partner referral program — real browser smoke chain', () => {
  test('1. master activates account and creates a partner', async ({ page, request }) => {
    // Bootstraps the very first master invite via the API (there is no UI for this — the whole
    // point of the bootstrap token is that no UI/session exists yet) and reads the one-time code
    // back from the test-only email introspection route, exactly like a human would read it from
    // their inbox.
    const bootstrap = await request.post('/api/admin/bootstrap/master-invites', {
      headers: { authorization: 'Bearer e2e-bootstrap-token-long-enough-000000' },
      data: { email: MASTER_EMAIL, name: 'Master E2E' },
    });
    expect(bootstrap.ok()).toBeTruthy();
    const masterCode = await latestCode(request, 'master_invite', MASTER_EMAIL);

    await page.goto('/master-invite.html');
    await page.locator('#masterEmail').fill(MASTER_EMAIL);
    await page.locator('#masterCode').fill(masterCode);
    await page.locator('#masterPassword').fill(MASTER_PASSWORD);
    await page.locator('#masterPasswordConfirm').fill(MASTER_PASSWORD);
    await page.locator('#masterForm button[type=submit]').click();
    await expect(page.locator('#status')).toContainText(/sucesso|ativad|pronto/i, { timeout: 10_000 });

    await loginViaUi(page, MASTER_EMAIL, MASTER_PASSWORD);
    await expect(page.locator('#masterPanelLink')).toBeVisible();

    // 1. master cria parceiro (real admin.html form)
    await page.goto('/admin.html');
    await expect(page.locator('#adminContent')).toBeVisible({ timeout: 10_000 });
    await page.locator('#partnerCode').fill(PARTNER_CODE);
    await page.locator('#partnerDisplayName').fill(PARTNER_DISPLAY_NAME);
    await page.locator('#partnerEmail').fill(PARTNER_EMAIL);
    await page.locator('#partnerCurrency').fill('EUR');
    await page.locator('#partnerCommissionType').selectOption('fixed');
    await page.locator('#partnerCommissionFixed').fill('50');
    await page.locator('#partnerForm button[type=submit]').click();
    await expect(page.locator('#partnerFormStatus')).toContainText(/criado e convite enviado/i, { timeout: 10_000 });
    await expect(page.locator(`#partners:has-text("${PARTNER_CODE}")`)).toBeVisible();

    // Creating the partner automatically sends the invitation. The list keeps a resend action
    // available until the partner accepts the one-time code.
    await expect(page.locator('[data-invite-partner]')).toContainText('Reenviar convite');
    const partnerCode = await latestCode(request, 'partner_invite', PARTNER_EMAIL);

    await page.goto('/parceiro-convite.html');
    await page.locator('#partnerEmail').fill(PARTNER_EMAIL);
    await page.locator('#partnerCode').fill(partnerCode);
    await page.locator('#partnerPassword').fill(PARTNER_PASSWORD);
    await page.locator('#partnerPasswordConfirm').fill(PARTNER_PASSWORD);
    await page.locator('#partnerInviteForm button[type=submit]').click();
    await expect(page.locator('#status')).toContainText(/sucesso|ativad|pronto/i, { timeout: 10_000 });

    await page.goto('/admin.html');
    await expect(page.locator(`#partners:has-text("${PARTNER_CODE}")`)).toContainText('Ativado', { timeout: 10_000 });
  });

  test('2-4. the partner link is opened, the banner appears, and a proposal is submitted', async ({ page, context }) => {
    // 2. link é copiado/aberto — the real /i/{code} redirect endpoint, exactly as a visitor
    // clicking the partner's shared link would hit it.
    await page.goto(`/i/${PARTNER_CODE}`);
    await expect(page).toHaveURL(/\/proposta-voo\.html\?ref=/);
    const cookies = await context.cookies();
    expect(cookies.some((cookie) => cookie.name === 'rc_ref')).toBeTruthy();

    // 3. banner aparece no formulário — driven by the real cookie + /api/partners/attribution call.
    await expect(page.locator('#referralBanner')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#referralBanner')).toContainText(PARTNER_DISPLAY_NAME);

    // 4. proposta é enviada — fills and submits the real quote form.
    await page.locator('#quoteName').fill('Comprador E2E');
    await page.locator('#quoteEmail').fill(BUYER_EMAIL);
    await page.locator('#quotePhone').fill('+351 912 345 678');
    await page.locator('#origem').fill('Lisboa');
    await page.locator('#destino').fill('Recife');
    await page.locator('#ida').fill('2027-03-10');
    await page.locator('#tipo-ida-volta').check();
    await page.locator('#volta').fill('2027-03-20');
    await page.locator('#adults').fill('1');
    await page.locator('#children').fill('0');
    await page.locator('#infants').fill('0');
    await page.locator('#cabinClass').selectOption('Econômica');
    await page.locator('#baggage').selectOption('Bagagem despachada');
    await page.locator('#flexibility').selectOption('Datas fixas');
    await page.locator('#paymentPreference').selectOption('Dinheiro');
    await page.locator('#contactConsent').check();
    await page.locator('#quoteForm button[type=submit]').click();
    await expect(page.locator('#quoteStatus')).toContainText(/protocolo/i, { timeout: 10_000 });
  });

  test('5. the referral origin appears in the master panel', async ({ page }) => {
    await loginViaUi(page, MASTER_EMAIL, MASTER_PASSWORD);
    await page.goto('/admin.html');
    await expect(page.locator('#adminContent')).toBeVisible({ timeout: 10_000 });
    const leadCard = page.locator('.lead-card', { hasText: BUYER_EMAIL });
    await expect(leadCard).toBeVisible({ timeout: 10_000 });
    await expect(leadCard).toContainText(PARTNER_DISPLAY_NAME);
    await expect(leadCard).toContainText(`(${PARTNER_CODE})`);
  });

  test('6. the authenticated partner sees their own metrics and ledger', async ({ page }) => {
    await loginViaUi(page, PARTNER_EMAIL, PARTNER_PASSWORD);
    await page.goto('/painel-parceiro.html');
    await expect(page.locator('#partnerContent')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#metrics')).toContainText('1'); // one click / one proposal
    await expect(page.locator('#ledger')).toContainText('Link');
    // No customer PII ever reaches the partner dashboard.
    await expect(page.locator('#partnerContent')).not.toContainText(BUYER_EMAIL);
  });

  test('7. a deactivated partner loses access to their own panel', async ({ page }) => {
    await loginViaUi(page, MASTER_EMAIL, MASTER_PASSWORD);
    // page.request (not the standalone `request` fixture) shares this browser context's
    // cookies, so it is authenticated as the master session we just logged in with above.
    const overview = await page.request.get('/api/admin/partners');
    const partners = (await overview.json()).partners as Array<{ id: string; code: string }>;
    const partner = partners.find((row) => row.code === PARTNER_CODE);
    expect(partner).toBeTruthy();
    await page.goto('/admin.html');
    await expect(page.locator('#adminContent')).toBeVisible({ timeout: 10_000 });
    await page.locator(`[data-toggle-partner="${partner!.id}"]`).click();
    await expect(page.locator('#partners')).toContainText('Ativar', { timeout: 10_000 });

    await loginViaUi(page, PARTNER_EMAIL, PARTNER_PASSWORD);
    await page.goto('/painel-parceiro.html');
    await expect(page.locator('#accessMessage')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#partnerContent')).toBeHidden();
    await expect(page.locator('#accessMessage p')).toContainText(/não tem acesso/i);
  });

  // --- Item #6: financial error codes render as clear Portuguese messages, not a generic one ---
  test('8. a duplicate partner code shows a specific, actionable message instead of a generic failure', async ({ page }) => {
    await loginViaUi(page, MASTER_EMAIL, MASTER_PASSWORD);
    await page.goto('/admin.html');
    await expect(page.locator('#adminContent')).toBeVisible({ timeout: 10_000 });

    // PARTNER_CODE already exists from test 1 — the backend returns 409 code_already_used, and
    // admin.js must map that to the specific message, not "Não foi possível criar o parceiro...".
    await page.locator('#partnerCode').fill(PARTNER_CODE);
    await page.locator('#partnerDisplayName').fill('Outro Parceiro');
    await page.locator('#partnerEmail').fill('e2e-outro-parceiro@example.com');
    await page.locator('#partnerCurrency').fill('EUR');
    await page.locator('#partnerCommissionType').selectOption('fixed');
    await page.locator('#partnerCommissionFixed').fill('30');
    await page.locator('#partnerForm button[type=submit]').click();
    await expect(page.locator('#partnerFormStatus')).toContainText('Já existe um parceiro com esse código.', { timeout: 10_000 });
  });
});
