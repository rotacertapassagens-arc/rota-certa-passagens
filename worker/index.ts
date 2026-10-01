import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import { parseCommissionPaidPayload, parseWeeklySummaryPayload } from '../shared/notificationPayloads.js';
import { calculateProgramCommission, lisbonMonthStartUtc, nextProgressiveTier, PARTNER_PRIVACY_POLICY_VERSION, type PartnerCommissionPolicy } from '../shared/partnerCommission.js';
import { isValidSubscriptionTransition, nextChargeDate, subscriptionChargeIdempotencyKey, type SubscriptionPeriodicity } from '../shared/subscriptionSchedule.js';
import { calculateSaleProfit, isValidIssuanceTransition, sumIssuanceDirectCostCents } from '../shared/salesProfit.js';
import { allocationCostCents, unitCostMicros } from '../shared/mileageCost.js';
import { buildCsv } from '../shared/financeCsv.js';
import { blogAdmin, blogPublic, type BlogDeps } from './blog.js';
import { applyPendingFlights, checkinReminders, CURRENCIES, plannerExtras, reactivationReminders, sharedTripPage, type ExtrasDeps } from './planner-extras.js';
import { internalApi, type InternalApiDeps } from './proposal-handoff.js';
import { customerPhoneDigits, QUOTE_CONSENT_VERSION, RECEIVED_STATUS, RECEIVED_STATUS_LABEL, stopsPreferenceOf, submissionIdOf, visitSourceOf, whatsappHandoffUrl } from '../shared/proposalHandoff.js';

type Row = Record<string, unknown>;
type Auth = { userId: string; sessionId: string; email: string; name: string; roles: string[] };
type Entitlement = { tier: 'free'|'premium'|'master'; unlimited: boolean; accessActive:boolean; endsAt:string|null; activeTripLimit: number|null; archivedTripLimit: number|null; premiumFeatures: boolean };
type OptionalNotificationSecrets = {
  WHATSAPP_WEBHOOK_URL?: string;
  WHATSAPP_WEBHOOK_TOKEN?: string;
  NOTIFICATIONS_CRON_TOKEN?: string;
};

const enc = new TextEncoder();
const sessionCookie = '__Host-rc_session';
const jsonHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
};

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(Promise.all([checkinReminders(env, extrasDeps), reactivationReminders(env, extrasDeps)]).then(() => undefined));
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const p = url.pathname;
    // Guias de viagem (blog), fotos do blog e sitemap são montados pelo Worker a partir do D1.
    const isBlog = p === '/blog' || p.startsWith('/blog/') || p.startsWith('/media/blog/') || p === '/sitemap.xml';
    const isShared = p.startsWith('/viagem/');
    if (!p.startsWith('/api/') && !p.startsWith('/i/') && !isBlog && !isShared) return env.ASSETS.fetch(request);
    try {
      if (request.method === 'OPTIONS') return secureResponse(new Response(null, { status: 204 }));
      if (isBlog) return secureResponse(await blogPublic(request, env, url, blogDeps) ?? await env.ASSETS.fetch(request));
      if (isShared) return secureResponse(await sharedTripPage(request, env, url) ?? await env.ASSETS.fetch(request));
      return secureResponse(await route(request, env, url));
    } catch (error) {
      console.error(JSON.stringify({ message: 'request_failed', error: error instanceof Error ? error.message : 'unknown', path: url.pathname }));
      return secureResponse(reply({ error: 'internal_error' }, 500));
    }
  },
} satisfies ExportedHandler<Env>;

function secureResponse(response: Response) {
  response.headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set('x-frame-options', 'DENY');
  response.headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  response.headers.set('permissions-policy', 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()');
  return response;
}

const blogDeps: BlogDeps = { reply, getAuth, mutationAuth, audit };
const extrasDeps: ExtrasDeps = { reply, getAuth, mutationAuth, requirePlannerAccess, sendEmail, audit };
const internalApiDeps: InternalApiDeps = { reply, safeEqual, rateLimit, rateLimitBlocked };

async function route(req: Request, env: Env, url: URL): Promise<Response> {
  const p = url.pathname;
  // Servidor para servidor (WHA-04): toda rota /api/internal/ exige o token antes de qualquer outra resposta.
  if (p.startsWith('/api/internal/')) return internalApi(req, env, url, internalApiDeps);
  if (p.startsWith('/api/admin/blog')) { const blog = await blogAdmin(req, env, url, blogDeps); if (blog) return blog; }
  if (p.startsWith('/api/planner/') || p.startsWith('/api/admin/leads/') || p === '/api/admin/subscriptions/grant') { const extra = await plannerExtras(req, env, url, extrasDeps); if (extra) return extra; }
  if (req.method === 'POST' && p === '/api/partner-applications') return partnerApplicationCreate(req, env);
  if (req.method === 'GET' && p === '/api/admin/partner-applications') return adminPartnerApplications(req, env);
  const applicationReject = p.match(/^\/api\/admin\/partner-applications\/([0-9a-f-]+)\/reject$/i);
  if (req.method === 'POST' && applicationReject) return adminPartnerApplicationReject(req, env, applicationReject[1]!);
  const referralRedirect = p.match(/^\/i\/([^/]+)$/);
  if (req.method === 'GET' && referralRedirect) return referralClick(req, env, referralRedirect[1]!);
  if (req.method === 'GET' && p === '/api/partners/attribution') return partnerAttribution(req, env, url);
  if (req.method === 'GET' && p === '/api/partner-program/settings') return publicPartnerProgramSettings(env);
  if (req.method === 'GET' && p === '/api/admin/partner-program/settings') return adminPartnerProgramSettings(req, env);
  if (req.method === 'PATCH' && p === '/api/admin/partner-program/settings') return adminPartnerProgramSettingsUpdate(req, env);
  if (req.method === 'GET' && p === '/api/admin/partners') return adminPartners(req, env, url);
  if (req.method === 'POST' && p === '/api/admin/partners') return adminPartnerCreate(req, env);
  const partnerId = p.match(/^\/api\/admin\/partners\/([0-9a-f-]+)$/i);
  if (req.method === 'GET' && partnerId) return adminPartnerDetail(req, env, partnerId[1]!);
  if (req.method === 'PATCH' && partnerId) return adminPartnerUpdate(req, env, partnerId[1]!);
  const partnerInvite = p.match(/^\/api\/admin\/partners\/([0-9a-f-]+)\/invite$/i);
  if (req.method === 'POST' && partnerInvite) return adminPartnerInvite(req, env, partnerInvite[1]!);
  if (req.method === 'POST' && p === '/api/partner-invites/accept') return partnerInviteAccept(req, env);
  if (req.method === 'GET' && p === '/api/partner/summary') return partnerSummary(req, env);
  if (req.method === 'GET' && p === '/api/partner/ledger') return partnerLedger(req, env);
  const commissionAction = p.match(/^\/api\/admin\/commissions\/([0-9a-f-]+)\/(approve|pay|void)$/i);
  if (req.method === 'POST' && commissionAction) return commissionTransition(req, env, commissionAction[1]!, commissionAction[2]! as 'approve' | 'pay' | 'void');
  if (req.method === 'POST' && p === '/api/admin/notifications/process') return notificationsProcess(req, env);
  if (req.method === 'POST' && p === '/api/admin/notifications/weekly-summary') return notificationsWeeklySummary(req, env);
  if (req.method === 'GET' && p === '/api/admin/finance/cost-centers') return financeCostCenters(req, env);
  if (req.method === 'POST' && p === '/api/admin/finance/cost-centers') return financeCostCenterCreate(req, env);
  const costCenterId = p.match(/^\/api\/admin\/finance\/cost-centers\/([0-9a-f-]+)$/i);
  if (req.method === 'PATCH' && costCenterId) return financeCostCenterUpdate(req, env, costCenterId[1]!);
  if (req.method === 'GET' && p === '/api/admin/finance/categories') return financeCategories(req, env);
  if (req.method === 'POST' && p === '/api/admin/finance/categories') return financeCategoryCreate(req, env);
  const categoryId = p.match(/^\/api\/admin\/finance\/categories\/([0-9a-f-]+)$/i);
  if (req.method === 'PATCH' && categoryId) return financeCategoryUpdate(req, env, categoryId[1]!);
  if (req.method === 'GET' && p === '/api/admin/finance/accounts') return financeAccounts(req, env);
  if (req.method === 'POST' && p === '/api/admin/finance/accounts') return financeAccountCreate(req, env);
  const financeAccountId = p.match(/^\/api\/admin\/finance\/accounts\/([0-9a-f-]+)$/i);
  if (req.method === 'PATCH' && financeAccountId) return financeAccountUpdate(req, env, financeAccountId[1]!);
  if (req.method === 'GET' && p === '/api/admin/finance/counterparties') return financeCounterparties(req, env);
  if (req.method === 'POST' && p === '/api/admin/finance/counterparties') return financeCounterpartyCreate(req, env);
  const counterpartyId = p.match(/^\/api\/admin\/finance\/counterparties\/([0-9a-f-]+)$/i);
  if (req.method === 'PATCH' && counterpartyId) return financeCounterpartyUpdate(req, env, counterpartyId[1]!);
  if (req.method === 'GET' && p === '/api/admin/finance/subscriptions') return financeSubscriptions(req, env, url);
  if (req.method === 'POST' && p === '/api/admin/finance/subscriptions') return financeSubscriptionCreate(req, env);
  if (req.method === 'POST' && p === '/api/admin/finance/subscriptions/generate-charges') return financeSubscriptionGenerateCharges(req, env);
  const subscriptionId = p.match(/^\/api\/admin\/finance\/subscriptions\/([0-9a-f-]+)$/i);
  if (req.method === 'PATCH' && subscriptionId) return financeSubscriptionUpdate(req, env, subscriptionId[1]!);
  const subscriptionReprice = p.match(/^\/api\/admin\/finance\/subscriptions\/([0-9a-f-]+)\/reprice$/i);
  if (req.method === 'POST' && subscriptionReprice) return financeSubscriptionReprice(req, env, subscriptionReprice[1]!);
  const subscriptionPriceHistory = p.match(/^\/api\/admin\/finance\/subscriptions\/([0-9a-f-]+)\/price-history$/i);
  if (req.method === 'GET' && subscriptionPriceHistory) return financeSubscriptionPriceHistory(req, env, subscriptionPriceHistory[1]!);
  const subscriptionStatus = p.match(/^\/api\/admin\/finance\/subscriptions\/([0-9a-f-]+)\/status$/i);
  if (req.method === 'POST' && subscriptionStatus) return financeSubscriptionStatus(req, env, subscriptionStatus[1]!);
  if (req.method === 'GET' && p === '/api/admin/finance/obligations') return financeObligations(req, env, url);
  if (req.method === 'POST' && p === '/api/admin/finance/obligations') return financeObligationCreate(req, env);
  const obligationId = p.match(/^\/api\/admin\/finance\/obligations\/([0-9a-f-]+)$/i);
  if (req.method === 'PATCH' && obligationId) return financeObligationUpdate(req, env, obligationId[1]!);
  const obligationCancel = p.match(/^\/api\/admin\/finance\/obligations\/([0-9a-f-]+)\/cancel$/i);
  if (req.method === 'POST' && obligationCancel) return financeObligationCancel(req, env, obligationCancel[1]!);
  const obligationPayments = p.match(/^\/api\/admin\/finance\/obligations\/([0-9a-f-]+)\/payments$/i);
  if (req.method === 'GET' && obligationPayments) return financeObligationPayments(req, env, obligationPayments[1]!);
  if (req.method === 'POST' && obligationPayments) return financeObligationPaymentCreate(req, env, obligationPayments[1]!);
  const obligationPaymentReverse = p.match(/^\/api\/admin\/finance\/obligation-payments\/([0-9a-f-]+)\/reverse$/i);
  if (req.method === 'POST' && obligationPaymentReverse) return financeObligationPaymentReverse(req, env, obligationPaymentReverse[1]!);
  if (req.method === 'GET' && p === '/api/admin/finance/sales') return financeSales(req, env, url);
  const salesFromLead = p.match(/^\/api\/admin\/finance\/sales\/from-lead\/([0-9a-f-]+)$/i);
  if (req.method === 'POST' && salesFromLead) return financeSaleFromLead(req, env, salesFromLead[1]!);
  const saleId = p.match(/^\/api\/admin\/finance\/sales\/([0-9a-f-]+)$/i);
  if (req.method === 'GET' && saleId) return financeSaleDetail(req, env, saleId[1]!);
  const saleCancel = p.match(/^\/api\/admin\/finance\/sales\/([0-9a-f-]+)\/cancel$/i);
  if (req.method === 'POST' && saleCancel) return financeSaleCancel(req, env, saleCancel[1]!);
  const saleRefund = p.match(/^\/api\/admin\/finance\/sales\/([0-9a-f-]+)\/refund$/i);
  if (req.method === 'POST' && saleRefund) return financeSaleRefund(req, env, saleRefund[1]!);
  const saleReceivables = p.match(/^\/api\/admin\/finance\/sales\/([0-9a-f-]+)\/receivables$/i);
  if (req.method === 'GET' && saleReceivables) return financeSaleReceivables(req, env, saleReceivables[1]!);
  if (req.method === 'POST' && saleReceivables) return financeSaleReceivablesCreate(req, env, saleReceivables[1]!);
  const receivablePayments = p.match(/^\/api\/admin\/finance\/receivables\/([0-9a-f-]+)\/payments$/i);
  if (req.method === 'GET' && receivablePayments) return financeReceivablePayments(req, env, receivablePayments[1]!);
  if (req.method === 'POST' && receivablePayments) return financeReceivablePaymentCreate(req, env, receivablePayments[1]!);
  const receivablePaymentReverse = p.match(/^\/api\/admin\/finance\/receivable-payments\/([0-9a-f-]+)\/reverse$/i);
  if (req.method === 'POST' && receivablePaymentReverse) return financeReceivablePaymentReverse(req, env, receivablePaymentReverse[1]!);
  const saleIssuances = p.match(/^\/api\/admin\/finance\/sales\/([0-9a-f-]+)\/issuances$/i);
  if (req.method === 'GET' && saleIssuances) return financeSaleIssuances(req, env, saleIssuances[1]!);
  if (req.method === 'POST' && saleIssuances) return financeSaleIssuanceCreate(req, env, saleIssuances[1]!);
  const issuanceId = p.match(/^\/api\/admin\/finance\/issuances\/([0-9a-f-]+)$/i);
  if (req.method === 'PATCH' && issuanceId) return financeIssuanceUpdate(req, env, issuanceId[1]!);
  const issuanceIssue = p.match(/^\/api\/admin\/finance\/issuances\/([0-9a-f-]+)\/issue$/i);
  if (req.method === 'POST' && issuanceIssue) return financeIssuanceIssue(req, env, issuanceIssue[1]!);
  const issuanceCancel = p.match(/^\/api\/admin\/finance\/issuances\/([0-9a-f-]+)\/cancel$/i);
  if (req.method === 'POST' && issuanceCancel) return financeIssuanceCancel(req, env, issuanceCancel[1]!);
  const issuanceRefund = p.match(/^\/api\/admin\/finance\/issuances\/([0-9a-f-]+)\/refund$/i);
  if (req.method === 'POST' && issuanceRefund) return financeIssuanceRefund(req, env, issuanceRefund[1]!);
  if (req.method === 'GET' && p === '/api/admin/finance/mileage-lots') return financeMileageLots(req, env, url);
  if (req.method === 'POST' && p === '/api/admin/finance/mileage-lots') return financeMileageLotCreate(req, env);
  const mileageLotId = p.match(/^\/api\/admin\/finance\/mileage-lots\/([0-9a-f-]+)$/i);
  if (req.method === 'GET' && mileageLotId) return financeMileageLotDetail(req, env, mileageLotId[1]!);
  const mileageLotCancel = p.match(/^\/api\/admin\/finance\/mileage-lots\/([0-9a-f-]+)\/cancel$/i);
  if (req.method === 'POST' && mileageLotCancel) return financeMileageLotCancel(req, env, mileageLotCancel[1]!);
  const issuanceMileageAllocations = p.match(/^\/api\/admin\/finance\/issuances\/([0-9a-f-]+)\/mileage-allocations$/i);
  if (req.method === 'GET' && issuanceMileageAllocations) return financeMileageAllocations(req, env, issuanceMileageAllocations[1]!);
  if (req.method === 'POST' && issuanceMileageAllocations) return financeMileageAllocationCreate(req, env, issuanceMileageAllocations[1]!);
  const mileageAllocationVoid = p.match(/^\/api\/admin\/finance\/mileage-allocations\/([0-9a-f-]+)\/void$/i);
  if (req.method === 'POST' && mileageAllocationVoid) return financeMileageAllocationVoid(req, env, mileageAllocationVoid[1]!);
  if (req.method === 'GET' && p === '/api/admin/finance/dashboard/overview') return financeDashboardOverview(req, env, url);
  if (req.method === 'GET' && p === '/api/admin/finance/dashboard/alerts') return financeDashboardAlerts(req, env, url);
  if (req.method === 'GET' && p === '/api/admin/finance/dashboard/expenses-by-category') return financeDashboardExpensesByCategory(req, env, url);
  if (req.method === 'GET' && p === '/api/admin/finance/dashboard/export.csv') return financeDashboardExportCsv(req, env, url);
  if (req.method === 'GET' && p === '/api/health') return reply({ ok: true, runtime: 'cloudflare-workers' });
  if (req.method === 'GET' && p === '/api/geo') return reply({ country: req.headers.get('cf-ipcountry') || 'PT' });
  if (req.method === 'POST' && p === '/api/lead') return flightQuoteLead(req, env);
  if (req.method === 'POST' && p === '/api/auth/signup') return signup(req, env);
  if (req.method === 'POST' && p === '/api/auth/verify-email') return verifyEmail(req, env);
  if (req.method === 'POST' && p === '/api/auth/login') return login(req, env);
  if (req.method === 'GET' && p === '/api/auth/session') return session(req, env);
  if (req.method === 'POST' && p === '/api/auth/logout') return logout(req, env);
  if (req.method === 'POST' && p === '/api/auth/password-reset/request') return resetRequest(req, env);
  if (req.method === 'POST' && p === '/api/auth/password-reset/confirm') return resetConfirm(req, env);
  if (req.method === 'POST' && p === '/api/auth/change-password') return changePassword(req, env);
  if (req.method === 'POST' && p === '/api/admin/bootstrap/master-invites') return bootstrapMaster(req, env);
  if (req.method === 'POST' && p === '/api/admin/master-invites/accept') return acceptMaster(req, env);
  if (req.method === 'POST' && p === '/api/admin/master-invites') return inviteMaster(req, env);
  if (req.method === 'GET' && p === '/api/admin/overview') return adminOverview(req, env);
  if (req.method === 'GET' && p === '/api/admin/users') return adminUsers(req, env);
  if (req.method === 'GET' && p === '/api/admin/plans') return adminPlans(req, env);
  if (req.method === 'GET' && p === '/api/admin/payments') return adminPayments(req, env);
  if (req.method === 'GET' && p === '/api/admin/leads') return adminLeads(req, env, url);
  const adminLead = p.match(/^\/api\/admin\/leads\/([0-9a-f-]+)$/i);
  if (req.method === 'PATCH' && adminLead) return adminLeadUpdate(req, env, adminLead[1]);
  if (req.method === 'POST' && p === '/api/payments/checkout') return reply({ error: 'payments_disabled' }, 503);
  if (req.method === 'POST' && p === '/api/payments/stripe-webhook') return reply({ error: 'payments_disabled' }, 503);
  if (req.method === 'GET' && p === '/api/planner') return plannerGet(req, env, url);
  if (req.method === 'POST' && p === '/api/planner/trips') return plannerTrip(req, env);
  const tripAction = p.match(/^\/api\/planner\/trips\/([0-9a-f-]+)\/(archive|restore)$/i);
  if (req.method === 'POST' && tripAction) return plannerTripAction(req, env, tripAction[1], tripAction[2]);
  if (req.method === 'POST' && p === '/api/planner/import-local') return plannerImport(req, env);
  const attachUpload = p.match(/^\/api\/planner\/([0-9a-f-]+)\/itinerary\/([0-9a-f-]+)\/attachments$/i);
  if (req.method === 'POST' && attachUpload) return plannerAttachmentUpload(req, env, attachUpload[1], attachUpload[2]);
  const attachment = p.match(/^\/api\/planner\/([0-9a-f-]+)\/attachments\/([0-9a-f-]+)$/i);
  if (attachment) return plannerAttachment(req, env, attachment[1], attachment[2]);
  const match = p.match(/^\/api\/planner\/([0-9a-f-]+)\/(itinerary|places|budget|expenses|checklist)(?:\/([0-9a-f-]+))?$/i);
  if (match) return plannerItem(req, env, match[1], match[2], match[3]);
  return reply({ error: 'not_found' }, 404);
}

async function body(req: Request): Promise<Row | null> {
  try { return await req.json() as Row; } catch { return null; }
}
function reply(data: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(data), { status, headers: { ...jsonHeaders, ...headers } });
}
function emailOf(value: unknown) {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254 ? v : null;
}
function validPassword(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 12 && value.length <= 128 && /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value);
}
function text(value: unknown, max: number, min = 0) {
  const v = typeof value === 'string' ? value.trim() : '';
  return v.length >= min && v.length <= max ? v : null;
}
function phoneOf(value: unknown) { const v=typeof value==='string'?value.trim():'';if(!/^\+?[0-9 ()-]{8,30}$/.test(v))return null;return `${v.startsWith('+')?'+':''}${v.replace(/\D/g,'')}`; }
function dateOf(value: unknown) { const v=typeof value==='string'?value:'';return /^\d{4}-\d{2}-\d{2}$/.test(v)&&!Number.isNaN(Date.parse(`${v}T00:00:00Z`))?v:null; }
function intOf(value: unknown,min:number,max:number) { const n=Number(value);return Number.isInteger(n)&&n>=min&&n<=max?n:null; }
function html(value:string) { return value.replace(/[&<>'"]/g,(character)=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'})[character]!); }
function isoAfter(seconds: number) { return new Date(Date.now() + seconds * 1000).toISOString(); }
function randomToken(bytes = 32) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function code6() { return String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0'); }
function hex(data: ArrayBuffer | Uint8Array) { const bytes = data instanceof Uint8Array ? data : new Uint8Array(data); return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(''); }
async function sha(value: string) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(value))); }
async function digest(value: string, env: Env) {
  const key = await crypto.subtle.importKey('raw', enc.encode(env.TOKEN_PEPPER), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(value)));
}
async function passwordHash(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256);
  return `pbkdf2$100000$${hex(salt)}$${hex(bits)}`;
}
async function verifyPassword(password: string, stored: string) {
  const [kind, iterations, saltHex, expected] = stored.split('$');
  if (kind !== 'pbkdf2' || !iterations || !saltHex || !expected) return false;
  const salt = new Uint8Array(saltHex.match(/../g)!.map((x) => parseInt(x, 16)));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: Number(iterations) }, key, 256);
  return safeEqual(hex(bits), expected);
}
async function safeEqual(a: string, b: string) {
  const [left, right] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  return timingSafeEqual(new Uint8Array(left), new Uint8Array(right));
}
function cookies(req: Request) {
  const out: Record<string, string> = {};
  for (const part of (req.headers.get('cookie') || '').split(';')) {
    const [k, ...v] = part.trim().split('='); if (k) out[k] = decodeURIComponent(v.join('='));
  }
  return out;
}
function clientKey(req: Request) { return req.headers.get('cf-connecting-ip') || 'unknown'; }

const REF_COOKIE = 'rc_ref';
const PARTNER_CODE_RE = /^[a-z0-9-]{3,32}$/;
// Mirrors src/security.ts's ALLOWED_CURRENCIES exactly — the product's supported currencies for
// partner commissions and sale amounts, kept small and explicit rather than accepting any
// 3-letter string.
const ALLOWED_CURRENCIES = ['EUR', 'USD', 'BRL', 'GBP'];
function validCurrency(value: string) { return ALLOWED_CURRENCIES.includes(value.toUpperCase()); }
function normalizeCode(value: string) { return value.trim().toLowerCase(); }
function validCode(value: string) { return PARTNER_CODE_RE.test(value); }
async function signRef(codeValue: string, capturedAtMs: number, env: Env) {
  const payload = `${codeValue}.${capturedAtMs}`;
  return `${payload}.${await digest(payload, env)}`;
}
async function verifyRef(token: string, env: Env): Promise<{ code: string; capturedAtMs: number } | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [codeValue, capturedAtText, signature] = parts;
  const capturedAtMs = Number(capturedAtText);
  if (!codeValue || !Number.isFinite(capturedAtMs) || capturedAtMs <= 0) return null;
  const expected = await digest(`${codeValue}.${capturedAtText}`, env);
  return (await safeEqual(signature!, expected)) ? { code: codeValue, capturedAtMs } : null;
}
function maskProtocol(protocol: string) {
  const parts = protocol.split('-'); const suffix = parts[2] ?? ''; const visible = suffix.slice(0, 2);
  return `${parts[0]}-${parts[1]}-${visible}${'•'.repeat(Math.max(0, suffix.length - 2))}`;
}

interface Attribution { partnerId: string; code: string; source: 'link' | 'manual'; capturedAtIso: string; expiresAtIso: string }
async function resolveAttribution(req: Request, env: Env, manualCode?: string | null): Promise<Attribution | null> {
  const cookieToken = cookies(req)[REF_COOKIE];
  if (cookieToken) {
    const verified = await verifyRef(cookieToken, env);
    if (verified) {
      const partner = await env.DB.prepare('SELECT id,attribution_window_days FROM partners WHERE code=? AND active=1').bind(verified.code).first<{ id: string; attribution_window_days: number }>();
      if (partner) {
        const expiresAtMs = verified.capturedAtMs + partner.attribution_window_days * 86400000;
        if (expiresAtMs > Date.now()) {
          return { partnerId: String(partner.id), code: verified.code, source: 'link', capturedAtIso: new Date(verified.capturedAtMs).toISOString(), expiresAtIso: new Date(expiresAtMs).toISOString() };
        }
      }
    }
  }
  if (manualCode) {
    const codeValue = normalizeCode(manualCode);
    if (validCode(codeValue)) {
      const partner = await env.DB.prepare('SELECT id,attribution_window_days FROM partners WHERE code=? AND active=1').bind(codeValue).first<{ id: string; attribution_window_days: number }>();
      if (partner) {
        const now = Date.now();
        return { partnerId: String(partner.id), code: codeValue, source: 'manual', capturedAtIso: new Date(now).toISOString(), expiresAtIso: new Date(now + partner.attribution_window_days * 86400000).toISOString() };
      }
    }
  }
  return null;
}

/** CURRENT_TIMESTAMP do SQLite ('AAAA-MM-DD HH:MM:SS') é UTC; sem isso, Date.parse lê como hora local (só muda fora da Cloudflare). */
function sqliteUtcMs(value: string) {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? Date.parse(`${value.replace(' ', 'T')}Z`) : Date.parse(value);
}
function rateLimitKey(req: Request, env: Env, scope: string, target: string) {
  return sha(`${env.RATE_LIMIT_SECRET}|${scope}|${target}|${clientKey(req)}`);
}
/** Só consulta se o balde está bloqueado, sem contar tentativa. */
async function rateLimitBlocked(req: Request, env: Env, scope: string, target: string) {
  const row = await env.DB.prepare('SELECT blocked_until FROM rate_limit_buckets WHERE key_hash=?').bind(await rateLimitKey(req, env, scope, target)).first<{blocked_until:string|null}>();
  return Boolean(row?.blocked_until && Date.parse(row.blocked_until) > Date.now());
}
async function rateLimit(req: Request, env: Env, scope: string, target: string, max: number, windowSeconds: number) {
  const key = await rateLimitKey(req, env, scope, target);
  const current = await env.DB.prepare('SELECT attempts,window_started_at,blocked_until FROM rate_limit_buckets WHERE key_hash=?').bind(key).first<{attempts:number;window_started_at:string;blocked_until:string|null}>();
  const now = Date.now();
  if (current?.blocked_until && Date.parse(current.blocked_until) > now) return false;
  if (!current || now - sqliteUtcMs(current.window_started_at) >= windowSeconds * 1000) {
    await env.DB.prepare('INSERT INTO rate_limit_buckets(key_hash,window_started_at,attempts,blocked_until) VALUES(?,CURRENT_TIMESTAMP,1,NULL) ON CONFLICT(key_hash) DO UPDATE SET window_started_at=CURRENT_TIMESTAMP,attempts=1,blocked_until=NULL').bind(key).run();
    return true;
  }
  const attempts = current.attempts + 1;
  const blocked = attempts > max ? isoAfter(windowSeconds) : null;
  await env.DB.prepare('UPDATE rate_limit_buckets SET attempts=?,blocked_until=? WHERE key_hash=?').bind(attempts, blocked, key).run();
  return attempts <= max;
}

async function getAuth(req: Request, env: Env): Promise<Auth | null> {
  const raw = cookies(req)[sessionCookie]; if (!raw) return null;
  const row = await env.DB.prepare(`SELECT s.id AS session_id,u.id AS user_id,u.email,p.display_name
    FROM sessions s JOIN users u ON u.id=s.user_id JOIN profiles p ON p.user_id=u.id
    WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>CURRENT_TIMESTAMP AND u.status='active'`).bind(await digest(raw, env)).first<Row>();
  if (!row) return null;
  const roles = await env.DB.prepare('SELECT role FROM user_roles WHERE user_id=?').bind(row.user_id).all<{role:string}>();
  return { userId: String(row.user_id), sessionId: String(row.session_id), email: String(row.email), name: String(row.display_name), roles: roles.results.map((r) => r.role) };
}
async function mutationAuth(req: Request, env: Env) {
  if (req.headers.get('origin') !== env.APP_ORIGIN) return null;
  const auth = await getAuth(req, env); if (!auth) return null;
  const csrf = req.headers.get('x-csrf-token') || '';
  const csrfCookie = cookies(req).rc_csrf || '';
  if (!csrf || !(await safeEqual(csrf, csrfCookie))) return null;
  const ok = await env.DB.prepare('SELECT 1 FROM sessions WHERE id=? AND csrf_token_hash=?').bind(auth.sessionId, await digest(csrf, env)).first();
  return ok ? auth : null;
}
async function createSession(userId: string, env: Env) {
  const token = randomToken(); const csrf = randomToken(); const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO sessions(id,user_id,token_hash,csrf_token_hash,expires_at) VALUES(?,?,?,?,?)').bind(id, userId, await digest(token, env), await digest(csrf, env), isoAfter(30 * 86400)).run();
  return { token, csrf };
}
function sessionHeaders(token: string, csrf: string) {
  const h = new Headers(jsonHeaders);
  h.append('set-cookie', `${sessionCookie}=${encodeURIComponent(token)}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`);
  h.append('set-cookie', `rc_csrf=${encodeURIComponent(csrf)}; Path=/; Max-Age=2592000; Secure; SameSite=Strict`);
  return h;
}
async function entitlement(auth: Auth, env: Env): Promise<Entitlement> {
  if(auth.roles.includes('master'))return {tier:'master',unlimited:true,accessActive:true,endsAt:null,activeTripLimit:null,archivedTripLimit:null,premiumFeatures:true};
  const active=await env.DB.prepare("SELECT p.code,s.ends_at FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.user_id=? AND s.status IN ('trialing','active') AND s.ends_at>CURRENT_TIMESTAMP AND p.code IN ('trial-10d','planner-30d','cliente-rota-certa') ORDER BY CASE WHEN p.code='planner-30d' THEN 0 ELSE 1 END,s.ends_at DESC LIMIT 1").bind(auth.userId).first<{code:string;ends_at:string}>();
  const tier=active?.code==='planner-30d'?'premium':'free';
  const unlimited=tier!=='free';
  return {tier,unlimited,accessActive:Boolean(active),endsAt:active?.ends_at||null,activeTripLimit:unlimited?null:1,archivedTripLimit:unlimited?null:2,premiumFeatures:unlimited};
}
async function canCreateActiveTrip(auth:Auth,env:Env,access?:Entitlement){const e=access||await entitlement(auth,env);if(e.unlimited)return true;const row=await env.DB.prepare('SELECT count(*) n FROM trips WHERE owner_user_id=? AND archived_at IS NULL').bind(auth.userId).first<{n:number}>();return Number(row?.n||0)<1;
}
async function requirePlannerAccess(auth:Auth,env:Env){const access=await entitlement(auth,env);return access.accessActive?access:null;}

// Mirrors src/email.ts's EMAIL_MODE contract exactly: 'capture' (the default, used locally and
// in every automated test — including the Worker/D1 smoke test) never makes network I/O and just
// records the event in email_events with provider='local-capture'; 'resend' is the real
// Resend-backed provider and must be explicitly configured (EMAIL_MODE=resend as a wrangler var)
// before any network call is ever made. Earlier revisions of this file always called Resend
// regardless of a (non-existent) "capture mode" claimed only in comments — this is the actual
// fix, not just documentation.
async function sendEmail(env: Env, userId: string | null, to: string, template: string, subject: string, htmlBody: string, textBody?: string, idempotencyKey?: string) {
  const recipientHash = await digest(to, env); const id = crypto.randomUUID();
  // Wrangler generates the current literal value ("capture"). Keep the runtime validation wide
  // enough for the same code to remain valid after an approved config change to "resend".
  const mode = env.EMAIL_MODE as 'capture' | 'resend';
  if (mode === 'capture') {
    await env.DB.prepare("INSERT INTO email_events(id,user_id,template,recipient_hash,provider,status) VALUES(?,?,?,?,'local-capture','captured')").bind(id,userId,template,recipientHash).run();
    return;
  }
  const headers: Record<string,string> = { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' };
  // See src/email.ts's EmailMessage.idempotencyKey: passed through to Resend's documented
  // Idempotency-Key header so a genuine duplicate send (lost outbox lock / caller-level retry) is
  // deduplicated by the provider — "at least once, provider-deduplicated", never "exactly once".
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers, body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, html: htmlBody, text: textBody }) });
  let reference: string | null = null; try { reference = String(((await response.json()) as Row).id || '') || null; } catch {}
  await env.DB.prepare('INSERT INTO email_events(id,user_id,template,recipient_hash,provider,provider_reference,status,error_code) VALUES(?,?,?,?,?,?,?,?)').bind(id,userId,template,recipientHash,'resend',reference,response.ok?'sent':'failed',response.ok?null:`http_${response.status}`).run();
  if (!response.ok) throw new Error('email_delivery_failed');
}

async function signup(req: Request, env: Env) {
  const b = await body(req); const email = emailOf(b?.email); const name = text(b?.name,120,2); const password = b?.password;
  if (!email || !name || !validPassword(password) || b?.termsAccepted !== true) return reply({ error: 'invalid_signup' },400);
  if (!(await rateLimit(req,env,'signup',email,5,900))) return reply({error:'try_again_later'},429);
  let user = await env.DB.prepare('SELECT id,status,email_verified_at FROM users WHERE email=?').bind(email).first<Row>();
  if (!user) {
    const id=crypto.randomUUID(); const hash=await passwordHash(password);
    await env.DB.batch([
      env.DB.prepare('INSERT INTO users(id,email,password_hash) VALUES(?,?,?)').bind(id,email,hash),
      env.DB.prepare('INSERT INTO profiles(user_id,display_name) VALUES(?,?)').bind(id,name),
      env.DB.prepare("INSERT INTO user_roles(user_id,role) VALUES(?,'customer')").bind(id),
    ]); user={id,status:'pending',email_verified_at:null};
  }
  if (!user.email_verified_at && user.status==='pending') {
    const code=code6(); const tokenHash=await digest(code,env);
    await env.DB.batch([
      env.DB.prepare("UPDATE account_tokens SET used_at=CURRENT_TIMESTAMP WHERE user_id=? AND purpose='email_verification' AND used_at IS NULL").bind(user.id),
      env.DB.prepare("INSERT INTO account_tokens(id,user_id,purpose,token_hash,expires_at) VALUES(?,?,'email_verification',?,?)").bind(crypto.randomUUID(),user.id,tokenHash,isoAfter(600)),
    ]);
    await sendEmail(env,String(user.id),email,'verify_email','Confirme seu e-mail - Rota Certa Passagens',`<p>Seu código de confirmação é <strong>${code}</strong>.</p><p>Ele expira em 10 minutos e só pode ser usado uma vez.</p>`);
  }
  return reply({ok:true},202);
}

async function verifyEmail(req: Request, env: Env) {
  const b=await body(req); const email=emailOf(b?.email); const code=typeof b?.code==='string'&&/^\d{6}$/.test(b.code)?b.code:null;
  if(!email||!code) return reply({error:'invalid_code'},400);
  if(!(await rateLimit(req,env,'verify',email,6,600))) return reply({error:'try_again_later'},429);
  const user=await env.DB.prepare('SELECT id FROM users WHERE email=?').bind(email).first<Row>();
  if(!user) return reply({error:'invalid_or_expired_code'},400);
  const token=await env.DB.prepare("SELECT id FROM account_tokens WHERE user_id=? AND purpose='email_verification' AND token_hash=? AND used_at IS NULL AND expires_at>CURRENT_TIMESTAMP AND failed_attempts<5 ORDER BY created_at DESC LIMIT 1").bind(user.id,await digest(code,env)).first<Row>();
  if(!token){await env.DB.prepare("UPDATE account_tokens SET failed_attempts=failed_attempts+1 WHERE id=(SELECT id FROM account_tokens WHERE user_id=? AND purpose='email_verification' AND used_at IS NULL ORDER BY created_at DESC LIMIT 1)").bind(user.id).run();return reply({error:'invalid_or_expired_code'},400);}
  const tripId=crypto.randomUUID();const now=new Date().toISOString();const end=isoAfter(10*86400);
  await env.DB.batch([
    env.DB.prepare('UPDATE account_tokens SET used_at=CURRENT_TIMESTAMP WHERE id=?').bind(token.id),
    env.DB.prepare("UPDATE users SET email_verified_at=CURRENT_TIMESTAMP,status='active',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(user.id),
    env.DB.prepare("INSERT INTO subscriptions(id,user_id,plan_id,status,starts_at,ends_at,provider) SELECT ?,?,?, 'trialing',?,?,'internal' WHERE NOT EXISTS(SELECT 1 FROM subscriptions WHERE user_id=?)").bind(crypto.randomUUID(),user.id,'00000000-0000-4000-8000-000000000001',now,end,user.id),
    env.DB.prepare("INSERT INTO trips(id,owner_user_id,name) VALUES(?,?,'Minha viagem')").bind(tripId,user.id),
    env.DB.prepare("INSERT INTO budgets(trip_id,owner_user_id,amount_cents,currency) VALUES(?,?,150000,'EUR')").bind(tripId,user.id),
  ]);
  const items=['Passaporte válido','Seguro viagem','Documentos de viagem','Check-in online','Bagagem despachada','Dinheiro / cartões','Adaptador de tomada','Medicamentos'];
  await env.DB.batch(items.map((item,i)=>env.DB.prepare('INSERT INTO checklist_items(id,trip_id,owner_user_id,text,sort_order) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),tripId,user.id,item,i)));
  const s=await createSession(String(user.id),env); return new Response(JSON.stringify({ok:true,csrfToken:s.csrf}),{headers:sessionHeaders(s.token,s.csrf)});
}

async function login(req: Request, env: Env) {
  const b=await body(req); const email=emailOf(b?.email); const password=typeof b?.password==='string'?b.password:'';
  if(!email||!password) return reply({error:'invalid_credentials'},400);
  if(!(await rateLimit(req,env,'login',email,8,900))) return reply({error:'try_again_later'},429);
  const user=await env.DB.prepare("SELECT id,password_hash FROM users WHERE email=? AND status='active' AND email_verified_at IS NOT NULL").bind(email).first<Row>();
  if(!user||typeof user.password_hash!=='string'||!(await verifyPassword(password,user.password_hash))) return reply({error:'invalid_credentials'},401);
  const s=await createSession(String(user.id),env); await env.DB.prepare('UPDATE users SET last_login_at=CURRENT_TIMESTAMP WHERE id=?').bind(user.id).run();
  return new Response(JSON.stringify({ok:true,csrfToken:s.csrf}),{headers:sessionHeaders(s.token,s.csrf)});
}
async function session(req: Request, env: Env) {
  const auth=await getAuth(req,env); if(!auth) return reply({authenticated:false},401);
  const access=await entitlement(auth,env);
  return reply({authenticated:true,user:{id:auth.userId,email:auth.email,name:auth.name,roles:auth.roles},access});
}
async function logout(req: Request, env: Env) {
  const auth=await mutationAuth(req,env); if(!auth) return reply({error:'unauthorized'},401);
  await env.DB.prepare('UPDATE sessions SET revoked_at=CURRENT_TIMESTAMP WHERE id=?').bind(auth.sessionId).run();
  const h=new Headers(jsonHeaders);h.append('set-cookie',`${sessionCookie}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);h.append('set-cookie','rc_csrf=; Path=/; Max-Age=0; Secure; SameSite=Strict');return new Response(JSON.stringify({ok:true}),{headers:h});
}

async function resetRequest(req: Request, env: Env) {
  const b=await body(req);const email=emailOf(b?.email);if(!email)return reply({ok:true},202);
  if(!(await rateLimit(req,env,'reset-request',email,4,1800))) return reply({ok:true},202);
  const user=await env.DB.prepare("SELECT id FROM users WHERE email=? AND status='active'").bind(email).first<Row>();
  if(user){const raw=randomToken();await env.DB.batch([env.DB.prepare("UPDATE account_tokens SET used_at=CURRENT_TIMESTAMP WHERE user_id=? AND purpose='password_reset' AND used_at IS NULL").bind(user.id),env.DB.prepare("INSERT INTO account_tokens(id,user_id,purpose,token_hash,expires_at) VALUES(?,?,'password_reset',?,?)").bind(crypto.randomUUID(),user.id,await digest(raw,env),isoAfter(2700))]);await sendEmail(env,String(user.id),email,'password_reset','Redefina sua senha - Rota Certa Passagens',`<p><a href="${env.APP_ORIGIN}/reset-password.html?token=${encodeURIComponent(raw)}">Redefinir senha</a></p><p>O link expira em 45 minutos.</p>`);}
  return reply({ok:true},202);
}
async function resetConfirm(req: Request, env: Env) {
  const b=await body(req);const token=typeof b?.token==='string'?b.token:'';const password=b?.password;if(token.length<32||!validPassword(password))return reply({error:'invalid_or_expired_token'},400);
  const row=await env.DB.prepare("SELECT id,user_id FROM account_tokens WHERE token_hash=? AND purpose='password_reset' AND used_at IS NULL AND expires_at>CURRENT_TIMESTAMP LIMIT 1").bind(await digest(token,env)).first<Row>();if(!row)return reply({error:'invalid_or_expired_token'},400);
  await env.DB.batch([env.DB.prepare('UPDATE users SET password_hash=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(await passwordHash(password),row.user_id),env.DB.prepare('UPDATE account_tokens SET used_at=CURRENT_TIMESTAMP WHERE id=?').bind(row.id),env.DB.prepare('UPDATE sessions SET revoked_at=CURRENT_TIMESTAMP WHERE user_id=? AND revoked_at IS NULL').bind(row.user_id)]);return reply({ok:true});
}
async function changePassword(req: Request, env: Env) {
  const auth=await mutationAuth(req,env);if(!auth)return reply({error:'unauthorized'},401);const b=await body(req);if(typeof b?.currentPassword!=='string'||!validPassword(b?.newPassword))return reply({error:'invalid_password'},400);
  const row=await env.DB.prepare('SELECT password_hash FROM users WHERE id=?').bind(auth.userId).first<Row>();if(typeof row?.password_hash!=='string'||!(await verifyPassword(b.currentPassword,row.password_hash)))return reply({error:'invalid_password'},400);
  await env.DB.batch([env.DB.prepare('UPDATE users SET password_hash=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(await passwordHash(b.newPassword),auth.userId),env.DB.prepare('UPDATE sessions SET revoked_at=CURRENT_TIMESTAMP WHERE user_id=? AND id<>?').bind(auth.userId,auth.sessionId)]);return reply({ok:true});
}

async function createMasterInvite(req: Request, env: Env, actor: string|null) {
  const b=await body(req);const email=emailOf(b?.email);const name=text(b?.name,120,2);if(!email||!name)return reply({error:'invalid_invite'},400);
  let user=await env.DB.prepare('SELECT id FROM users WHERE email=?').bind(email).first<Row>();
  if(!user){const id=crypto.randomUUID();await env.DB.batch([env.DB.prepare("INSERT INTO users(id,email,status) VALUES(?,?,'pending')").bind(id,email),env.DB.prepare('INSERT INTO profiles(user_id,display_name) VALUES(?,?)').bind(id,name)]);user={id};}
  const code=code6();await env.DB.batch([env.DB.prepare("UPDATE account_tokens SET used_at=CURRENT_TIMESTAMP WHERE user_id=? AND purpose='master_invite' AND used_at IS NULL").bind(user.id),env.DB.prepare("INSERT INTO account_tokens(id,user_id,purpose,token_hash,expires_at) VALUES(?,?,'master_invite',?,?)").bind(crypto.randomUUID(),user.id,await digest(code,env),isoAfter(900))]);
  await sendEmail(env,String(user.id),email,'master_invite','Código de ativação master - Rota Certa Passagens',`<p>Seu código de ativação master é:</p><p><strong>${code}</strong></p><p>Digite-o em <a href="${env.APP_ORIGIN}/master-invite.html">${env.APP_ORIGIN}/master-invite.html</a>. Ele expira em 15 minutos.</p>`);
  await audit(env,actor,'admin.master_invite_created','user',String(user.id));return reply({ok:true},201);
}
async function bootstrapMaster(req: Request, env: Env) {
  const provided=(req.headers.get('authorization')||'').replace(/^Bearer\s+/i,'');if(!env.MASTER_BOOTSTRAP_TOKEN||!(await safeEqual(provided,env.MASTER_BOOTSTRAP_TOKEN)))return reply({error:'not_found'},404);
  if(await env.DB.prepare("SELECT 1 FROM user_roles WHERE role='master' LIMIT 1").first())return reply({error:'master_already_exists'},409);return createMasterInvite(req,env,null);
}
async function inviteMaster(req: Request, env: Env) {const auth=await mutationAuth(req,env);if(!auth)return reply({error:'unauthorized'},401);if(!auth.roles.includes('master'))return reply({error:'forbidden'},403);return createMasterInvite(req,env,auth.userId);}
async function acceptMaster(req: Request, env: Env) {
  const b=await body(req);const email=emailOf(b?.email);const code=typeof b?.code==='string'&&/^\d{6}$/.test(b.code)?b.code:null;const password=b?.password;
  if(!validPassword(password))return reply({error:'invalid_password_requirements'},400);
  if(!email||!code)return reply({error:'invalid_or_expired_invite'},400);
  if(!(await rateLimit(req,env,'master-accept',email,8,900)))return reply({error:'too_many_attempts'},429);
  const row=await env.DB.prepare("SELECT t.id,t.user_id FROM account_tokens t JOIN users u ON u.id=t.user_id WHERE u.email=? AND t.token_hash=? AND t.purpose='master_invite' AND t.used_at IS NULL AND t.expires_at>CURRENT_TIMESTAMP AND t.failed_attempts<5 LIMIT 1").bind(email,await digest(code,env)).first<Row>();
  if(!row){await env.DB.prepare("UPDATE account_tokens SET failed_attempts=failed_attempts+1 WHERE id=(SELECT t.id FROM account_tokens t JOIN users u ON u.id=t.user_id WHERE u.email=? AND t.purpose='master_invite' AND t.used_at IS NULL ORDER BY t.created_at DESC LIMIT 1)").bind(email).run();return reply({error:'invalid_or_expired_invite'},400);}
  const tripId=crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET password_hash=?,status='active',email_verified_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(await passwordHash(password),row.user_id),
    env.DB.prepare("INSERT OR IGNORE INTO user_roles(user_id,role) VALUES(?,'master')").bind(row.user_id),
    env.DB.prepare('UPDATE account_tokens SET used_at=CURRENT_TIMESTAMP WHERE id=?').bind(row.id),
    env.DB.prepare("INSERT INTO trips(id,owner_user_id,name) SELECT ?,?,'Minha viagem' WHERE NOT EXISTS(SELECT 1 FROM trips WHERE owner_user_id=?)").bind(tripId,row.user_id,row.user_id),
    env.DB.prepare("INSERT OR IGNORE INTO budgets(trip_id,owner_user_id,amount_cents,currency) SELECT id,owner_user_id,0,'EUR' FROM trips WHERE id=?").bind(tripId),
  ]);await audit(env,String(row.user_id),'admin.master_invite_accepted','user',String(row.user_id));return reply({ok:true});
}
async function requireMaster(req:Request,env:Env){const a=await getAuth(req,env);return a?.roles.includes('master')?a:null;}
// Mirrors src/routes/notifications.ts requireMasterOrCron: an unattended Cloudflare Scheduled
// Event has no session cookie, so it authenticates with the NOTIFICATIONS_CRON_TOKEN bearer
// secret instead, following the same bootstrap-token pattern already used for master.
async function requireMasterOrCronUserId(req:Request,env:Env):Promise<string|null|undefined>{
  const provided=(req.headers.get('authorization')||'').replace(/^Bearer\s+/i,'');
  const cronToken=(env as Env & OptionalNotificationSecrets).NOTIFICATIONS_CRON_TOKEN;
  if(cronToken&&provided&&(await safeEqual(provided,cronToken)))return null;
  const auth=await mutationAuth(req,env);
  if(!auth||!auth.roles.includes('master'))return undefined;
  return auth.userId;
}
async function adminOverview(req:Request,env:Env){if(!(await requireMaster(req,env)))return reply({error:'forbidden'},403);const u=await env.DB.prepare("SELECT count(*) n FROM users WHERE status<>'deleted'").first<{n:number}>();const a=await env.DB.prepare("SELECT count(*) n FROM users WHERE status='active'").first<{n:number}>();const p=await env.DB.prepare("SELECT count(*) n FROM payments WHERE status IN ('pending','processing')").first<{n:number}>();const paid=await env.DB.prepare("SELECT count(*) n FROM payments WHERE status='paid'").first<{n:number}>();const fresh=await env.DB.prepare("SELECT count(*) n FROM lead_requests WHERE kind='flight_quote' AND status='new'").first<{n:number}>();const overdue=await env.DB.prepare("SELECT count(*) n FROM lead_requests WHERE kind='flight_quote' AND deadline_at<CURRENT_TIMESTAMP AND status NOT IN ('sent','converted','lost','canceled','closed')").first<{n:number}>();return reply({users:u?.n||0,active_access:a?.n||0,pending_payments:p?.n||0,paid_payments:paid?.n||0,new_leads:fresh?.n||0,overdue_leads:overdue?.n||0});}
async function adminUsers(req:Request,env:Env){if(!(await requireMaster(req,env)))return reply({error:'forbidden'},403);const users=await env.DB.prepare('SELECT u.id,u.email,p.display_name,u.status,u.email_verified_at,u.created_at,u.last_login_at FROM users u JOIN profiles p ON p.user_id=u.id ORDER BY u.created_at DESC LIMIT 200').all<Row>();const roles=await env.DB.prepare('SELECT user_id,role FROM user_roles').all<Row>();return reply({users:users.results.map(u=>({...u,roles:roles.results.filter(r=>r.user_id===u.id).map(r=>r.role)}))});}
async function adminPlans(req:Request,env:Env){if(!(await requireMaster(req,env)))return reply({error:'forbidden'},403);return reply({plans:(await env.DB.prepare('SELECT * FROM plans ORDER BY price_cents').all()).results});}
async function adminPayments(req:Request,env:Env){if(!(await requireMaster(req,env)))return reply({error:'forbidden'},403);return reply({payments:(await env.DB.prepare('SELECT p.*,u.email,pl.code plan_code FROM payments p JOIN users u ON u.id=p.user_id LEFT JOIN plans pl ON pl.id=p.plan_id ORDER BY p.created_at DESC LIMIT 200').all()).results});}

const leadStatuses=['new','reviewing','awaiting_customer','ready','sent','converted','lost','canceled','closed'];
async function adminLeads(req:Request,env:Env,url:URL){
  if(!(await requireMaster(req,env)))return reply({error:'forbidden'},403);
  const status=url.searchParams.get('status');const partnerId=url.searchParams.get('partnerId');
  if(status&&!leadStatuses.includes(status))return reply({error:'invalid_filter'},400);
  const conds=["l.kind='flight_quote'"];const binds:unknown[]=[];
  if(status){conds.push('l.status=?');binds.push(status);}
  if(partnerId){conds.push('l.partner_id=?');binds.push(partnerId);}
  const sql=`SELECT l.id,l.protocol,l.customer_name,l.customer_email,l.customer_phone,l.origin,l.destination,l.outbound_on,l.return_on,l.adults,l.children,l.infants,l.trip_type,l.cabin_class,l.baggage,l.date_flexibility,l.payment_preference,l.notes,l.internal_notes,l.status,l.deadline_at,l.created_at,l.updated_at,l.assigned_to,p.display_name assigned_name,l.partner_id,l.referral_code_snapshot,l.referral_source,l.sale_amount_cents,l.sale_currency,l.converted_at,partner.code partner_code,partner.display_name partner_display_name FROM lead_requests l LEFT JOIN profiles p ON p.user_id=l.assigned_to LEFT JOIN partners partner ON partner.id=l.partner_id WHERE ${conds.join(' AND ')} ORDER BY CASE WHEN l.status IN ('new','reviewing','awaiting_customer','ready') THEN 0 ELSE 1 END,l.deadline_at ASC,l.created_at DESC LIMIT 200`;
  const leads=(await env.DB.prepare(sql).bind(...binds).all<Row>()).results;
  // A lead can have more than one *historical* commission row (converted -> voided ->
  // reconverted); this listing must attach exactly one "current" commission per lead without
  // duplicating rows. Fetched separately and merged here in a fully deterministic order: the
  // SQL ORDER BY guarantees the first row seen per lead_request_id is the active (non-void)
  // commission if one exists, otherwise the most recently voided one.
  const leadIdSet=new Set(leads.map((row)=>String(row.id)));
  const commissionByLead=new Map<string,{id:string;status:string;amount_cents:number;currency:string}>();
  if(leadIdSet.size){
    const commissions=await env.DB.prepare(`SELECT pc.id,pc.lead_request_id,pc.status,pc.amount_cents,pc.currency FROM partner_commissions pc JOIN lead_requests l ON l.id=pc.lead_request_id WHERE l.kind='flight_quote' ORDER BY (pc.status='void') ASC, pc.created_at DESC LIMIT 2000`).all<{id:string;lead_request_id:string;status:string;amount_cents:number;currency:string}>();
    for(const row of commissions.results){
      const leadRequestId=String(row.lead_request_id);
      if(leadIdSet.has(leadRequestId)&&!commissionByLead.has(leadRequestId))commissionByLead.set(leadRequestId,row);
    }
  }
  return reply({leads:leads.map((row)=>{
    const commission=commissionByLead.get(String(row.id));
    return {...row,commission_id:commission?.id??null,commission_status:commission?.status??null,commission_amount_cents:commission?.amount_cents??null,commission_currency:commission?.currency??null};
  })});
}

/**
 * Mirrors src/routes/admin.ts's createCommissionForLead: at most one *active* (non-void)
 * commission per lead (migration 0006's partial unique index), convert -> void -> reconvert
 * creates real history, a repeat call is idempotent and never silently changes a sale
 * amount/currency that already produced a live commission, and a percentage sale must be in the
 * partner's own configured currency.
 */
async function createCommissionForLead(env:Env,actorUserId:string,leadId:string,partnerId:string,saleAmountCents:number|null,saleCurrency:string|null,currentSaleAmountCents:number|null,currentSaleCurrency:string|null):Promise<{amountCents:number;currency:string}|{error:string;statusCode:number}>{
  const active=await env.DB.prepare("SELECT id,amount_cents,currency FROM partner_commissions WHERE lead_request_id=? AND status<>'void'").bind(leadId).first<{id:string;amount_cents:number;currency:string}>();
  if(active){
    const amountChanged=saleAmountCents!==null&&saleAmountCents!==currentSaleAmountCents;
    const currencyChanged=saleCurrency!==null&&saleCurrency.toUpperCase()!==currentSaleCurrency;
    if(amountChanged||currencyChanged)return{error:'sale_amount_locked',statusCode:409};
    return{amountCents:active.amount_cents,currency:active.currency};
  }
  const rule=await env.DB.prepare('SELECT currency FROM partners WHERE id=?').bind(partnerId).first<{currency:string}>();
  if(!rule)return{error:'partner_not_found',statusCode:404};
  const effectiveAmount=saleAmountCents??currentSaleAmountCents;
  const effectiveCurrency=(saleCurrency??currentSaleCurrency)?.toUpperCase();
  if(effectiveAmount===null||effectiveAmount===undefined||!effectiveCurrency)return{error:'sale_amount_required',statusCode:422};
  if(!validCurrency(effectiveCurrency))return{error:'invalid_currency',statusCode:422};
  if(effectiveCurrency!==rule.currency)return{error:'sale_currency_must_match_partner_currency',statusCode:409};
  const leadPassengers=await env.DB.prepare('SELECT adults+children+infants count FROM lead_requests WHERE id=?').bind(leadId).first<{count:number}>();
  const passengerCount=Number(leadPassengers?.count||0);if(passengerCount<1)return{error:'invalid_passenger_count',statusCode:422};
  const monthStart=lisbonMonthStartUtc(new Date()).toISOString();
  const monthPassengers=await env.DB.prepare("SELECT COALESCE(sum(l.adults+l.children+l.infants),0) count FROM partner_commissions pc JOIN lead_requests l ON l.id=pc.lead_request_id WHERE pc.partner_id=? AND pc.status<>'void' AND pc.created_at>=?").bind(partnerId,monthStart).first<{count:number}>();
  const policy=await getWorkerPartnerProgramPolicy(env);
  const calculated=calculateProgramCommission(effectiveAmount,passengerCount,Number(monthPassengers?.count||0),policy);
  const amountCents=calculated.amountCents,currency=effectiveCurrency,rateSnapshot=calculated.effectiveRateBps,effectiveSaleAmountCents=effectiveAmount;
  const id=crypto.randomUUID();
  try {
    await env.DB.prepare(`INSERT INTO partner_commissions (id,partner_id,lead_request_id,amount_cents,currency,status,commission_type_snapshot,commission_rate_snapshot,sale_amount_cents_snapshot,created_by,commission_policy_snapshot,passenger_count_snapshot,month_passenger_start_snapshot) VALUES (?,?,?,?,?,'pending','percentage',?,?,?,?,?,?)`)
      .bind(id,partnerId,leadId,amountCents,currency,rateSnapshot,effectiveSaleAmountCents,actorUserId,JSON.stringify(policy),passengerCount,calculated.startPosition).run();
  } catch (error) {
    // Lost a race against a concurrent conversion request enforced by the partial unique index;
    // fall back to whatever the winner created.
    const raceExisting=await env.DB.prepare("SELECT amount_cents,currency FROM partner_commissions WHERE lead_request_id=? AND status<>'void'").bind(leadId).first<{amount_cents:number;currency:string}>();
    return raceExisting?{amountCents:raceExisting.amount_cents,currency:raceExisting.currency}:{error:'commission_not_created',statusCode:500};
  }
  await audit(env,actorUserId,'admin.commission_created','partner_commission',id);
  return{amountCents,currency};
}

async function adminLeadUpdate(req:Request,env:Env,id:string){
  const auth=await mutationAuth(req,env);if(!auth)return reply({error:'unauthorized'},401);if(!auth.roles.includes('master'))return reply({error:'forbidden'},403);
  const b=await body(req);const status=typeof b?.status==='string'&&leadStatuses.includes(b.status)?b?.status:null;const notes=text(b?.internalNotes,3000),assign=b?.assignToMe===true;
  const saleAmountCents=Number.isInteger(b?.saleAmountCents)&&Number(b?.saleAmountCents)>=0?Number(b?.saleAmountCents):null;
  const saleCurrencyRaw=typeof b?.saleCurrency==='string'&&b.saleCurrency.length===3?b?.saleCurrency.toUpperCase():null;
  const voidReason=text(b?.voidCommissionReason,500,3);
  if(!status)return reply({error:'invalid_request'},400);
  if(saleCurrencyRaw!==null&&!validCurrency(saleCurrencyRaw))return reply({error:'invalid_currency'},422);
  const existing=await env.DB.prepare("SELECT id,status,partner_id,protocol,destination,sale_amount_cents,sale_currency FROM lead_requests WHERE id=? AND kind='flight_quote'").bind(id).first<Row>();
  if(!existing)return reply({error:'not_found'},404);

  // Everything below is submitted as a single env.DB.batch() call, which D1 runs as one atomic
  // unit (all statements succeed or none do) — mirroring the single database transaction the
  // Node/Postgres backend uses for the same operation, so a failure partway through can never
  // leave a converted proposal without its expected commission, nor a commission without its
  // proposal update. The lead UPDATE at the end carries an optimistic-concurrency guard
  // (WHERE status=? matching the status just read above) so a second D1 batch that started
  // concurrently against the same row cannot silently clobber this one's effects.
  const statements: D1PreparedStatement[] = [];

  if(existing.status==='converted'&&status!=='converted'){
    const paid=await env.DB.prepare("SELECT id FROM partner_commissions WHERE lead_request_id=? AND status='paid'").bind(id).first<Row>();
    if(paid)return reply({error:'commission_paid_immutable'},409);
    const active=await env.DB.prepare("SELECT id FROM partner_commissions WHERE lead_request_id=? AND status IN ('pending','approved')").bind(id).first<Row>();
    if(active){
      if(!voidReason)return reply({error:'commission_void_reason_required'},409);
      statements.push(env.DB.prepare("UPDATE partner_commissions SET status='void',voided_at=CURRENT_TIMESTAMP,voided_by=?,void_reason=?,updated_at=CURRENT_TIMESTAMP WHERE lead_request_id=? AND status IN ('pending','approved')").bind(auth.userId,voidReason,id));
      statements.push(env.DB.prepare('INSERT INTO audit_events(id,actor_user_id,action,target_type,target_id) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),auth.userId,'admin.commission_voided','lead_request',id));
    }
  }

  let commissionPreview:{amountCents:number;currency:string}|{error:string}|null=null;
  let finalSaleAmountCents=existing.sale_amount_cents as number|null;
  let finalSaleCurrency=existing.sale_currency as string|null;
  if(status==='converted'){
    // Must persist for every converted lead, not only ones with a referring partner — a lead
    // with no partner_id has no commission to compute, but its sale amount is still the source
    // of truth the finance module (fin_sales) reads from. A repeated/idempotent conversion call
    // that omits saleAmountCents/saleCurrency must never null out financial data that already
    // exists on the proposal.
    finalSaleAmountCents=saleAmountCents??(existing.sale_amount_cents as number|null);
    finalSaleCurrency=saleCurrencyRaw??(existing.sale_currency as string|null);
    if(existing.partner_id){
      const created=await createCommissionForLead(env,auth.userId,id,String(existing.partner_id),saleAmountCents,saleCurrencyRaw,existing.sale_amount_cents as number|null,existing.sale_currency as string|null);
      if('error'in created)return reply({error:created.error},created.statusCode);
      commissionPreview=created;
    }
  }

  statements.push(
    env.DB.prepare(`UPDATE lead_requests SET status=?,internal_notes=?,assigned_to=CASE WHEN ? THEN ? ELSE assigned_to END,
      sale_amount_cents=CASE WHEN ?='converted' THEN ? ELSE sale_amount_cents END,
      sale_currency=CASE WHEN ?='converted' THEN ? ELSE sale_currency END,
      converted_at=CASE WHEN ?='converted' THEN COALESCE(converted_at,CURRENT_TIMESTAMP) ELSE converted_at END,
      updated_at=CURRENT_TIMESTAMP WHERE id=? AND kind='flight_quote' AND status=?`)
      .bind(status,notes,assign?1:0,auth.userId,status,finalSaleAmountCents,status,finalSaleCurrency,status,id,existing.status),
  );
  const leadUpdateIndex=statements.length-1;
  statements.push(env.DB.prepare('INSERT INTO audit_events(id,actor_user_id,action,target_type,target_id) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),auth.userId,'admin.lead_updated','lead_request',id));
  if(status==='converted'&&existing.partner_id){
    statements.push(
      env.DB.prepare(`INSERT INTO notification_outbox (id,idempotency_key,event_type,partner_id,payload) VALUES (?,?,'proposal_converted',?,?) ON CONFLICT(idempotency_key) DO NOTHING`)
        .bind(crypto.randomUUID(),`proposal_converted:${id}`,existing.partner_id,JSON.stringify({leadId:id,protocol:existing.protocol})),
    );
  }
  const results=await env.DB.batch(statements);
  const leadUpdateResult=results[leadUpdateIndex];
  if(!leadUpdateResult?.meta.changes)return reply({error:'conflict_retry'},409);
  return reply({lead:{id,status,internal_notes:notes,assigned_to:assign?auth.userId:null,updated_at:new Date().toISOString()},commissionPreview});
}

async function flightQuoteLead(req:Request,env:Env){
  const b=await body(req);
  const name=text(b?.name,120,2),email=emailOf(b?.email),phoneDigits=customerPhoneDigits(b?.phone),phone=phoneDigits?`+${phoneDigits}`:null,origin=text(b?.origem,160,2),destination=text(b?.destino,160,2);
  const outbound=dateOf(b?.ida),returnOn=b?.volta?dateOf(b.volta):null,adults=intOf(b?.adults,1,20),children=intOf(b?.children,0,20),infants=intOf(b?.infants,0,20);
  const tripType=b?.tipo==='Ida e volta'||b?.tipo==='Somente ida'?b.tipo:null;
  const cabin=['Econômica','Premium Economy','Executiva','Primeira classe'].includes(String(b?.cabinClass))?String(b?.cabinClass):null;
  const baggage=['Somente item pessoal','Bagagem de mão','Bagagem despachada','Ainda não sei'].includes(String(b?.baggage))?String(b?.baggage):null;
  const flexibility=['Datas fixas','Até 3 dias','Até 7 dias','Datas flexíveis'].includes(String(b?.flexibility))?String(b?.flexibility):null;
  const payment=['Pix','Cartão de crédito em até 12x','Ainda não sei','Dinheiro','Milhas','Dinheiro ou milhas'].includes(String(b?.paymentPreference))?String(b?.paymentPreference):null,notes=text(b?.observacoes,3000);
  const stops=stopsPreferenceOf(b?.stopsPreference),submissionId=submissionIdOf(b?.submissionId),source=visitSourceOf(b?.source);
  // O aceite só vale para o WhatsApp quando veio do texto atual do formulário (que cita o WhatsApp).
  const whatsappConsent=b?.contactConsent===true&&b?.consentVersion===QUOTE_CONSENT_VERSION;
  if(typeof b?.phone==='string'&&b.phone.trim()&&!phoneDigits)return reply({error:'invalid_phone'},400);
  if(b?.type!=='quote'||!name||!email||!phone||!phoneDigits||!origin||!destination||!outbound||adults===null||children===null||infants===null||!tripType||!cabin||!baggage||!flexibility||!payment||stops===false||submissionId===false||b?.contactConsent!==true||(tripType==='Ida e volta'&&!returnOn)||(returnOn&&returnOn<outbound))return reply({error:'invalid_request'},400);
  // Reenvio do mesmo envio (clique duplo, rede caiu, recarregou): devolve o protocolo já gravado, sem novo pedido nem novo e-mail.
  const submissionHash=submissionId?await sha(JSON.stringify([name,email,phoneDigits,origin,destination,outbound,returnOn,adults,children,infants,tripType,cabin,baggage,flexibility,payment,notes,stops])):null;
  if(submissionId){const prior=await priorSubmission(env,submissionId,submissionHash!);if(prior)return prior;}
  if(!(await rateLimit(req,env,'flight_quote',email,4,1800)))return reply({error:'try_again_later'},429);
  const id=crypto.randomUUID(),deadline=isoAfter(48*3600),year=new Date().getUTCFullYear();
  const howHeard=typeof b?.howHeard==='string'?b.howHeard:null;
  const manualCode=howHeard==='Indicação de um parceiro/influenciador'&&typeof b?.referralCode==='string'?b.referralCode:null;
  const attribution=await resolveAttribution(req,env,manualCode);
  const fields:Record<string,unknown>={id,kind:'flight_quote',customer_name:name,customer_email:email,customer_phone:phone,customer_phone_digits:phoneDigits,
    origin,destination,outbound_on:outbound,return_on:returnOn,passengers:`${adults} adulto(s), ${children} criança(s), ${infants} bebê(s)`,adults,children,infants,
    trip_type:tripType,cabin_class:cabin,baggage,date_flexibility:flexibility,payment_preference:payment,notes,stops_preference:stops,
    contact_consent:1,consent_version:whatsappConsent?QUOTE_CONSENT_VERSION:null,status:'new',deadline_at:deadline,ip_hash:await sha(clientKey(req)),
    partner_id:attribution?.partnerId??null,referral_code_snapshot:attribution?.code??null,referral_source:attribution?.source??'none',
    referral_captured_at:attribution?.capturedAtIso??null,attribution_expires_at:attribution?.expiresAtIso??null,
    submission_id:submissionId,submission_hash:submissionHash,...source};
  const columns=Object.keys(fields);
  // Protocolo RC-AAAA-NNNNN: contador do ano e pedido na mesma transação (D1 batch), então não há número repetido nem pulado por falha.
  let protocol:string;
  try{
    const results=await env.DB.batch([
      env.DB.prepare('INSERT INTO protocol_counters(year,last_value) VALUES(?,1) ON CONFLICT(year) DO UPDATE SET last_value=last_value+1').bind(year),
      env.DB.prepare(`INSERT INTO lead_requests (${columns.join(',')},protocol,updated_at,whatsapp_consent_at)
        VALUES (${columns.map(()=>'?').join(',')},(SELECT printf('RC-%04d-%05d',year,last_value) FROM protocol_counters WHERE year=?),CURRENT_TIMESTAMP,${whatsappConsent?'CURRENT_TIMESTAMP':'NULL'}) RETURNING protocol`)
        .bind(...Object.values(fields),year),
    ]);
    protocol=String((results[1]?.results?.[0] as Row|undefined)?.protocol??'');
  }catch(error){
    // Dois envios iguais ao mesmo tempo: o índice único de submission_id barra o segundo, que devolve o protocolo do primeiro.
    if(submissionId&&String(error instanceof Error?error.message:error).includes('UNIQUE')){const prior=await priorSubmission(env,submissionId,submissionHash!);if(prior)return prior;}
    throw error;
  }
  if(!protocol)throw new Error('protocol_not_generated');
  if(attribution){
    await env.DB.prepare(`INSERT INTO notification_outbox (id,idempotency_key,event_type,partner_id,payload) VALUES (?,?,'referral_confirmed',?,?) ON CONFLICT(idempotency_key) DO NOTHING`)
      .bind(crypto.randomUUID(),`referral_confirmed:${id}`,attribution.partnerId,JSON.stringify({leadId:id,protocol,destination})).run();
  }
  const masters=await env.DB.prepare("SELECT u.id,u.email FROM users u JOIN user_roles r ON r.user_id=u.id WHERE r.role='master' AND u.status='active' AND u.email_verified_at IS NOT NULL").all<Row>();
  const route=`${origin} → ${destination}`,adminUrl=`${env.APP_ORIGIN.replace(/\/$/,'')}/admin.html`;
  const whatsappUrl=whatsappHandoffUrl(protocol);
  const customerHtml=`<p>Olá, ${html(name)}.</p><p>Recebemos sua solicitação de proposta para <strong>${html(route)}</strong>.</p><p>Protocolo: <strong>${protocol}</strong></p><p>O atendimento continua pelo WhatsApp. Se ainda não enviou a mensagem com o seu protocolo, é só tocar aqui: <a href="${html(whatsappUrl)}">Continuar atendimento pelo WhatsApp</a>.</p><p>Rota Certa Passagens</p>`;
  const customerText=`Olá, ${name}. Recebemos sua solicitação para ${route}. Protocolo: ${protocol}. O atendimento continua pelo WhatsApp: ${whatsappUrl}`;
  const masterHtml=`<p>Nova proposta de voo recebida.</p><p><strong>${protocol}</strong> — ${html(route)}</p><p>Cliente: ${html(name)} (${html(email)})</p><p>Prazo: ${html(deadline)}</p><p><a href="${html(adminUrl)}">Abrir Central de Propostas</a></p>`;
  const masterText=`Nova proposta ${protocol}: ${route}. Cliente: ${name} (${email}). Prazo: ${deadline}. Painel: ${adminUrl}`;
  const customer=await Promise.allSettled([sendEmail(env,null,email,'flight_quote_customer',`Recebemos sua solicitação ${protocol}`,customerHtml,customerText)]);
  const masterResults=await Promise.allSettled(masters.results.map(m=>sendEmail(env,String(m.id),String(m.email),'flight_quote_master',`Nova proposta de voo ${protocol}`,masterHtml,masterText)));
  return reply({...quoteReceived(protocol),responseDeadlineHours:48,confirmationEmailSent:customer[0]?.status==='fulfilled',mastersNotified:masterResults.filter(x=>x.status==='fulfilled').length},201);
}
function quoteReceived(protocol:string){return {ok:true,protocol,status:RECEIVED_STATUS,statusLabel:RECEIVED_STATUS_LABEL,whatsappUrl:whatsappHandoffUrl(protocol)};}
async function priorSubmission(env:Env,submissionId:string,submissionHash:string){
  const prior=await env.DB.prepare("SELECT protocol,submission_hash FROM lead_requests WHERE submission_id=? AND kind='flight_quote'").bind(submissionId).first<{protocol:string;submission_hash:string|null}>();
  if(!prior)return null;
  // Mesmo identificador com dados diferentes: a página gera outro identificador e envia como pedido novo.
  if(prior.submission_hash!==submissionHash)return reply({error:'submission_conflict'},409);
  return reply({...quoteReceived(prior.protocol),replayed:true});
}

async function audit(env:Env,actor:string|null,action:string,targetType:string,targetId:string|null){await env.DB.prepare('INSERT INTO audit_events(id,actor_user_id,action,target_type,target_id) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),actor,action,targetType,targetId).run();}

async function plannerGet(req:Request,env:Env,url:URL){const a=await getAuth(req,env);if(!a)return reply({error:'unauthorized'},401);const access=await requirePlannerAccess(a,env);if(!access)return reply({error:'free_trial_expired',upgrade_required:true},402);await applyPendingFlights(env,a.userId,a.email);const id=url.searchParams.get('tripId');const trip=id?await env.DB.prepare('SELECT id,name,destination,starts_on,ends_on,source,travelers,archived_at,companions,share_token FROM trips WHERE id=? AND owner_user_id=?').bind(id,a.userId).first<Row>():await env.DB.prepare('SELECT id,name,destination,starts_on,ends_on,source,travelers,archived_at,companions,share_token FROM trips WHERE owner_user_id=? ORDER BY (archived_at IS NOT NULL),updated_at DESC LIMIT 1').bind(a.userId).first<Row>();if(!trip)return reply({error:'trip_not_found'},404);const tripId=String(trip.id);const [it,places,expenses,budget,checklist,trips,files]=await Promise.all([env.DB.prepare('SELECT id,day_number day,starts_at time,title,kind,notes,booking_code,booking_url,source FROM itinerary_items WHERE owner_user_id=? AND trip_id=? ORDER BY day_number,sort_order,starts_at').bind(a.userId,tripId).all(),env.DB.prepare('SELECT id,name,category,address,notes,latitude,longitude FROM places WHERE owner_user_id=? AND trip_id=? ORDER BY created_at').bind(a.userId,tripId).all(),env.DB.prepare('SELECT id,category,description,amount_cents,currency,spent_on,paid_by FROM expenses WHERE owner_user_id=? AND trip_id=? ORDER BY created_at DESC').bind(a.userId,tripId).all(),env.DB.prepare('SELECT amount_cents,currency FROM budgets WHERE owner_user_id=? AND trip_id=?').bind(a.userId,tripId).first(),env.DB.prepare('SELECT id,text,completed,sort_order FROM checklist_items WHERE owner_user_id=? AND trip_id=? ORDER BY sort_order,created_at').bind(a.userId,tripId).all(),env.DB.prepare('SELECT id,name,destination,starts_on,ends_on,travelers,archived_at,updated_at FROM trips WHERE owner_user_id=? ORDER BY (archived_at IS NOT NULL),updated_at DESC').bind(a.userId).all(),env.DB.prepare('SELECT id,item_id,name,content_type,size,created_at FROM planner_attachments WHERE owner_user_id=? AND trip_id=? ORDER BY created_at').bind(a.userId,tripId).all()]);return reply({trip,trips:trips.results,entitlement:access,itinerary:it.results,places:places.results,expenses:expenses.results,budget:budget||{amount_cents:0,currency:'EUR'},checklist:checklist.results.map((x:Row)=>({...x,completed:Boolean(x.completed)})),attachments:files.results});}
async function plannerTrip(req:Request,env:Env){const a=await mutationAuth(req,env);if(!a)return reply({error:'unauthorized'},401);const access=await requirePlannerAccess(a,env);if(!access)return reply({error:'free_trial_expired',upgrade_required:true},402);if(!(await canCreateActiveTrip(a,env,access)))return reply({error:'free_active_trip_limit',upgrade_required:true},403);const b=await body(req);const name=text(b?.name,120,1);if(!name)return reply({error:'invalid_trip'},400);const id=crypto.randomUUID();const travelers=Number.isInteger(b?.travelers)?Number(b?.travelers):1;await env.DB.batch([env.DB.prepare('INSERT INTO trips(id,owner_user_id,name,destination,starts_on,ends_on,travelers) VALUES(?,?,?,?,?,?,?)').bind(id,a.userId,name,text(b?.destination,180),text(b?.startsOn,10),text(b?.endsOn,10),travelers),env.DB.prepare("INSERT INTO budgets(trip_id,owner_user_id,amount_cents,currency) VALUES(?,?,0,'EUR')").bind(id,a.userId)]);return reply({id},201);}
async function plannerTripAction(req:Request,env:Env,tripId:string,action:string){const a=await mutationAuth(req,env);if(!a)return reply({error:'unauthorized'},401);const access=await requirePlannerAccess(a,env);if(!access)return reply({error:'free_trial_expired',upgrade_required:true},402);const trip=await env.DB.prepare('SELECT id,archived_at FROM trips WHERE id=? AND owner_user_id=?').bind(tripId,a.userId).first<Row>();if(!trip)return reply({error:'trip_not_found'},404);if(action==='archive'){if(trip.archived_at)return reply({ok:true});if(!access.unlimited){const count=await env.DB.prepare('SELECT count(*) n FROM trips WHERE owner_user_id=? AND archived_at IS NOT NULL').bind(a.userId).first<{n:number}>();if(Number(count?.n||0)>=2)return reply({error:'free_archived_trip_limit',upgrade_required:true},403);}await env.DB.prepare('UPDATE trips SET archived_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND owner_user_id=?').bind(tripId,a.userId).run();await audit(env,a.userId,'planner.trip_archived','trip',tripId);return reply({ok:true});}if(action==='restore'){if(!trip.archived_at)return reply({ok:true});if(!(await canCreateActiveTrip(a,env,access)))return reply({error:'free_active_trip_limit',upgrade_required:true},403);await env.DB.prepare('UPDATE trips SET archived_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND owner_user_id=?').bind(tripId,a.userId).run();await audit(env,a.userId,'planner.trip_restored','trip',tripId);return reply({ok:true});}return reply({error:'not_found'},404);}
async function ownedTrip(env:Env,userId:string,tripId:string){return await env.DB.prepare('SELECT archived_at FROM trips WHERE id=? AND owner_user_id=?').bind(tripId,userId).first<Row>();}
async function plannerItem(req:Request,env:Env,tripId:string,kind:string,itemId?:string){const a=await mutationAuth(req,env);if(!a)return reply({error:'unauthorized'},401);if(!(await requirePlannerAccess(a,env)))return reply({error:'free_trial_expired',upgrade_required:true},402);const trip=await ownedTrip(env,a.userId,tripId);if(!trip)return reply({error:'trip_not_found'},404);if(trip.archived_at)return reply({error:'trip_archived'},409);const b=await body(req);
  if(req.method==='DELETE'&&itemId){const table=kind==='itinerary'?'itinerary_items':kind==='places'?'places':kind==='expenses'?'expenses':kind==='checklist'?'checklist_items':null;if(!table)return reply({error:'invalid_item'},400);const r=await env.DB.prepare(`DELETE FROM ${table} WHERE id=? AND trip_id=? AND owner_user_id=?`).bind(itemId,tripId,a.userId).run();return r.meta.changes?reply({ok:true}):reply({error:'item_not_found'},404);}
  if(kind==='budget'&&req.method==='PUT'){const amount=Number(b?.amount);const currency=b?.currency===undefined?null:['EUR','BRL'].includes(String(b.currency))?String(b.currency):false;if(!Number.isFinite(amount)||amount<0||currency===false)return reply({error:'invalid_budget'},400);await env.DB.prepare('UPDATE budgets SET amount_cents=?,currency=COALESCE(?,currency),updated_at=CURRENT_TIMESTAMP WHERE trip_id=? AND owner_user_id=?').bind(Math.round(amount*100),currency,tripId,a.userId).run();return reply({ok:true});}
  if(kind==='checklist'&&req.method==='PATCH'&&itemId){if(typeof b?.completed!=='boolean')return reply({error:'invalid_checklist_item'},400);const r=await env.DB.prepare('UPDATE checklist_items SET completed=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND trip_id=? AND owner_user_id=?').bind(b.completed?1:0,itemId,tripId,a.userId).run();return r.meta.changes?reply({ok:true}):reply({error:'item_not_found'},404);}
  if(kind==='itinerary'&&req.method==='PATCH'&&itemId)return plannerItineraryPatch(env,a.userId,tripId,itemId,b);
  const id=crypto.randomUUID();
  if(kind==='itinerary'&&req.method==='POST'){const day=Number(b?.day),title=text(b?.title,240,1),itemKind=text(b?.kind,60,1);if(!Number.isInteger(day)||day<1||!title||!itemKind)return reply({error:'invalid_itinerary_item'},400);const code=bookingCodeOf(b?.bookingCode),link=bookingUrlOf(b?.bookingUrl);if(code===false)return reply({error:'invalid_booking_code'},400);if(link===false)return reply({error:'invalid_booking_url'},400);await env.DB.prepare('INSERT INTO itinerary_items(id,trip_id,owner_user_id,day_number,starts_at,title,kind,notes,booking_code,booking_url) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(id,tripId,a.userId,day,text(b?.time,5),title,itemKind,text(b?.notes,2000),code??null,link??null).run();return reply({id},201);}
  if(kind==='places'&&req.method==='POST'){const name=text(b?.name,240,1),category=text(b?.category,60,1);if(!name||!category)return reply({error:'invalid_place'},400);await env.DB.prepare('INSERT INTO places(id,trip_id,owner_user_id,name,category,address,notes) VALUES(?,?,?,?,?,?,?)').bind(id,tripId,a.userId,name,category,text(b?.address,500),text(b?.notes,2000)).run();return reply({id},201);}
  if(kind==='expenses'&&req.method==='POST'){const amount=Number(b?.amount),category=text(b?.category,60,1),description=text(b?.description,500,1);const currency=b?.currency===undefined?'EUR':(CURRENCIES as readonly string[]).includes(String(b.currency))?String(b.currency):null;const paidBy=text(b?.paidBy,60)||null;if(!Number.isFinite(amount)||amount<=0||!category||!description||!currency)return reply({error:'invalid_expense'},400);await env.DB.prepare('INSERT INTO expenses(id,trip_id,owner_user_id,category,description,amount_cents,currency,paid_by) VALUES(?,?,?,?,?,?,?,?)').bind(id,tripId,a.userId,category,description,Math.round(amount*100),currency,paidBy).run();return reply({id},201);}
  if(kind==='checklist'&&req.method==='POST'){const itemText=text(b?.text,300,1);if(!itemText)return reply({error:'invalid_checklist_item'},400);await env.DB.prepare('INSERT INTO checklist_items(id,trip_id,owner_user_id,text,sort_order) VALUES(?,?,?,?,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM checklist_items WHERE trip_id=? AND owner_user_id=?))').bind(id,tripId,a.userId,itemText,tripId,a.userId).run();return reply({id},201);}return reply({error:'not_found'},404);
}
async function plannerImport(req:Request,env:Env){const a=await mutationAuth(req,env);if(!a)return reply({error:'unauthorized'},401);const access=await requirePlannerAccess(a,env);if(!access)return reply({error:'free_trial_expired',upgrade_required:true},402);if(!(await canCreateActiveTrip(a,env,access)))return reply({error:'free_active_trip_limit',upgrade_required:true},403);const b=await body(req);if(!b||!Array.isArray(b.itinerary)||!Array.isArray(b.places)||!Array.isArray(b.expenses)||!Array.isArray(b.checklist))return reply({error:'invalid_import'},400);const id=crypto.randomUUID();await env.DB.batch([env.DB.prepare("INSERT INTO trips(id,owner_user_id,name,source) VALUES(?,?,'Viagem importada do navegador','local_import')").bind(id,a.userId),env.DB.prepare("INSERT INTO budgets(trip_id,owner_user_id,amount_cents,currency) VALUES(?,?,?,'EUR')").bind(id,a.userId,Math.round(Number(b.budget||0)*100))]);const stmts:D1PreparedStatement[]=[];for(const x of b.itinerary.slice(0,1000) as Row[]){const title=text(x.what,240,1);if(title)stmts.push(env.DB.prepare('INSERT INTO itinerary_items(id,trip_id,owner_user_id,day_number,starts_at,title,kind,notes) VALUES(?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),id,a.userId,Math.max(1,Number(x.day)||1),text(x.time,5),title,text(x.type,60)||'Atividade',text(x.notes,2000)));}for(const x of b.places.slice(0,1000) as Row[]){const name=text(x.name,240,1);if(name)stmts.push(env.DB.prepare('INSERT INTO places(id,trip_id,owner_user_id,name,category,address,notes) VALUES(?,?,?,?,?,?,?)').bind(crypto.randomUUID(),id,a.userId,name,text(x.type,60)||'Outro',text(x.address,500),text(x.notes,2000)));}for(const x of b.expenses.slice(0,1000) as Row[]){const amount=Number(x.value),description=text(x.desc,500,1);if(amount>0&&description)stmts.push(env.DB.prepare("INSERT INTO expenses(id,trip_id,owner_user_id,category,description,amount_cents,currency) VALUES(?,?,?,?,?,?,'EUR')").bind(crypto.randomUUID(),id,a.userId,text(x.type,60)||'Outros',description,Math.round(amount*100)));}for(const [i,x] of (b.checklist.slice(0,1000) as Row[]).entries()){const t=text(x.text,300,1);if(t)stmts.push(env.DB.prepare('INSERT INTO checklist_items(id,trip_id,owner_user_id,text,completed,sort_order) VALUES(?,?,?,?,?,?)').bind(crypto.randomUUID(),id,a.userId,t,x.done?1:0,i));}for(let i=0;i<stmts.length;i+=100)await env.DB.batch(stmts.slice(i,i+100));return reply({id},201);}

// --- Planner: reserva e anexos de cada item do roteiro ---------------------------------------
// Anexos ficam no D1 em base64 (o R2 exige cartão). Os limites protegem o banco de 500 MB do plano grátis.
const ATTACH_MAX_BYTES=1_400_000,ATTACH_PER_ITEM=5,ATTACH_USER_QUOTA=20_000_000,ATTACH_GLOBAL_QUOTA=150_000_000;
/** undefined = não mexer; null = apagar; false = inválido. */
function bookingCodeOf(v:unknown):string|null|undefined|false{if(v===undefined)return undefined;if(v===null||v==='')return null;return text(v,80,1)??false;}
function bookingUrlOf(v:unknown):string|null|undefined|false{
  if(v===undefined)return undefined;if(v===null||v==='')return null;if(typeof v!=='string'||v.trim().length>500)return false;
  try{const u=new URL(v.trim());return u.protocol==='https:'||u.protocol==='http:'?u.toString():false;}catch{return false;}
}
async function plannerItineraryPatch(env:Env,userId:string,tripId:string,itemId:string,b:Row|null){
  if(!b)return reply({error:'invalid_itinerary_item'},400);
  const sets:string[]=[],vals:unknown[]=[];
  if(b.day!==undefined){const day=Number(b.day);if(!Number.isInteger(day)||day<1)return reply({error:'invalid_itinerary_item'},400);sets.push('day_number=?');vals.push(day);}
  if(b.time!==undefined){sets.push('starts_at=?');vals.push(text(b.time,5)||null);}
  if(b.title!==undefined){const title=text(b.title,240,1);if(!title)return reply({error:'invalid_itinerary_item'},400);sets.push('title=?');vals.push(title);}
  if(b.kind!==undefined){const kind=text(b.kind,60,1);if(!kind)return reply({error:'invalid_itinerary_item'},400);sets.push('kind=?');vals.push(kind);}
  if(b.notes!==undefined){sets.push('notes=?');vals.push(text(b.notes,2000)||null);}
  const code=bookingCodeOf(b.bookingCode);if(code===false)return reply({error:'invalid_booking_code'},400);if(code!==undefined){sets.push('booking_code=?');vals.push(code);}
  const link=bookingUrlOf(b.bookingUrl);if(link===false)return reply({error:'invalid_booking_url'},400);if(link!==undefined){sets.push('booking_url=?');vals.push(link);}
  if(!sets.length)return reply({error:'invalid_itinerary_item'},400);
  const r=await env.DB.prepare(`UPDATE itinerary_items SET ${sets.join(',')} WHERE id=? AND trip_id=? AND owner_user_id=?`).bind(...vals,itemId,tripId,userId).run();
  return r.meta.changes?reply({ok:true}):reply({error:'item_not_found'},404);
}
/** Tipo pelo conteúdo (assinatura do arquivo), nunca pelo nome ou pelo que o navegador declarou. */
function attachmentType(bytes:Uint8Array):string|null{
  const ascii=(from:number,to:number)=>String.fromCharCode(...bytes.slice(from,to));
  if(bytes.length>=5&&ascii(0,5)==='%PDF-')return 'application/pdf';
  if(bytes.length>=3&&bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff)return 'image/jpeg';
  if(bytes.length>=8&&bytes[0]===0x89&&ascii(1,4)==='PNG')return 'image/png';
  if(bytes.length>=12&&ascii(0,4)==='RIFF'&&ascii(8,12)==='WEBP')return 'image/webp';
  return null;
}
function attachmentName(value:unknown,type:string){
  const clean=typeof value==='string'?value.normalize('NFC').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g,' ').replace(/\s+/g,' ').trim().slice(0,120):'';
  const ext=type==='application/pdf'?'.pdf':type==='image/png'?'.png':type==='image/webp'?'.webp':'.jpg';
  const name=clean||'Anexo';
  return /\.[a-z0-9]{2,4}$/i.test(name)?name:name+ext;
}
async function plannerAttachmentUpload(req:Request,env:Env,tripId:string,itemId:string){
  const a=await mutationAuth(req,env);if(!a)return reply({error:'unauthorized'},401);
  if(!(await requirePlannerAccess(a,env)))return reply({error:'free_trial_expired',upgrade_required:true},402);
  const trip=await ownedTrip(env,a.userId,tripId);if(!trip)return reply({error:'trip_not_found'},404);if(trip.archived_at)return reply({error:'trip_archived'},409);
  const item=await env.DB.prepare('SELECT id FROM itinerary_items WHERE id=? AND trip_id=? AND owner_user_id=?').bind(itemId,tripId,a.userId).first();if(!item)return reply({error:'item_not_found'},404);
  if(Number(req.headers.get('content-length')||0)>ATTACH_MAX_BYTES+64_000)return reply({error:'attachment_too_large'},413);
  let form:FormData;try{form=await req.formData();}catch{return reply({error:'invalid_upload'},400);}
  const file=form.get('file');if(!file||typeof file==='string')return reply({error:'invalid_upload'},400);
  const bytes=new Uint8Array(await (file as File).arrayBuffer());
  if(!bytes.length)return reply({error:'invalid_upload'},400);if(bytes.length>ATTACH_MAX_BYTES)return reply({error:'attachment_too_large'},413);
  const type=attachmentType(bytes);if(!type)return reply({error:'unsupported_attachment_type'},415);
  const [perItem,perUser,global]=await Promise.all([
    env.DB.prepare('SELECT count(*) n FROM planner_attachments WHERE item_id=? AND owner_user_id=?').bind(itemId,a.userId).first<{n:number}>(),
    env.DB.prepare('SELECT COALESCE(SUM(size),0) n FROM planner_attachments WHERE owner_user_id=?').bind(a.userId).first<{n:number}>(),
    env.DB.prepare('SELECT COALESCE(SUM(size),0) n FROM planner_attachments').first<{n:number}>(),
  ]);
  if(Number(perItem?.n||0)>=ATTACH_PER_ITEM)return reply({error:'attachment_item_limit'},409);
  if(Number(perUser?.n||0)+bytes.length>ATTACH_USER_QUOTA)return reply({error:'attachment_quota_exceeded'},409);
  if(Number(global?.n||0)+bytes.length>ATTACH_GLOBAL_QUOTA)return reply({error:'attachment_storage_full'},507);
  const id=crypto.randomUUID(),name=attachmentName(form.get('name')??(file as File).name,type);
  // Os limites por item e por conta são conferidos de novo dentro do próprio INSERT (dois envios ao mesmo tempo não passam juntos).
  const r=await env.DB.prepare(`INSERT INTO planner_attachments(id,trip_id,item_id,owner_user_id,name,content_type,size,data)
    SELECT ?,?,?,?,?,?,?,? WHERE (SELECT count(*) FROM planner_attachments WHERE item_id=? AND owner_user_id=?)<?
    AND (SELECT COALESCE(SUM(size),0) FROM planner_attachments WHERE owner_user_id=?)+?<=?`)
    .bind(id,tripId,itemId,a.userId,name,type,bytes.length,Buffer.from(bytes).toString('base64'),itemId,a.userId,ATTACH_PER_ITEM,a.userId,bytes.length,ATTACH_USER_QUOTA).run();
  if(!r.meta.changes)return reply({error:'attachment_item_limit'},409);
  return reply({id,name,contentType:type,size:bytes.length},201);
}
async function plannerAttachment(req:Request,env:Env,tripId:string,id:string){
  if(req.method==='DELETE'){
    const a=await mutationAuth(req,env);if(!a)return reply({error:'unauthorized'},401);
    const trip=await ownedTrip(env,a.userId,tripId);if(!trip)return reply({error:'trip_not_found'},404);if(trip.archived_at)return reply({error:'trip_archived'},409);
    const r=await env.DB.prepare('DELETE FROM planner_attachments WHERE id=? AND trip_id=? AND owner_user_id=?').bind(id,tripId,a.userId).run();
    return r.meta.changes?reply({ok:true}):reply({error:'attachment_not_found'},404);
  }
  if(req.method!=='GET')return reply({error:'not_found'},404);
  // Só o dono abre o arquivo. Continua disponível mesmo com o teste Free vencido: o bilhete é do cliente.
  const a=await getAuth(req,env);if(!a)return reply({error:'unauthorized'},401);
  const row=await env.DB.prepare('SELECT name,content_type,data FROM planner_attachments WHERE id=? AND trip_id=? AND owner_user_id=?').bind(id,tripId,a.userId).first<Row>();
  if(!row)return reply({error:'attachment_not_found'},404);
  const type=String(row.content_type);
  const headers=new Headers({'content-type':type,'content-disposition':`inline; filename*=UTF-8''${encodeURIComponent(String(row.name)).replace(/['()*]/g,(c)=>'%'+c.charCodeAt(0).toString(16).toUpperCase())}`,'cache-control':'private, no-store'});
  if(type.startsWith('image/'))headers.set('content-security-policy',"default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  return new Response(Buffer.from(String(row.data),'base64'),{headers});
}

// --- Partner referral program -------------------------------------------------------------

async function referralClick(req:Request,env:Env,rawCode:string){
  const fallback=()=>new Response(null,{status:302,headers:{location:'/',...{'cache-control':'no-store'}}});
  const codeValue=normalizeCode(decodeURIComponent(rawCode));
  if(!validCode(codeValue))return fallback();
  const partner=await env.DB.prepare('SELECT id,attribution_window_days FROM partners WHERE code=? AND active=1').bind(codeValue).first<{id:string;attribution_window_days:number}>();
  if(!partner)return fallback();
  // Anonymous burst-click protection, mirroring the Node backend: a repeated click from the
  // same (IP, user-agent) pair for the same code within 60s is deduplicated so it cannot inflate
  // click metrics. Reuses the same rate_limit_buckets table/helper as every other rate-limited
  // route. Only a raw client IP is never stored — `sha()` (SHA-256) is applied first, same as
  // the existing ip_hash/visitor_hash columns already did. The visitor still always gets their
  // cookie and redirect below regardless of whether this click was counted.
  const visitorKey=await sha(`${clientKey(req)}|${req.headers.get('user-agent')||''}`);
  const firstClickInWindow=await rateLimit(req,env,'referral_click',`${codeValue}:${visitorKey}`,1,60);
  if(firstClickInWindow){
    try{
      await env.DB.prepare('INSERT INTO referral_clicks (id,partner_id,landing_path,visitor_hash,ip_hash,user_agent) VALUES (?,?,?,?,?,?)')
        .bind(crypto.randomUUID(),partner.id,'/proposta-voo.html',visitorKey,await sha(clientKey(req)),(req.headers.get('user-agent')||'').slice(0,300)).run();
    }catch{/* telemetry must never block the redirect */}
  }
  const capturedAtMs=Date.now();
  const token=await signRef(codeValue,capturedAtMs,env);
  const headers=new Headers({location:`/proposta-voo.html?ref=${encodeURIComponent(codeValue)}`,'cache-control':'no-store'});
  headers.append('set-cookie',`${REF_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${partner.attribution_window_days*86400}; HttpOnly; Secure; SameSite=Lax`);
  return new Response(null,{status:302,headers});
}

async function partnerAttribution(req:Request,env:Env,url:URL){
  const attribution=await resolveAttribution(req,env,url.searchParams.get('ref'));
  if(!attribution)return reply({active:false},200,{'cache-control':'no-store'});
  const partner=await env.DB.prepare('SELECT display_name FROM partners WHERE id=?').bind(attribution.partnerId).first<{display_name:string}>();
  if(!partner)return reply({active:false},200,{'cache-control':'no-store'});
  return reply({active:true,code:attribution.code,displayName:partner.display_name},200,{'cache-control':'no-store'});
}

function serializePartnerRow(row:Row){
  return {id:row.id,code:row.code,displayName:row.display_name,instagram:row.instagram,whatsapp:row.whatsapp,email:row.email,
    commissionType:row.commission_type,commissionFixedCents:row.commission_fixed_cents,commissionPercentageBps:row.commission_percentage_bps,
    currency:row.currency,attributionWindowDays:row.attribution_window_days,active:Boolean(row.active),hasAccount:Boolean(row.user_id),accountActivated:Boolean(row.account_activated),createdAt:row.created_at,
    clicks:row.clicks,proposals:row.proposals,conversions:row.conversions,commissionPendingCents:row.commission_pending_cents,commissionApprovedCents:row.commission_approved_cents,commissionPaidCents:row.commission_paid_cents};
}

async function adminPartners(req:Request,env:Env,url:URL){
  if(!(await requireMaster(req,env)))return reply({error:'forbidden'},403);
  const activeParam=url.searchParams.get('active');
  const rows=await env.DB.prepare(`SELECT p.*,
    (SELECT count(*) FROM referral_clicks c WHERE c.partner_id=p.id) clicks,
    (SELECT count(*) FROM lead_requests l WHERE l.partner_id=p.id) proposals,
    (SELECT count(*) FROM lead_requests l WHERE l.partner_id=p.id AND l.status='converted') conversions,
    (SELECT COALESCE(sum(amount_cents),0) FROM partner_commissions pc WHERE pc.partner_id=p.id AND pc.status='pending') commission_pending_cents,
    (SELECT COALESCE(sum(amount_cents),0) FROM partner_commissions pc WHERE pc.partner_id=p.id AND pc.status='approved') commission_approved_cents,
    (SELECT COALESCE(sum(amount_cents),0) FROM partner_commissions pc WHERE pc.partner_id=p.id AND pc.status='paid') commission_paid_cents,
    (activated.user_id IS NOT NULL) account_activated
    FROM partners p LEFT JOIN (SELECT DISTINCT user_id FROM user_roles WHERE role='partner') activated ON activated.user_id=p.user_id
    ${activeParam!==null?'WHERE p.active=?':''} ORDER BY p.created_at DESC LIMIT 200`)
    .bind(...(activeParam!==null?[activeParam==='true'?1:0]:[])).all<Row>();
  return reply({partners:rows.results.map(serializePartnerRow)});
}

async function partnerApplicationCreate(req:Request,env:Env){
  const b=await body(req);
  const displayName=text(b?.displayName,120,2);
  const email=emailOf(b?.email);
  const instagram=text(b?.instagram,120,2);
  const whatsapp=phoneOf(b?.whatsapp);
  if(b?.website)return reply({ok:true},202);
  if(!displayName||!email||!instagram||!whatsapp||b?.privacyConsent!==true||b?.privacyPolicyVersion!==PARTNER_PRIVACY_POLICY_VERSION)return reply({error:'invalid_partner_application'},400);
  if(!(await rateLimit(req,env,'partner-application',email,3,3600)))return reply({error:'too_many_attempts'},429);
  const pending=await env.DB.prepare("SELECT 1 FROM partner_applications WHERE lower(email)=lower(?) AND status='pending'").bind(email).first();
  if(pending)return reply({error:'partner_application_already_pending'},409);
  const id=crypto.randomUUID();
  try{
    await env.DB.prepare("INSERT INTO partner_applications(id,display_name,email,instagram,whatsapp,privacy_consent,privacy_policy_version,privacy_consent_at) VALUES(?,?,?,?,?,1,?,CURRENT_TIMESTAMP)").bind(id,displayName,email,instagram,whatsapp,PARTNER_PRIVACY_POLICY_VERSION).run();
  }catch(error){return reply({error:'partner_application_already_pending'},409);}
  await audit(env,null,'public.partner_application_created','partner_application',id);
  return reply({ok:true},201);
}

async function adminPartnerApplications(req:Request,env:Env){
  if(!(await requireMaster(req,env)))return reply({error:'forbidden'},403);
  const rows=await env.DB.prepare("SELECT id,display_name,email,instagram,whatsapp,status,partner_id,created_at,reviewed_at,privacy_policy_version,privacy_consent_at FROM partner_applications ORDER BY CASE WHEN status='pending' THEN 0 ELSE 1 END,created_at DESC LIMIT 200").all<Row>();
  return reply({applications:rows.results.map((row)=>({id:row.id,displayName:row.display_name,email:row.email,instagram:row.instagram,whatsapp:row.whatsapp,status:row.status,partnerId:row.partner_id,createdAt:row.created_at,reviewedAt:row.reviewed_at,privacyPolicyVersion:row.privacy_policy_version,privacyConsentAt:row.privacy_consent_at}))});
}

async function getWorkerPartnerProgramPolicy(env:Env):Promise<PartnerCommissionPolicy>{
  const row=await env.DB.prepare('SELECT * FROM partner_program_settings WHERE id=1').first<Row>();
  if(!row)throw new Error('partner_program_settings_missing');
  return {mode:String(row.mode) as 'flat'|'progressive',flatBps:Number(row.flat_bps),tier1MaxPassengers:Number(row.tier1_max_passengers),tier1Bps:Number(row.tier1_bps),tier2MaxPassengers:Number(row.tier2_max_passengers),tier2Bps:Number(row.tier2_bps),tier3MaxPassengers:Number(row.tier3_max_passengers),tier3Bps:Number(row.tier3_bps),tier4Bps:Number(row.tier4_bps)};
}
async function publicPartnerProgramSettings(env:Env){return reply({settings:await getWorkerPartnerProgramPolicy(env)},200,{'cache-control':'public, max-age=300'});}
async function adminPartnerProgramSettings(req:Request,env:Env){if(!(await requireMaster(req,env)))return reply({error:'forbidden'},403);return reply({settings:await getWorkerPartnerProgramPolicy(env)});}
async function adminPartnerProgramSettingsUpdate(req:Request,env:Env){
  const auth=await mutationAuth(req,env);if(!auth)return reply({error:'unauthorized'},401);if(!auth.roles.includes('master'))return reply({error:'forbidden'},403);
  const b=await body(req);const mode=b?.mode==='flat'||b?.mode==='progressive'?b.mode:null;
  const values=['flatBps','tier1MaxPassengers','tier1Bps','tier2MaxPassengers','tier2Bps','tier3MaxPassengers','tier3Bps','tier4Bps'] as const;
  if(!mode||values.some((key)=>!Number.isInteger(b?.[key])))return reply({error:'invalid_partner_program_settings'},400);
  const p={mode,flatBps:Number(b!.flatBps),tier1MaxPassengers:Number(b!.tier1MaxPassengers),tier1Bps:Number(b!.tier1Bps),tier2MaxPassengers:Number(b!.tier2MaxPassengers),tier2Bps:Number(b!.tier2Bps),tier3MaxPassengers:Number(b!.tier3MaxPassengers),tier3Bps:Number(b!.tier3Bps),tier4Bps:Number(b!.tier4Bps)};
  const bps=[p.flatBps,p.tier1Bps,p.tier2Bps,p.tier3Bps,p.tier4Bps];
  if(bps.some((value)=>value<0||value>10000)||p.tier1MaxPassengers<1||p.tier1MaxPassengers>=p.tier2MaxPassengers||p.tier2MaxPassengers>=p.tier3MaxPassengers)return reply({error:'invalid_partner_program_settings'},400);
  await env.DB.prepare('UPDATE partner_program_settings SET mode=?,flat_bps=?,tier1_max_passengers=?,tier1_bps=?,tier2_max_passengers=?,tier2_bps=?,tier3_max_passengers=?,tier3_bps=?,tier4_bps=?,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=1').bind(p.mode,p.flatBps,p.tier1MaxPassengers,p.tier1Bps,p.tier2MaxPassengers,p.tier2Bps,p.tier3MaxPassengers,p.tier3Bps,p.tier4Bps,auth.userId).run();
  await audit(env,auth.userId,'admin.partner_program_settings_updated','partner_program_settings',null);return reply({settings:p});
}

async function adminPartnerApplicationReject(req:Request,env:Env,id:string){
  const auth=await mutationAuth(req,env);if(!auth)return reply({error:'unauthorized'},401);if(!auth.roles.includes('master'))return reply({error:'forbidden'},403);
  const updated=await env.DB.prepare("UPDATE partner_applications SET status='rejected',reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").bind(auth.userId,id).run();
  if(!updated.meta.changes)return reply({error:'partner_application_not_pending'},409);
  await audit(env,auth.userId,'admin.partner_application_rejected','partner_application',id);
  return reply({ok:true});
}

async function adminPartnerCreate(req:Request,env:Env){
  const auth=await mutationAuth(req,env);if(!auth)return reply({error:'unauthorized'},401);if(!auth.roles.includes('master'))return reply({error:'forbidden'},403);
  const b=await body(req);
  const codeValue=typeof b?.code==='string'?normalizeCode(b.code):'';
  const displayName=text(b?.displayName,120,2);
  const email=emailOf(b?.email);
  const applicationId=typeof b?.applicationId==='string'&&/^[0-9a-f-]{36}$/i.test(b.applicationId)?b.applicationId:null;
  const commissionType=b?.commissionType==='fixed'||b?.commissionType==='percentage'?b?.commissionType:null;
  const commissionFixedCents=Number.isInteger(b?.commissionFixedCents)?Number(b?.commissionFixedCents):null;
  const commissionPercentageBps=Number.isInteger(b?.commissionPercentageBps)?Number(b?.commissionPercentageBps):null;
  const currency=typeof b?.currency==='string'&&b.currency.length===3?b?.currency.toUpperCase():'EUR';
  const attributionWindowDays=Number.isInteger(b?.attributionWindowDays)&&Number(b?.attributionWindowDays)>0?Number(b?.attributionWindowDays):30;
  if(!validCode(codeValue)||!displayName||!email||!commissionType)return reply({error:'invalid_partner'},400);
  if(commissionType==='fixed'&&(commissionFixedCents===null||commissionPercentageBps!==null))return reply({error:'invalid_partner'},400);
  if(commissionType==='percentage'&&(commissionPercentageBps===null||commissionFixedCents!==null))return reply({error:'invalid_partner'},400);
  if(!validCurrency(currency))return reply({error:'invalid_currency'},422);
  let application:Row|null=null;
  if(applicationId){
    application=await env.DB.prepare("SELECT id,email FROM partner_applications WHERE id=? AND status='pending'").bind(applicationId).first<Row>();
    if(!application||emailOf(application.email)!==email)return reply({error:'partner_application_not_pending'},409);
  }
  const existing=await env.DB.prepare('SELECT 1 FROM partners WHERE code=?').bind(codeValue).first();
  if(existing)return reply({error:'code_already_used'},409);
  const existingEmail=await env.DB.prepare('SELECT 1 FROM partners WHERE lower(email)=lower(?)').bind(email).first();
  if(existingEmail)return reply({error:'email_already_used_by_partner'},409);
  const id=crypto.randomUUID();
  try {
    const statements=[env.DB.prepare(`INSERT INTO partners (id,code,display_name,instagram,whatsapp,email,commission_type,commission_fixed_cents,commission_percentage_bps,currency,attribution_window_days,active) VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`)
      .bind(id,codeValue,displayName,text(b?.instagram,120)||null,text(b?.whatsapp,30)||null,email,commissionType,commissionFixedCents,commissionPercentageBps,currency,attributionWindowDays)];
    if(application)statements.push(env.DB.prepare("UPDATE partner_applications SET status='accepted',reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,partner_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").bind(auth.userId,id,application.id));
    const results=await env.DB.batch(statements);
    if(application&&!results[1]?.meta.changes){await env.DB.prepare('DELETE FROM partners WHERE id=?').bind(id).run();return reply({error:'partner_application_not_pending'},409);}
  } catch (error) {
    return reply({error:'code_or_email_already_used'},409);
  }
  await audit(env,auth.userId,'admin.partner_created','partner',id);
  if(application)await audit(env,auth.userId,'admin.partner_application_accepted','partner_application',String(application.id));
  return reply({id,code:codeValue},201);
}

async function adminPartnerDetail(req:Request,env:Env,id:string){
  if(!(await requireMaster(req,env)))return reply({error:'forbidden'},403);
  const partner=await env.DB.prepare("SELECT p.*,(activated.user_id IS NOT NULL) account_activated FROM partners p LEFT JOIN (SELECT DISTINCT user_id FROM user_roles WHERE role='partner') activated ON activated.user_id=p.user_id WHERE p.id=?").bind(id).first<Row>();
  if(!partner)return reply({error:'not_found'},404);
  const commissions=await env.DB.prepare(`SELECT pc.id,pc.amount_cents,pc.currency,pc.status,pc.created_at,pc.approved_at,pc.paid_at,pc.voided_at,pc.void_reason,l.protocol,l.status lead_status,l.origin,l.destination FROM partner_commissions pc JOIN lead_requests l ON l.id=pc.lead_request_id WHERE pc.partner_id=? ORDER BY pc.created_at DESC LIMIT 200`).bind(id).all<Row>();
  return reply({partner:serializePartnerRow(partner),commissions:commissions.results});
}

async function adminPartnerUpdate(req:Request,env:Env,id:string){
  const auth=await mutationAuth(req,env);if(!auth)return reply({error:'unauthorized'},401);if(!auth.roles.includes('master'))return reply({error:'forbidden'},403);
  const partner=await env.DB.prepare('SELECT * FROM partners WHERE id=?').bind(id).first<Row>();
  if(!partner)return reply({error:'not_found'},404);
  const b=await body(req);
  const commissionType=b?.commissionType==='fixed'||b?.commissionType==='percentage'?b?.commissionType:String(partner.commission_type);
  const commissionFixedCents=commissionType==='fixed'?(Number.isInteger(b?.commissionFixedCents)?Number(b?.commissionFixedCents):partner.commission_fixed_cents):null;
  const commissionPercentageBps=commissionType==='percentage'?(Number.isInteger(b?.commissionPercentageBps)?Number(b?.commissionPercentageBps):partner.commission_percentage_bps):null;
  if(commissionType==='fixed'&&commissionFixedCents===null)return reply({error:'invalid_partner'},400);
  if(commissionType==='percentage'&&commissionPercentageBps===null)return reply({error:'invalid_partner'},400);
  const displayName=text(b?.displayName,120,2)||String(partner.display_name);
  const instagram=b?.instagram!==undefined?(text(b?.instagram,120)||null):partner.instagram;
  const whatsapp=b?.whatsapp!==undefined?(text(b?.whatsapp,30)||null):partner.whatsapp;
  const currency=typeof b?.currency==='string'&&b.currency.length===3?b?.currency.toUpperCase():String(partner.currency);
  if(!validCurrency(currency))return reply({error:'invalid_currency'},422);
  const attributionWindowDays=Number.isInteger(b?.attributionWindowDays)&&Number(b?.attributionWindowDays)>0?Number(b?.attributionWindowDays):Number(partner.attribution_window_days);
  const active=typeof b?.active==='boolean'?b?.active:Boolean(partner.active);
  if(currency!==String(partner.currency)){
    // Changing currency after real commission history exists would make aggregate totals mix
    // currencies (or silently reinterpret historical amounts). Locked once non-void commissions
    // exist, same rule as the Node/Postgres backend.
    const hasCommissions=await env.DB.prepare("SELECT 1 FROM partner_commissions WHERE partner_id=? AND status<>'void' LIMIT 1").bind(id).first();
    if(hasCommissions)return reply({error:'currency_locked_existing_commissions'},409);
  }
  await env.DB.prepare(`UPDATE partners SET display_name=?,instagram=?,whatsapp=?,commission_type=?,commission_fixed_cents=?,commission_percentage_bps=?,currency=?,attribution_window_days=?,active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .bind(displayName,instagram,whatsapp,commissionType,commissionFixedCents,commissionPercentageBps,currency,attributionWindowDays,active?1:0,id).run();
  await audit(env,auth.userId,'admin.partner_updated','partner',id);
  return reply({ok:true});
}

async function adminPartnerInvite(req:Request,env:Env,id:string){
  const auth=await mutationAuth(req,env);if(!auth)return reply({error:'unauthorized'},401);if(!auth.roles.includes('master'))return reply({error:'forbidden'},403);
  const partner=await env.DB.prepare('SELECT * FROM partners WHERE id=?').bind(id).first<Row>();
  if(!partner)return reply({error:'not_found'},404);
  if(!partner.active)return reply({error:'partner_inactive'},409);
  // Another partner already owns this email/account (partners.user_id and lower(partners.email)
  // are both unique as of migration 0006) — checked explicitly here for a clear, safe error
  // instead of letting a raw unique-constraint violation surface later.
  const conflicting=await env.DB.prepare('SELECT p.id FROM partners p JOIN users u ON u.id=p.user_id WHERE u.email=? AND p.id<>?').bind(partner.email,id).first<Row>();
  if(conflicting)return reply({error:'email_linked_to_other_partner'},409);
  let user=await env.DB.prepare('SELECT id FROM users WHERE email=?').bind(partner.email).first<Row>();
  const userId=user?String(user.id):crypto.randomUUID();
  if(!user){
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users(id,email,status) VALUES(?,?,'pending')").bind(userId,partner.email),
      env.DB.prepare('INSERT INTO profiles(user_id,display_name) VALUES(?,?)').bind(userId,partner.display_name),
    ]);
  }
  const code=code6();
  // Links the account and prepares the invite token, but never grants the 'partner' role here —
  // that only happens in partnerInviteAccept below, after the single-use code is validated. An
  // already-active account (e.g. an existing customer with this email) gains no access just
  // because an invite was created; resending also invalidates every previous unused token.
  await env.DB.batch([
    env.DB.prepare('UPDATE partners SET user_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(userId,id),
    env.DB.prepare("UPDATE account_tokens SET used_at=CURRENT_TIMESTAMP WHERE user_id=? AND purpose='partner_invite' AND used_at IS NULL").bind(userId),
    env.DB.prepare("INSERT INTO account_tokens(id,user_id,purpose,token_hash,expires_at) VALUES(?,?,'partner_invite',?,?)").bind(crypto.randomUUID(),userId,await digest(code,env),isoAfter(900)),
  ]);
  await sendEmail(env,userId,String(partner.email),'partner_invite','Convite para o painel de parceiros - Rota Certa Passagens',`<p>Você foi convidado(a) para acompanhar suas indicações no painel de parceiros da Rota Certa Passagens.</p><p>Seu código de ativação é: <strong>${code}</strong></p><p><a href="${env.APP_ORIGIN}/parceiro-convite.html">Finalizar cadastro do parceiro</a></p><p>Use o mesmo e-mail que recebeu este convite. O código expira em 15 minutos e só pode ser usado uma vez.</p>`,`Você foi convidado(a) para o painel de parceiros da Rota Certa Passagens. Código de ativação: ${code}. Finalize em ${env.APP_ORIGIN}/parceiro-convite.html. O código expira em 15 minutos e só pode ser usado uma vez.`);
  await audit(env,auth.userId,'admin.partner_invite_created','partner',id);
  return reply({ok:true},201);
}

async function partnerInviteAccept(req:Request,env:Env){
  const b=await body(req);const email=emailOf(b?.email);const codeValue=typeof b?.code==='string'&&/^\d{6}$/.test(b.code)?b.code:null;const password=b?.password;
  if(!validPassword(password)||!email||!codeValue)return reply({error:'invalid_or_expired_invite'},400);
  if(!(await rateLimit(req,env,'partner-invite-accept',email,8,900)))return reply({error:'too_many_attempts'},429);
  const row=await env.DB.prepare("SELECT t.id,t.user_id FROM account_tokens t JOIN users u ON u.id=t.user_id WHERE u.email=? AND t.token_hash=? AND t.purpose='partner_invite' AND t.used_at IS NULL AND t.expires_at>CURRENT_TIMESTAMP AND t.failed_attempts<5 LIMIT 1").bind(email,await digest(codeValue,env)).first<Row>();
  if(!row){await env.DB.prepare("UPDATE account_tokens SET failed_attempts=failed_attempts+1 WHERE id=(SELECT t.id FROM account_tokens t JOIN users u ON u.id=t.user_id WHERE u.email=? AND t.purpose='partner_invite' AND t.used_at IS NULL ORDER BY t.created_at DESC LIMIT 1)").bind(email).run();return reply({error:'invalid_or_expired_invite'},400);}
  try {
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET password_hash=?,status='active',email_verified_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(await passwordHash(password),row.user_id),
      // The 'partner' role is granted only here, transactionally, right after the single-use
      // code was validated above — never at invite-creation time.
      env.DB.prepare("INSERT OR IGNORE INTO user_roles(user_id,role) VALUES(?,'partner')").bind(row.user_id),
      env.DB.prepare('UPDATE account_tokens SET used_at=CURRENT_TIMESTAMP WHERE id=?').bind(row.id),
    ]);
  } catch (error) {
    return reply({error:'email_linked_to_other_partner'},409);
  }
  await audit(env,String(row.user_id),'partner.invite_accepted','user',String(row.user_id));
  return reply({ok:true});
}

async function requirePartnerSelf(req:Request,env:Env):Promise<Row|null>{
  const auth=await getAuth(req,env);if(!auth||!auth.roles.includes('partner'))return null;
  // A deactivated partner loses panel access immediately: only an active row is ever returned,
  // so a deactivated partner gets the same "forbidden" outcome as no partner record at all.
  const partner=await env.DB.prepare('SELECT * FROM partners WHERE user_id=? AND active=1').bind(auth.userId).first<Row>();
  return partner||null;
}

async function partnerSummary(req:Request,env:Env){
  const partner=await requirePartnerSelf(req,env);if(!partner)return reply({error:'forbidden'},403,{'cache-control':'no-store'});
  const clicks=await env.DB.prepare('SELECT count(*) n FROM referral_clicks WHERE partner_id=?').bind(partner.id).first<{n:number}>();
  const proposals=await env.DB.prepare('SELECT count(*) n FROM lead_requests WHERE partner_id=?').bind(partner.id).first<{n:number}>();
  const conversions=await env.DB.prepare("SELECT count(*) n FROM lead_requests WHERE partner_id=? AND status='converted'").bind(partner.id).first<{n:number}>();
  const commissionRows=await env.DB.prepare('SELECT status,COALESCE(sum(amount_cents),0) total FROM partner_commissions WHERE partner_id=? GROUP BY status').bind(partner.id).all<{status:string;total:number}>();
  const totals:Record<string,number>={pending:0,approved:0,paid:0,void:0};
  for(const row of commissionRows.results)totals[row.status]=row.total;
  const monthStart=lisbonMonthStartUtc(new Date()).toISOString();
  const monthPassengers=await env.DB.prepare("SELECT COALESCE(sum(l.adults+l.children+l.infants),0) count FROM partner_commissions pc JOIN lead_requests l ON l.id=pc.lead_request_id WHERE pc.partner_id=? AND pc.status<>'void' AND pc.created_at>=?").bind(partner.id,monthStart).first<{count:number}>();
  const currentMonthPassengers=Number(monthPassengers?.count||0),policy=await getWorkerPartnerProgramPolicy(env);
  const rateForPosition=(position:number)=>position<=policy.tier1MaxPassengers?policy.tier1Bps:position<=policy.tier2MaxPassengers?policy.tier2Bps:position<=policy.tier3MaxPassengers?policy.tier3Bps:policy.tier4Bps;
  return reply({
    partner:{code:partner.code,displayName:partner.display_name,active:Boolean(partner.active),commissionType:partner.commission_type,commissionFixedCents:partner.commission_fixed_cents,commissionPercentageBps:partner.commission_percentage_bps,currency:partner.currency,attributionWindowDays:partner.attribution_window_days,link:`${env.APP_ORIGIN.replace(/\/$/,'')}/i/${partner.code}`},
    stats:{clicks:clicks?.n||0,proposals:proposals?.n||0,conversions:conversions?.n||0},
    commissionTotalsCents:totals,
    programCommission:{mode:policy.mode,currentMonthPassengers,currentRateBps:policy.mode==='flat'?policy.flatBps:rateForPosition(currentMonthPassengers+1),...nextProgressiveTier(currentMonthPassengers,policy)},
  },200,{'cache-control':'no-store'});
}

async function partnerLedger(req:Request,env:Env){
  const partner=await requirePartnerSelf(req,env);if(!partner)return reply({error:'forbidden'},403,{'cache-control':'no-store'});
  const leads=await env.DB.prepare('SELECT id,protocol,status,origin,destination,created_at,converted_at,referral_source FROM lead_requests WHERE partner_id=? ORDER BY created_at DESC LIMIT 200').bind(partner.id).all<Row>();
  // Documented, deterministic "current commission per lead" rule (mirrors the Node backend): a
  // lead can have more than one historical commission row (converted -> voided -> reconverted).
  // The SQL ORDER BY guarantees the first row seen per lead_request_id is the active (non-void)
  // commission if one exists, otherwise the most recently voided one — the Map below is safe
  // because of that explicit order, not because of an unspecified database row order.
  const commissions=await env.DB.prepare("SELECT lead_request_id,amount_cents,currency,status FROM partner_commissions WHERE partner_id=? ORDER BY (status='void') ASC, created_at DESC").bind(partner.id).all<Row>();
  const byLead=new Map<string,Row>();
  for(const c of commissions.results){const key=String(c.lead_request_id);if(!byLead.has(key))byLead.set(key,c);}
  return reply({entries:leads.results.map(lead=>{
    const commission=byLead.get(String(lead.id));
    return {protocolMasked:maskProtocol(String(lead.protocol)),route:lead.origin&&lead.destination?`${lead.origin} → ${lead.destination}`:null,status:lead.status,referralSource:lead.referral_source,requestedAt:lead.created_at,convertedAt:lead.converted_at,
      commission:commission?{amountCents:commission.amount_cents,currency:commission.currency,status:commission.status}:null};
  })},200,{'cache-control':'no-store'});
}

async function commissionTransition(req:Request,env:Env,id:string,action:'approve'|'pay'|'void'){
  const auth=await mutationAuth(req,env);if(!auth)return reply({error:'unauthorized'},401);if(!auth.roles.includes('master'))return reply({error:'forbidden'},403);
  if(action==='void'){
    const b=await body(req);const reasonValue=text(b?.reason,500,3);if(!reasonValue)return reply({error:'invalid_request'},400);
    const current=await env.DB.prepare('SELECT id,status FROM partner_commissions WHERE id=?').bind(id).first<{id:string;status:string}>();
    if(!current)return reply({error:'not_found'},404);
    // A paid commission is a settled financial fact and can never be voided directly.
    if(current.status==='paid')return reply({error:'commission_paid_requires_adjustment'},409);
    if(current.status==='void')return reply({error:'already_void'},409);
    const result=await env.DB.prepare("UPDATE partner_commissions SET status='void',voided_at=CURRENT_TIMESTAMP,voided_by=?,void_reason=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('pending','approved')").bind(auth.userId,reasonValue,id).run();
    if(!result.meta.changes)return reply({error:'invalid_transition'},409);
    await audit(env,auth.userId,'admin.commission_voided','partner_commission',id);
    return reply({ok:true});
  }
  const target=action==='approve'?'approved':'paid';
  const allowedFrom=action==='approve'?'pending':'approved';
  const columns=action==='approve'?'approved_at=CURRENT_TIMESTAMP,approved_by=?':'paid_at=CURRENT_TIMESTAMP,paid_by=?';
  const commission=await env.DB.prepare('SELECT partner_id,amount_cents,currency FROM partner_commissions WHERE id=? AND status=?').bind(id,allowedFrom).first<Row>();
  if(!commission)return reply({error:'invalid_transition'},409);
  await env.DB.prepare(`UPDATE partner_commissions SET status=?,${columns},updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(target,auth.userId,id).run();
  await audit(env,auth.userId,`admin.commission_${target}`,'partner_commission',id);
  if(action==='pay'){
    await env.DB.prepare(`INSERT INTO notification_outbox (id,idempotency_key,event_type,partner_id,payload) VALUES (?,?,'commission_paid',?,?) ON CONFLICT(idempotency_key) DO NOTHING`)
      .bind(crypto.randomUUID(),`commission_paid:${id}`,commission.partner_id,JSON.stringify({commissionId:id,amountCents:commission.amount_cents,currency:commission.currency})).run();
  }
  return reply({ok:true});
}

// --- Notifications: in-repo outbox processor (capture mode by default) -------------------

const OUTBOX_LEASE_SECONDS=120;

function escapeHtmlText(value:string){return value.replace(/[&<>'"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}as Record<string,string>)[c]!);}
function formatCentsAmount(cents:unknown,currency:unknown){const amount=typeof cents==='number'?cents:Number(cents??0);const code=typeof currency==='string'&&currency.length===3?currency:'EUR';return `${(amount/100).toFixed(2)} ${code}`;}

/** Mirrors src/routes/notifications.ts's renderNotification exactly: same field names (see
 * ../shared/notificationPayloads.ts), same fail-closed payload validation, no customer PII —
 * only the partner's own display name and aggregate/business facts about their own account. */
function renderOutboxNotification(row:{event_type:string;payload:unknown},partnerName:string){
  const safeName=escapeHtmlText(partnerName||'parceiro(a)');
  switch(row.event_type){
    case 'referral_confirmed':
      return {subject:'Nova indicação recebida',html:`<p>Olá, ${safeName}.</p><p>Chegou uma nova indicação pelo seu link de parceiro. Acompanhe os detalhes no seu painel.</p>`};
    case 'proposal_converted':
      return {subject:'Uma indicação sua fechou negócio',html:`<p>Olá, ${safeName}.</p><p>Uma proposta indicada por você foi convertida em venda. A comissão correspondente já está visível no seu painel de parceiros.</p>`};
    case 'commission_paid': {
      // Validated before rendering: a malformed payload throws (caught by the caller, treated as
      // a failed outbox attempt) instead of silently rendering "0.00 EUR".
      const payload=parseCommissionPaidPayload(row.payload);
      const amount=formatCentsAmount(payload.amountCents,payload.currency);
      return {subject:'Comissão paga',html:`<p>Olá, ${safeName}.</p><p>Sua comissão de <strong>${escapeHtmlText(amount)}</strong> foi marcada como paga. Consulte o extrato completo no seu painel.</p>`};
    }
    case 'weekly_summary': {
      const payload=parseWeeklySummaryPayload(row.payload);
      const commission=formatCentsAmount(payload.commissionCents,payload.currency);
      return {subject:'Resumo semanal do seu link',html:`<p>Olá, ${safeName}.</p><p>Resumo da semana: <strong>${payload.clicks}</strong> cliques, <strong>${payload.proposals}</strong> propostas, <strong>${payload.conversions}</strong> conversões e <strong>${escapeHtmlText(commission)}</strong> em novas comissões.</p>`};
    }
    default:
      return {subject:'Atualização do programa de parceiros',html:`<p>Olá, ${safeName}. Você tem uma atualização.</p>`};
  }
}

async function notificationsProcess(req:Request,env:Env){
  const actorUserId=await requireMasterOrCronUserId(req,env);if(actorUserId===undefined)return reply({error:'forbidden'},403);
  const b=await body(req);const limit=Number.isInteger(b?.limit)&&Number(b?.limit)>0&&Number(b?.limit)<=200?Number(b?.limit):50;
  // Claim/lease: each eligible row is claimed with a conditional compare-and-swap UPDATE (flips
  // 'pending' — or 'processing' with an expired lease — to 'processing' with this invocation's
  // own lock_token and a short lease, WHERE the row is still in that claimable state) before
  // anything is sent. D1/SQLite executes each single UPDATE statement atomically, so two
  // concurrent calls racing on the *same row* can never both have their conditional UPDATE match
  // — one succeeds (meta.changes===1), the other's WHERE clause no longer matches (meta.changes
  // ===0) once the winner's UPDATE has applied. This is a real compare-and-swap per row, not the
  // same mechanism as the PostgreSQL `FOR UPDATE SKIP LOCKED` claim in src/routes/notifications.ts
  // (D1 has no equivalent multi-row locking clause) — but it gives the same end result: at most
  // one caller ever holds a given row's lock_token at a time.
  //
  // Holding the lock_token is still not "exactly once" delivery: if the external send takes
  // longer than the lease, another worker can reclaim the row and resend. See the lease renewal
  // below and idempotencyKey passed to sendEmail/the WhatsApp webhook.
  const lockToken=crypto.randomUUID();
  const claimableIds=await env.DB.prepare(
    "SELECT id FROM notification_outbox WHERE next_attempt_at<=CURRENT_TIMESTAMP AND (status='pending' OR (status='processing' AND lease_expires_at<CURRENT_TIMESTAMP)) ORDER BY next_attempt_at ASC LIMIT ?",
  ).bind(limit).all<{id:string}>();
  let sent=0,skipped=0,failed=0,lockLost=0;
  for(const {id:claimId} of claimableIds.results){
    const claim=await env.DB.prepare(
      "UPDATE notification_outbox SET status='processing',lock_token=?,lease_expires_at=datetime(CURRENT_TIMESTAMP,'+'||?||' seconds'),updated_at=CURRENT_TIMESTAMP WHERE id=? AND (status='pending' OR (status='processing' AND lease_expires_at<CURRENT_TIMESTAMP))",
    ).bind(lockToken,String(OUTBOX_LEASE_SECONDS),claimId).run();
    if(!claim.meta.changes)continue; // another concurrent call claimed this row first
    const row=await env.DB.prepare('SELECT id,idempotency_key,event_type,partner_id,channel,payload,attempts FROM notification_outbox WHERE id=? AND lock_token=?').bind(claimId,lockToken).first<Row>();
    if(!row)continue;
    const payload=typeof row.payload==='string'?JSON.parse(row.payload):row.payload;
    try{
      if(row.channel==='whatsapp'&&(env.WHATSAPP_NOTIFICATIONS_ENABLED as 'false'|'true')!=='true'){
        const skip=await env.DB.prepare("UPDATE notification_outbox SET status='skipped',updated_at=CURRENT_TIMESTAMP WHERE id=? AND lock_token=?").bind(row.id,lockToken).run();
        if(skip.meta.changes)skipped++;else lockLost++;
        continue;
      }
      // Renew the lease immediately before the external call — same rationale as
      // src/routes/notifications.ts's processOutboxRow: abort before sending if the lock was
      // already lost, so this invocation never fires a send the new owner will also fire.
      const renew=await env.DB.prepare("UPDATE notification_outbox SET lease_expires_at=datetime(CURRENT_TIMESTAMP,'+'||?||' seconds'),updated_at=CURRENT_TIMESTAMP WHERE id=? AND lock_token=?").bind(String(OUTBOX_LEASE_SECONDS),row.id,lockToken).run();
      if(!renew.meta.changes){lockLost++;continue;}
      if(row.channel==='whatsapp'){
        const notificationSecrets=env as Env & OptionalNotificationSecrets;
        if(!notificationSecrets.WHATSAPP_WEBHOOK_URL||!notificationSecrets.WHATSAPP_WEBHOOK_TOKEN)throw new Error('whatsapp_webhook_not_configured');
        const response=await fetch(notificationSecrets.WHATSAPP_WEBHOOK_URL,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${notificationSecrets.WHATSAPP_WEBHOOK_TOKEN}`,'idempotency-key':String(row.idempotency_key)},body:JSON.stringify({eventType:row.event_type,partnerId:row.partner_id,payload,idempotencyKey:row.idempotency_key})});
        if(!response.ok)throw new Error(`whatsapp_webhook_http_${response.status}`);
      }else{
        const partner=await env.DB.prepare('SELECT email,display_name FROM partners WHERE id=?').bind(row.partner_id).first<{email:string;display_name:string}>();
        if(!partner?.email)throw new Error('partner_email_missing');
        // Reuses the same sendEmail() helper every other worker email flow uses: EMAIL_MODE=capture
        // (the default, used by every local/test run including the Worker/D1 smoke test) never
        // touches the network; EMAIL_MODE=resend is required for a real send. Real, partner-facing
        // content instead of a manual, content-less email_events row, with the outbox row's own
        // idempotency_key passed through for provider-level deduplication.
        const {subject,html:htmlBody}=renderOutboxNotification({event_type:row.event_type as string,payload},partner.display_name);
        await sendEmail(env,null,partner.email,`partner_${row.event_type}`,subject,htmlBody,undefined,String(row.idempotency_key));
      }
      const done=await env.DB.prepare("UPDATE notification_outbox SET status='sent',attempts=attempts+1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND lock_token=?").bind(row.id,lockToken).run();
      if(done.meta.changes)sent++;else lockLost++;
    }catch(error){
      const attempts=Number(row.attempts)+1;const message=(error instanceof Error?error.message:'unknown_error').slice(0,200);
      const result=attempts>=5
        ?await env.DB.prepare("UPDATE notification_outbox SET status='failed',attempts=?,last_error=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND lock_token=?").bind(attempts,message,row.id,lockToken).run()
        :await env.DB.prepare("UPDATE notification_outbox SET attempts=?,last_error=?,next_attempt_at=datetime(CURRENT_TIMESTAMP,'+'||?||' minutes'),status='pending',lock_token=NULL,lease_expires_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND lock_token=?").bind(attempts,message,String(2**attempts),row.id,lockToken).run();
      if(result.meta.changes)failed++;else lockLost++;
    }
  }
  await audit(env,actorUserId,'admin.notifications_processed','notification_outbox','');
  return reply({processed:sent+skipped+failed,sent,skipped,failed,lockLost});
}

/**
 * Timezone-safe (DST-correct) start of the current Europe/Lisbon week (Monday 00:00 local).
 * Mirrors src/security.ts's lisbonWeekStartUtc exactly: reads Lisbon's real UTC offset for the
 * target calendar date (via Intl's shortOffset, which already accounts for DST) instead of
 * parsing a local-looking string in the host process's own timezone.
 */
function lisbonWeekStartIso(reference:Date){
  const dateFormatter=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Lisbon',year:'numeric',month:'2-digit',day:'2-digit',weekday:'short'});
  const parts=Object.fromEntries(dateFormatter.formatToParts(reference).map(p=>[p.type,p.value]));
  const weekdayIndex=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].indexOf(parts.weekday);
  const referenceDateUtcMs=Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day));
  const mondayDateUtcMs=referenceDateUtcMs-weekdayIndex*86_400_000;
  const monday=new Date(mondayDateUtcMs);
  const guessInstant=Date.UTC(monday.getUTCFullYear(),monday.getUTCMonth(),monday.getUTCDate());
  const offsetParts=new Intl.DateTimeFormat('en-US',{timeZone:'Europe/Lisbon',timeZoneName:'shortOffset'}).formatToParts(new Date(guessInstant));
  const tzName=offsetParts.find(p=>p.type==='timeZoneName')?.value??'GMT';
  const match=/GMT([+-]\d{1,2})?/.exec(tzName);
  const offsetMinutes=(match?.[1]?Number.parseInt(match[1],10):0)*60;
  return new Date(guessInstant-offsetMinutes*60_000);
}

async function notificationsWeeklySummary(req:Request,env:Env){
  const actorUserId=await requireMasterOrCronUserId(req,env);if(actorUserId===undefined)return reply({error:'forbidden'},403);
  const weekStart=lisbonWeekStartIso(new Date());const weekStartIso=weekStart.toISOString();
  // `currency` selected alongside the partner so the payload always carries the partner's own
  // configured currency — see src/routes/notifications.ts's mirrored fix and
  // ../shared/notificationPayloads.ts's WeeklySummaryPayload contract both backends share.
  const partners=await env.DB.prepare('SELECT id,code,display_name,currency FROM partners WHERE active=1').all<Row>();
  let created=0;
  for(const partner of partners.results){
    const clicks=await env.DB.prepare('SELECT count(*) n FROM referral_clicks WHERE partner_id=? AND clicked_at>=?').bind(partner.id,weekStartIso).first<{n:number}>();
    const proposals=await env.DB.prepare('SELECT count(*) n FROM lead_requests WHERE partner_id=? AND created_at>=?').bind(partner.id,weekStartIso).first<{n:number}>();
    const conversions=await env.DB.prepare("SELECT count(*) n FROM lead_requests WHERE partner_id=? AND status='converted' AND converted_at>=?").bind(partner.id,weekStartIso).first<{n:number}>();
    const commission=await env.DB.prepare("SELECT COALESCE(sum(amount_cents),0) n FROM partner_commissions WHERE partner_id=? AND status<>'void' AND created_at>=?").bind(partner.id,weekStartIso).first<{n:number}>();
    const idempotencyKey=`weekly_summary:${partner.id}:${weekStartIso.slice(0,10)}`;
    const result=await env.DB.prepare(`INSERT INTO notification_outbox (id,idempotency_key,event_type,partner_id,payload) VALUES (?,?,'weekly_summary',?,?) ON CONFLICT(idempotency_key) DO NOTHING`)
      .bind(crypto.randomUUID(),idempotencyKey,partner.id,JSON.stringify({weekStart:weekStartIso,clicks:clicks?.n||0,proposals:proposals?.n||0,conversions:conversions?.n||0,commissionCents:commission?.n||0,currency:partner.currency})).run();
    if(result.meta.changes)created++;
  }
  return reply({partnersConsidered:partners.results.length,summariesCreated:created});
}

// --- Financeiro (Fase 1 — fundação) ---------------------------------------------------------
// Mirrors src/routes/finance.ts exactly: same tables (fin_*), same authorization gate
// (requireMaster for GET, mutationAuth + master role for POST/PATCH), same audit actions, same
// camelCase response contract. Kept in this same file because every other Worker route lives
// here too (see worker/env.d.ts / wrangler.jsonc — one Worker script, no sub-modules).
const FINANCE_CATEGORY_KINDS = ['revenue', 'direct_cost', 'operating_expense'];
const FINANCE_ACCOUNT_TYPES = ['bank', 'cash', 'card', 'digital_wallet', 'other'];
const FINANCE_COUNTERPARTY_KINDS = ['supplier', 'airline', 'consolidator', 'mileage_provider', 'other'];

function serializeCostCenter(row: Row) { return { id: row.id, name: row.name, active: Boolean(row.active), createdAt: row.created_at, updatedAt: row.updated_at }; }
function serializeCategory(row: Row) { return { id: row.id, parentId: row.parent_id, kind: row.kind, name: row.name, defaultCostCenterId: row.default_cost_center_id, active: Boolean(row.active), createdAt: row.created_at, updatedAt: row.updated_at }; }
function serializeFinAccount(row: Row) { return { id: row.id, name: row.name, type: row.type, institution: row.institution, last4: row.last4, currency: row.currency, openingBalanceCents: row.opening_balance_cents, openingBalanceAt: row.opening_balance_at, active: Boolean(row.active), notes: row.notes, createdAt: row.created_at, updatedAt: row.updated_at }; }
function serializeCounterparty(row: Row) { return { id: row.id, displayName: row.display_name, kind: row.kind, taxId: row.tax_id, contact: row.contact, preferredCurrency: row.preferred_currency, active: Boolean(row.active), notes: row.notes, createdAt: row.created_at, updatedAt: row.updated_at }; }

async function financeCostCenters(req: Request, env: Env) {
  if (!(await requireMaster(req, env))) return reply({ error: 'forbidden' }, 403);
  const rows = await env.DB.prepare('SELECT id,name,active,created_at,updated_at FROM fin_cost_centers ORDER BY name').all<Row>();
  return reply({ costCenters: rows.results.map(serializeCostCenter) });
}
async function financeCostCenterCreate(req: Request, env: Env) {
  const auth = await mutationAuth(req, env); if (!auth) return reply({ error: 'unauthorized' }, 401); if (!auth.roles.includes('master')) return reply({ error: 'forbidden' }, 403);
  const b = await body(req); const name = text(b?.name, 120, 2);
  if (!name) return reply({ error: 'invalid_cost_center' }, 400);
  const id = crypto.randomUUID();
  try { await env.DB.prepare('INSERT INTO fin_cost_centers(id,name) VALUES(?,?)').bind(id, name).run(); }
  catch (error) { return reply({ error: 'cost_center_name_taken' }, 409); }
  await audit(env, auth.userId, 'finance.cost_center_created', 'fin_cost_center', id);
  return reply({ id }, 201);
}
async function financeCostCenterUpdate(req: Request, env: Env, id: string) {
  const auth = await mutationAuth(req, env); if (!auth) return reply({ error: 'unauthorized' }, 401); if (!auth.roles.includes('master')) return reply({ error: 'forbidden' }, 403);
  const b = await body(req);
  const name = 'name' in (b || {}) ? text(b?.name, 120, 2) : undefined;
  const active = typeof b?.active === 'boolean' ? b.active : undefined;
  let result;
  try {
    result = await env.DB.prepare('UPDATE fin_cost_centers SET name=COALESCE(?,name),active=COALESCE(?,active),updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .bind(name ?? null, active === undefined ? null : (active ? 1 : 0), id).run();
  } catch (error) { return reply({ error: 'cost_center_name_taken' }, 409); }
  if (!result.meta.changes) return reply({ error: 'not_found' }, 404);
  await audit(env, auth.userId, 'finance.cost_center_updated', 'fin_cost_center', id);
  return reply({ ok: true });
}

async function financeCategories(req: Request, env: Env) {
  if (!(await requireMaster(req, env))) return reply({ error: 'forbidden' }, 403);
  const rows = await env.DB.prepare('SELECT id,parent_id,kind,name,default_cost_center_id,active,created_at,updated_at FROM fin_categories ORDER BY kind,name').all<Row>();
  return reply({ categories: rows.results.map(serializeCategory) });
}
async function financeCategoryCreate(req: Request, env: Env) {
  const auth = await mutationAuth(req, env); if (!auth) return reply({ error: 'unauthorized' }, 401); if (!auth.roles.includes('master')) return reply({ error: 'forbidden' }, 403);
  const b = await body(req);
  const kind = typeof b?.kind === 'string' && FINANCE_CATEGORY_KINDS.includes(b.kind) ? b.kind : null;
  const name = text(b?.name, 120, 2);
  const parentId = typeof b?.parentId === 'string' && /^[0-9a-f-]{36}$/i.test(b.parentId) ? b.parentId : null;
  const defaultCostCenterId = typeof b?.defaultCostCenterId === 'string' && /^[0-9a-f-]{36}$/i.test(b.defaultCostCenterId) ? b.defaultCostCenterId : null;
  if (!kind || !name) return reply({ error: 'invalid_category' }, 400);
  if (parentId) {
    const parent = await env.DB.prepare('SELECT kind FROM fin_categories WHERE id=?').bind(parentId).first<{ kind: string }>();
    if (!parent) return reply({ error: 'parent_not_found' }, 422);
    if (parent.kind !== kind) return reply({ error: 'parent_kind_mismatch' }, 422);
  }
  if (defaultCostCenterId) {
    const costCenter = await env.DB.prepare('SELECT 1 FROM fin_cost_centers WHERE id=?').bind(defaultCostCenterId).first();
    if (!costCenter) return reply({ error: 'cost_center_not_found' }, 422);
  }
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO fin_categories(id,parent_id,kind,name,default_cost_center_id) VALUES(?,?,?,?,?)').bind(id, parentId, kind, name, defaultCostCenterId).run();
  await audit(env, auth.userId, 'finance.category_created', 'fin_category', id);
  return reply({ id }, 201);
}
async function financeCategoryUpdate(req: Request, env: Env, id: string) {
  const auth = await mutationAuth(req, env); if (!auth) return reply({ error: 'unauthorized' }, 401); if (!auth.roles.includes('master')) return reply({ error: 'forbidden' }, 403);
  const b = await body(req);
  const name = 'name' in (b || {}) ? text(b?.name, 120, 2) : undefined;
  const active = typeof b?.active === 'boolean' ? b.active : undefined;
  const hasDefaultCostCenterId = b != null && 'defaultCostCenterId' in b;
  const defaultCostCenterId = hasDefaultCostCenterId && typeof b?.defaultCostCenterId === 'string' && /^[0-9a-f-]{36}$/i.test(b.defaultCostCenterId) ? b.defaultCostCenterId : null;
  if (active === false) {
    const referenced = await env.DB.prepare('SELECT 1 FROM fin_categories WHERE parent_id=? AND active=1 LIMIT 1').bind(id).first();
    if (referenced) return reply({ error: 'category_has_active_children' }, 409);
  }
  if (hasDefaultCostCenterId && defaultCostCenterId) {
    const costCenter = await env.DB.prepare('SELECT 1 FROM fin_cost_centers WHERE id=?').bind(defaultCostCenterId).first();
    if (!costCenter) return reply({ error: 'cost_center_not_found' }, 422);
  }
  const result = await env.DB.prepare(
    `UPDATE fin_categories SET name=COALESCE(?,name),
       default_cost_center_id=CASE WHEN ?=1 THEN ? ELSE default_cost_center_id END,
       active=COALESCE(?,active),updated_at=CURRENT_TIMESTAMP WHERE id=?`,
  ).bind(name ?? null, hasDefaultCostCenterId ? 1 : 0, defaultCostCenterId, active === undefined ? null : (active ? 1 : 0), id).run();
  if (!result.meta.changes) return reply({ error: 'not_found' }, 404);
  await audit(env, auth.userId, 'finance.category_updated', 'fin_category', id);
  return reply({ ok: true });
}

async function financeAccounts(req: Request, env: Env) {
  if (!(await requireMaster(req, env))) return reply({ error: 'forbidden' }, 403);
  const rows = await env.DB.prepare('SELECT id,name,type,institution,last4,currency,opening_balance_cents,opening_balance_at,active,notes,created_at,updated_at FROM fin_accounts ORDER BY name').all<Row>();
  return reply({ accounts: rows.results.map(serializeFinAccount) });
}
async function financeAccountCreate(req: Request, env: Env) {
  const auth = await mutationAuth(req, env); if (!auth) return reply({ error: 'unauthorized' }, 401); if (!auth.roles.includes('master')) return reply({ error: 'forbidden' }, 403);
  const b = await body(req);
  const name = text(b?.name, 120, 2);
  const type = typeof b?.type === 'string' && FINANCE_ACCOUNT_TYPES.includes(b.type) ? b.type : null;
  const currency = typeof b?.currency === 'string' && b.currency.length === 3 ? b.currency.toUpperCase() : null;
  const institution = text(b?.institution, 160) || null;
  const last4 = typeof b?.last4 === 'string' && /^\d{4}$/.test(b.last4) ? b.last4 : null;
  const notes = text(b?.notes, 1000) || null;
  const openingBalanceCents = Number.isInteger(b?.openingBalanceCents) ? Number(b?.openingBalanceCents) : null;
  const openingBalanceAt = dateOf(b?.openingBalanceAt);
  if (!name || !type || !currency || !validCurrency(currency)) return reply({ error: 'invalid_account' }, 400);
  if ((openingBalanceCents === null) !== (openingBalanceAt === null)) return reply({ error: 'invalid_account' }, 400);
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO fin_accounts(id,name,type,institution,last4,currency,opening_balance_cents,opening_balance_at,notes) VALUES(?,?,?,?,?,?,?,?,?)')
    .bind(id, name, type, institution, last4, currency, openingBalanceCents, openingBalanceAt, notes).run();
  await audit(env, auth.userId, 'finance.account_created', 'fin_account', id);
  return reply({ id }, 201);
}
async function financeAccountUpdate(req: Request, env: Env, id: string) {
  const auth = await mutationAuth(req, env); if (!auth) return reply({ error: 'unauthorized' }, 401); if (!auth.roles.includes('master')) return reply({ error: 'forbidden' }, 403);
  const b = await body(req);
  const name = 'name' in (b || {}) ? text(b?.name, 120, 2) : undefined;
  const hasInstitution = b != null && 'institution' in b; const institution = text(b?.institution, 160) || null;
  const hasLast4 = b != null && 'last4' in b; const last4 = typeof b?.last4 === 'string' && /^\d{4}$/.test(b.last4) ? b.last4 : null;
  const hasNotes = b != null && 'notes' in b; const notes = text(b?.notes, 1000) || null;
  const active = typeof b?.active === 'boolean' ? b.active : undefined;
  const result = await env.DB.prepare(
    `UPDATE fin_accounts SET name=COALESCE(?,name),
       institution=CASE WHEN ?=1 THEN ? ELSE institution END,
       last4=CASE WHEN ?=1 THEN ? ELSE last4 END,
       notes=CASE WHEN ?=1 THEN ? ELSE notes END,
       active=COALESCE(?,active),updated_at=CURRENT_TIMESTAMP WHERE id=?`,
  ).bind(name ?? null, hasInstitution ? 1 : 0, institution, hasLast4 ? 1 : 0, last4, hasNotes ? 1 : 0, notes, active === undefined ? null : (active ? 1 : 0), id).run();
  if (!result.meta.changes) return reply({ error: 'not_found' }, 404);
  await audit(env, auth.userId, 'finance.account_updated', 'fin_account', id);
  return reply({ ok: true });
}

async function financeCounterparties(req: Request, env: Env) {
  if (!(await requireMaster(req, env))) return reply({ error: 'forbidden' }, 403);
  const rows = await env.DB.prepare('SELECT id,display_name,kind,tax_id,contact,preferred_currency,active,notes,created_at,updated_at FROM fin_counterparties ORDER BY display_name').all<Row>();
  return reply({ counterparties: rows.results.map(serializeCounterparty) });
}
async function financeCounterpartyCreate(req: Request, env: Env) {
  const auth = await mutationAuth(req, env); if (!auth) return reply({ error: 'unauthorized' }, 401); if (!auth.roles.includes('master')) return reply({ error: 'forbidden' }, 403);
  const b = await body(req);
  const displayName = text(b?.displayName, 160, 2);
  const kind = typeof b?.kind === 'string' && FINANCE_COUNTERPARTY_KINDS.includes(b.kind) ? b.kind : null;
  const taxId = text(b?.taxId, 60) || null;
  const contact = text(b?.contact, 200) || null;
  const preferredCurrency = typeof b?.preferredCurrency === 'string' && b.preferredCurrency.length === 3 ? b.preferredCurrency.toUpperCase() : null;
  const notes = text(b?.notes, 1000) || null;
  if (!displayName || !kind) return reply({ error: 'invalid_counterparty' }, 400);
  if (preferredCurrency && !validCurrency(preferredCurrency)) return reply({ error: 'invalid_currency' }, 422);
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO fin_counterparties(id,display_name,kind,tax_id,contact,preferred_currency,notes) VALUES(?,?,?,?,?,?,?)')
    .bind(id, displayName, kind, taxId, contact, preferredCurrency, notes).run();
  await audit(env, auth.userId, 'finance.counterparty_created', 'fin_counterparty', id);
  return reply({ id }, 201);
}
async function financeCounterpartyUpdate(req: Request, env: Env, id: string) {
  const auth = await mutationAuth(req, env); if (!auth) return reply({ error: 'unauthorized' }, 401); if (!auth.roles.includes('master')) return reply({ error: 'forbidden' }, 403);
  const b = await body(req);
  const displayName = 'displayName' in (b || {}) ? text(b?.displayName, 160, 2) : undefined;
  const hasContact = b != null && 'contact' in b; const contact = text(b?.contact, 200) || null;
  const hasTaxId = b != null && 'taxId' in b; const taxId = text(b?.taxId, 60) || null;
  const preferredCurrency = typeof b?.preferredCurrency === 'string' && b.preferredCurrency.length === 3 ? b.preferredCurrency.toUpperCase() : undefined;
  const hasNotes = b != null && 'notes' in b; const notes = text(b?.notes, 1000) || null;
  const active = typeof b?.active === 'boolean' ? b.active : undefined;
  if (preferredCurrency && !validCurrency(preferredCurrency)) return reply({ error: 'invalid_currency' }, 422);
  const result = await env.DB.prepare(
    `UPDATE fin_counterparties SET display_name=COALESCE(?,display_name),
       contact=CASE WHEN ?=1 THEN ? ELSE contact END,
       tax_id=CASE WHEN ?=1 THEN ? ELSE tax_id END,
       preferred_currency=COALESCE(?,preferred_currency),
       notes=CASE WHEN ?=1 THEN ? ELSE notes END,
       active=COALESCE(?,active),updated_at=CURRENT_TIMESTAMP WHERE id=?`,
  ).bind(displayName ?? null, hasContact ? 1 : 0, contact, hasTaxId ? 1 : 0, taxId, preferredCurrency ?? null, hasNotes ? 1 : 0, notes, active === undefined ? null : (active ? 1 : 0), id).run();
  if (!result.meta.changes) return reply({ error: 'not_found' }, 404);
  await audit(env, auth.userId, 'finance.counterparty_updated', 'fin_counterparty', id);
  return reply({ ok: true });
}

// --- Financeiro (Fase 2 — assinaturas, despesas e contas a pagar) ---------------------------
// Mirrors src/routes/finance-subscriptions.ts and src/routes/finance-obligations.ts. D1/SQLite
// has no interactive multi-statement transaction the way Postgres does (env.DB.batch() runs
// several prepared statements atomically but cannot branch on a read in between), so — exactly
// like the existing commissionTransition() above — state changes here are sequential awaited
// calls guarded by conditional WHERE clauses and unique constraints, not a wrapping BEGIN/COMMIT.
const UUID_RE = /^[0-9a-f-]{36}$/i;
const FINANCE_SUBSCRIPTION_PERIODICITIES = ['monthly', 'quarterly', 'semiannual', 'annual', 'custom'];
const FINANCE_SUBSCRIPTION_STATUSES = ['trial', 'active', 'suspended', 'canceled', 'ended'];
const FINANCE_OBLIGATION_KINDS = ['direct_cost', 'operating_expense'];
const FINANCE_OBLIGATION_STATUSES = ['open', 'partial', 'paid', 'canceled', 'reversed'];

function serializeFinSubscription(row: Row) {
  return {
    id: row.id, counterpartyId: row.counterparty_id, service: row.service, description: row.description, plan: row.plan,
    amountCents: row.amount_cents, currency: row.currency, periodicity: row.periodicity, customIntervalDays: row.custom_interval_days,
    nextChargeAt: row.next_charge_at, billingDay: row.billing_day, autoRenew: Boolean(row.auto_renew), accountId: row.account_id,
    categoryId: row.category_id, costCenterId: row.cost_center_id, status: row.status, startedAt: row.started_at, endedAt: row.ended_at,
    adminUrl: row.admin_url, responsibleUserId: row.responsible_user_id, noticeDays: row.notice_days, notes: row.notes,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
function serializeFinObligation(row: Row) {
  return {
    id: row.id, kind: row.kind, counterpartyId: row.counterparty_id, categoryId: row.category_id, costCenterId: row.cost_center_id,
    competencyDate: row.competency_date, dueDate: row.due_date, amountCents: row.amount_cents, currency: row.currency,
    accountId: row.account_id, status: row.status, subscriptionId: row.subscription_id, source: row.source, notes: row.notes,
    canceledAt: row.canceled_at, cancelReason: row.cancel_reason, isOverdue: Boolean(row.is_overdue),
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
function serializeFinPayment(row: Row) {
  return {
    id: row.id, paidAmountCents: row.paid_amount_cents, currency: row.currency, paidAt: row.paid_at, accountId: row.account_id,
    reference: row.reference, reversalOf: row.reversal_of, reversalReason: row.reversal_reason, createdAt: row.created_at,
  };
}

async function financeSubscriptions(req: Request, env: Env, url: URL) {
  if (!(await requireMaster(req, env))) return reply({ error: 'forbidden' }, 403);
  const status = url.searchParams.get('status');
  if (status && !FINANCE_SUBSCRIPTION_STATUSES.includes(status)) return reply({ error: 'invalid_filter' }, 400);
  const rows = await env.DB.prepare(
    `SELECT id,counterparty_id,service,description,plan,amount_cents,currency,periodicity,custom_interval_days,
            next_charge_at,billing_day,auto_renew,account_id,category_id,cost_center_id,status,started_at,ended_at,
            admin_url,responsible_user_id,notice_days,notes,created_at,updated_at
       FROM fin_subscriptions WHERE (?1 IS NULL OR status=?1) ORDER BY next_charge_at`,
  ).bind(status).all<Row>();
  return reply({ subscriptions: rows.results.map(serializeFinSubscription) });
}

async function financeSubscriptionCreate(req: Request, env: Env) {
  const auth = await mutationAuth(req, env); if (!auth) return reply({ error: 'unauthorized' }, 401); if (!auth.roles.includes('master')) return reply({ error: 'forbidden' }, 403);
  const b = await body(req);
  const counterpartyId = typeof b?.counterpartyId === 'string' && UUID_RE.test(b.counterpartyId) ? b.counterpartyId : null;
  const service = text(b?.service, 160, 2);
  const description = text(b?.description, 1000) || null;
  const plan = text(b?.plan, 120) || null;
  const amountCents = intOf(b?.amountCents, 1, 100_000_000_00);
  const currency = typeof b?.currency === 'string' && b.currency.length === 3 ? b.currency.toUpperCase() : null;
  const periodicity = typeof b?.periodicity === 'string' && FINANCE_SUBSCRIPTION_PERIODICITIES.includes(b.periodicity) ? b.periodicity as SubscriptionPeriodicity : null;
  const customIntervalDays = intOf(b?.customIntervalDays, 1, 3650);
  const startedAt = dateOf(b?.startedAt);
  const billingDay = intOf(b?.billingDay, 1, 31);
  const autoRenew = typeof b?.autoRenew === 'boolean' ? b.autoRenew : true;
  const accountId = typeof b?.accountId === 'string' && UUID_RE.test(b.accountId) ? b.accountId : null;
  const categoryId = typeof b?.categoryId === 'string' && UUID_RE.test(b.categoryId) ? b.categoryId : null;
  const costCenterIdInput = typeof b?.costCenterId === 'string' && UUID_RE.test(b.costCenterId) ? b.costCenterId : null;
  const status = b?.status === 'trial' ? 'trial' : 'active';
  const adminUrl = typeof b?.adminUrl === 'string' && b.adminUrl.length <= 500 ? b.adminUrl : null;
  const responsibleUserId = typeof b?.responsibleUserId === 'string' && UUID_RE.test(b.responsibleUserId) ? b.responsibleUserId : null;
  const noticeDays = Number.isInteger(b?.noticeDays) ? intOf(b?.noticeDays, 0, 365) : 7;
  const notes = text(b?.notes, 1000) || null;
  if (!counterpartyId || !service || !amountCents || !currency || !validCurrency(currency) || !periodicity || !startedAt || !categoryId) return reply({ error: 'invalid_subscription' }, 400);
  if ((periodicity === 'custom') !== (customIntervalDays !== null)) return reply({ error: 'invalid_subscription' }, 400);

  const category = await env.DB.prepare('SELECT kind FROM fin_categories WHERE id=? AND active=1').bind(categoryId).first<{ kind: string }>();
  if (!category) return reply({ error: 'category_not_found' }, 422);
  if (category.kind !== 'operating_expense') return reply({ error: 'category_must_be_operating_expense' }, 422);
  const counterparty = await env.DB.prepare('SELECT 1 FROM fin_counterparties WHERE id=? AND active=1').bind(counterpartyId).first();
  if (!counterparty) return reply({ error: 'counterparty_not_found' }, 422);
  if (accountId) { const account = await env.DB.prepare('SELECT 1 FROM fin_accounts WHERE id=? AND active=1').bind(accountId).first(); if (!account) return reply({ error: 'account_not_found' }, 422); }
  if (costCenterIdInput) { const costCenter = await env.DB.prepare('SELECT 1 FROM fin_cost_centers WHERE id=?').bind(costCenterIdInput).first(); if (!costCenter) return reply({ error: 'cost_center_not_found' }, 422); }

  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO fin_subscriptions
        (id,counterparty_id,service,description,plan,amount_cents,currency,periodicity,custom_interval_days,
         next_charge_at,billing_day,auto_renew,account_id,category_id,cost_center_id,status,started_at,
         admin_url,responsible_user_id,notice_days,notes,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(id, counterpartyId, service, description, plan, amountCents, currency, periodicity, customIntervalDays, startedAt, billingDay, autoRenew ? 1 : 0, accountId, categoryId, costCenterIdInput, status, startedAt, adminUrl, responsibleUserId, noticeDays, notes, auth.userId),
    env.DB.prepare('INSERT INTO fin_subscription_price_history (id,subscription_id,amount_cents,currency,effective_at,created_by) VALUES (?,?,?,?,?,?)')
      .bind(crypto.randomUUID(), id, amountCents, currency, startedAt, auth.userId),
  ]);
  await audit(env, auth.userId, 'finance.subscription_created', 'fin_subscription', id);
  return reply({ id }, 201);
}

async function financeSubscriptionUpdate(req: Request, env: Env, id: string) {
  const auth = await mutationAuth(req, env); if (!auth) return reply({ error: 'unauthorized' }, 401); if (!auth.roles.includes('master')) return reply({ error: 'forbidden' }, 403);
  const b = await body(req);
  const has = (key: string) => b != null && key in b;
  const description = text(b?.description, 1000) || null;
  const plan = text(b?.plan, 120) || null;
  const billingDay = intOf(b?.billingDay, 1, 31);
  const autoRenew = typeof b?.autoRenew === 'boolean' ? b.autoRenew : undefined;
  const accountId = typeof b?.accountId === 'string' && UUID_RE.test(b.accountId) ? b.accountId : null;
  const costCenterId = typeof b?.costCenterId === 'string' && UUID_RE.test(b.costCenterId) ? b.costCenterId : null;
  const adminUrl = typeof b?.adminUrl === 'string' && b.adminUrl.length <= 500 ? b.adminUrl : null;
  const responsibleUserId = typeof b?.responsibleUserId === 'string' && UUID_RE.test(b.responsibleUserId) ? b.responsibleUserId : null;
  const noticeDays = Number.isInteger(b?.noticeDays) ? intOf(b?.noticeDays, 0, 365) : undefined;
  const notes = text(b?.notes, 1000) || null;
  if (has('accountId') && accountId) { const account = await env.DB.prepare('SELECT 1 FROM fin_accounts WHERE id=? AND active=1').bind(accountId).first(); if (!account) return reply({ error: 'account_not_found' }, 422); }
  if (has('costCenterId') && costCenterId) { const costCenter = await env.DB.prepare('SELECT 1 FROM fin_cost_centers WHERE id=?').bind(costCenterId).first(); if (!costCenter) return reply({ error: 'cost_center_not_found' }, 422); }
  const result = await env.DB.prepare(
    `UPDATE fin_subscriptions SET
        description=CASE WHEN ?=1 THEN ? ELSE description END,
        plan=CASE WHEN ?=1 THEN ? ELSE plan END,
        billing_day=CASE WHEN ?=1 THEN ? ELSE billing_day END,
        auto_renew=COALESCE(?,auto_renew),
        account_id=CASE WHEN ?=1 THEN ? ELSE account_id END,
        cost_center_id=CASE WHEN ?=1 THEN ? ELSE cost_center_id END,
        admin_url=CASE WHEN ?=1 THEN ? ELSE admin_url END,
        responsible_user_id=CASE WHEN ?=1 THEN ? ELSE responsible_user_id END,
        notice_days=COALESCE(?,notice_days),
        notes=CASE WHEN ?=1 THEN ? ELSE notes END,
        updated_at=CURRENT_TIMESTAMP
      WHERE id=?`,
  ).bind(
    has('description') ? 1 : 0, description, has('plan') ? 1 : 0, plan, has('billingDay') ? 1 : 0, billingDay,
    autoRenew === undefined ? null : (autoRenew ? 1 : 0), has('accountId') ? 1 : 0, accountId, has('costCenterId') ? 1 : 0, costCenterId,
    has('adminUrl') ? 1 : 0, adminUrl, has('responsibleUserId') ? 1 : 0, responsibleUserId, noticeDays ?? null,
    has('notes') ? 1 : 0, notes, id,
  ).run();
  if (!result.meta.changes) return reply({ error: 'not_found' }, 404);
  await audit(env, auth.userId, 'finance.subscription_updated', 'fin_subscription', id);
  return reply({ ok: true });
}

async function financeSubscriptionReprice(req: Request, env: Env, id: string) {
  const auth = await mutationAuth(req, env); if (!auth) return reply({ error: 'unauthorized' }, 401); if (!auth.roles.includes('master')) return reply({ error: 'forbidden' }, 403);
  const b = await body(req);
  const amountCents = intOf(b?.amountCents, 1, 100_000_000_00);
  const currency = typeof b?.currency === 'string' && b.currency.length === 3 ? b.currency.toUpperCase() : null;
  const effectiveAt = dateOf(b?.effectiveAt);
  if (!amountCents || !currency || !validCurrency(currency) || !effectiveAt) return reply({ error: 'invalid_reprice' }, 400);
  const existing = await env.DB.prepare('SELECT status FROM fin_subscriptions WHERE id=?').bind(id).first<{ status: string }>();
  if (!existing) return reply({ error: 'not_found' }, 404);
  if (existing.status === 'canceled' || existing.status === 'ended') return reply({ error: 'subscription_terminal' }, 409);
  await env.DB.batch([
    env.DB.prepare('UPDATE fin_subscriptions SET amount_cents=?,currency=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(amountCents, currency, id),
    env.DB.prepare('INSERT INTO fin_subscription_price_history (id,subscription_id,amount_cents,currency,effective_at,created_by) VALUES (?,?,?,?,?,?)')
      .bind(crypto.randomUUID(), id, amountCents, currency, effectiveAt, auth.userId),
  ]);
  await audit(env, auth.userId, 'finance.subscription_repriced', 'fin_subscription', id);
  return reply({ ok: true });
}

async function financeSubscriptionPriceHistory(req: Request, env: Env, id: string) {
  if (!(await requireMaster(req, env))) return reply({ error: 'forbidden' }, 403);
  const rows = await env.DB.prepare('SELECT id,amount_cents,currency,effective_at,created_at FROM fin_subscription_price_history WHERE subscription_id=? ORDER BY effective_at DESC,created_at DESC').bind(id).all<Row>();
  return reply({ priceHistory: rows.results.map((row) => ({ id: row.id, amountCents: row.amount_cents, currency: row.currency, effectiveAt: row.effective_at, createdAt: row.created_at })) });
}

async function financeSubscriptionStatus(req: Request, env: Env, id: string) {
  const auth = await mutationAuth(req, env); if (!auth) return reply({ error: 'unauthorized' }, 401); if (!auth.roles.includes('master')) return reply({ error: 'forbidden' }, 403);
  const b = await body(req);
  const status = typeof b?.status === 'string' && FINANCE_SUBSCRIPTION_STATUSES.includes(b.status) ? b.status : null;
  const reason = text(b?.reason, 500);
  if (!status) return reply({ error: 'invalid_request' }, 400);
  const existing = await env.DB.prepare('SELECT status FROM fin_subscriptions WHERE id=?').bind(id).first<{ status: string }>();
  if (!existing) return reply({ error: 'not_found' }, 404);
  if (!isValidSubscriptionTransition(existing.status, status)) return reply({ error: 'invalid_transition' }, 409);
  const endedAt = status === 'ended' || status === 'canceled' ? new Date().toISOString().slice(0, 10) : null;
  await env.DB.prepare('UPDATE fin_subscriptions SET status=?,ended_at=COALESCE(?,ended_at),updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(status, endedAt, id).run();
  await audit(env, auth.userId, 'finance.subscription_status_changed', 'fin_subscription', id);
  return reply({ ok: true });
}

async function financeSubscriptionGenerateCharges(req: Request, env: Env) {
  const auth = await mutationAuth(req, env); if (!auth) return reply({ error: 'unauthorized' }, 401); if (!auth.roles.includes('master')) return reply({ error: 'forbidden' }, 403);
  const today = new Date().toISOString().slice(0, 10);
  const due = await env.DB.prepare(
    "SELECT id,counterparty_id,amount_cents,currency,periodicity,custom_interval_days,next_charge_at,category_id,cost_center_id,account_id FROM fin_subscriptions WHERE status='active' AND next_charge_at<=?",
  ).bind(today).all<Row>();
  let created = 0; let skipped = 0;
  for (const subscription of due.results) {
    const periodDates: string[] = [];
    let cursor = String(subscription.next_charge_at).slice(0, 10);
    let iterations = 0;
    while (cursor <= today && iterations < 36) {
      periodDates.push(cursor);
      cursor = nextChargeDate(cursor, subscription.periodicity as SubscriptionPeriodicity, (subscription.custom_interval_days as number | null) ?? undefined);
      iterations += 1;
    }
    for (const periodDate of periodDates) {
      const idempotencyKey = subscriptionChargeIdempotencyKey(String(subscription.id), periodDate);
      const result = await env.DB.prepare(
        `INSERT INTO fin_obligations
          (id,kind,counterparty_id,category_id,cost_center_id,competency_date,due_date,amount_cents,currency,account_id,subscription_id,source,idempotency_key,created_by)
         VALUES (?,'operating_expense',?,?,?,?,?,?,?,?,?,'subscription_charge',?,?)
         ON CONFLICT(idempotency_key) DO NOTHING`,
      ).bind(crypto.randomUUID(), subscription.counterparty_id, subscription.category_id, subscription.cost_center_id, periodDate, periodDate,
        subscription.amount_cents, subscription.currency, subscription.account_id, subscription.id, idempotencyKey, auth.userId).run();
      if (result.meta.changes) created += 1; else skipped += 1;
    }
    await env.DB.prepare('UPDATE fin_subscriptions SET next_charge_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(cursor, subscription.id).run();
  }
  await audit(env, auth.userId, 'finance.subscription_charges_generated', 'fin_subscription', null);
  return reply({ subscriptionsDue: due.results.length, created, skipped });
}

async function financeObligations(req: Request, env: Env, url: URL) {
  if (!(await requireMaster(req, env))) return reply({ error: 'forbidden' }, 403);
  const status = url.searchParams.get('status');
  const kind = url.searchParams.get('kind');
  const dueBefore = url.searchParams.get('dueBefore');
  const counterpartyId = url.searchParams.get('counterpartyId');
  const currency = url.searchParams.get('currency');
  if (status && !FINANCE_OBLIGATION_STATUSES.includes(status)) return reply({ error: 'invalid_filter' }, 400);
  if (kind && !FINANCE_OBLIGATION_KINDS.includes(kind)) return reply({ error: 'invalid_filter' }, 400);
  if (counterpartyId && !UUID_RE.test(counterpartyId)) return reply({ error: 'invalid_filter' }, 400);
  const rows = await env.DB.prepare(
    `SELECT id,kind,counterparty_id,category_id,cost_center_id,competency_date,due_date,amount_cents,currency,
            account_id,status,subscription_id,source,notes,canceled_at,cancel_reason,created_at,updated_at,
            (status IN ('open','partial') AND due_date < ?6) AS is_overdue
       FROM fin_obligations
      WHERE (?1 IS NULL OR status=?1) AND (?2 IS NULL OR kind=?2) AND (?3 IS NULL OR due_date<=?3)
        AND (?4 IS NULL OR counterparty_id=?4) AND (?5 IS NULL OR currency=?5)
      ORDER BY due_date,created_at LIMIT 500`,
  ).bind(status, kind, dueBefore, counterpartyId, currency, new Date().toISOString().slice(0, 10)).all<Row>();
  return reply({ obligations: rows.results.map(serializeFinObligation) });
}

async function financeObligationCreate(req: Request, env: Env) {
  const auth = await mutationAuth(req, env); if (!auth) return reply({ error: 'unauthorized' }, 401); if (!auth.roles.includes('master')) return reply({ error: 'forbidden' }, 403);
  const b = await body(req);
  const kind = typeof b?.kind === 'string' && FINANCE_OBLIGATION_KINDS.includes(b.kind) ? b.kind : null;
  const counterpartyId = typeof b?.counterpartyId === 'string' && UUID_RE.test(b.counterpartyId) ? b.counterpartyId : null;
  const categoryId = typeof b?.categoryId === 'string' && UUID_RE.test(b.categoryId) ? b.categoryId : null;
  const costCenterIdInput = typeof b?.costCenterId === 'string' && UUID_RE.test(b.costCenterId) ? b.costCenterId : null;
  const competencyDate = dateOf(b?.competencyDate);
  const dueDate = dateOf(b?.dueDate);
  const amountCents = intOf(b?.amountCents, 1, 100_000_000_00);
  const currency = typeof b?.currency === 'string' && b.currency.length === 3 ? b.currency.toUpperCase() : null;
  const accountId = typeof b?.accountId === 'string' && UUID_RE.test(b.accountId) ? b.accountId : null;
  const notes = text(b?.notes, 1000) || null;
  if (!kind || !categoryId || !competencyDate || !dueDate || !amountCents || !currency || !validCurrency(currency)) return reply({ error: 'invalid_obligation' }, 400);

  const category = await env.DB.prepare('SELECT kind,default_cost_center_id FROM fin_categories WHERE id=? AND active=1').bind(categoryId).first<{ kind: string; default_cost_center_id: string | null }>();
  if (!category) return reply({ error: 'category_not_found' }, 422);
  if (category.kind !== kind) return reply({ error: 'category_kind_mismatch' }, 422);
  if (counterpartyId) { const counterparty = await env.DB.prepare('SELECT 1 FROM fin_counterparties WHERE id=? AND active=1').bind(counterpartyId).first(); if (!counterparty) return reply({ error: 'counterparty_not_found' }, 422); }
  const costCenterId = costCenterIdInput ?? category.default_cost_center_id ?? null;
  if (costCenterIdInput) { const costCenter = await env.DB.prepare('SELECT 1 FROM fin_cost_centers WHERE id=?').bind(costCenterIdInput).first(); if (!costCenter) return reply({ error: 'cost_center_not_found' }, 422); }
  if (accountId) { const account = await env.DB.prepare('SELECT 1 FROM fin_accounts WHERE id=? AND active=1').bind(accountId).first(); if (!account) return reply({ error: 'account_not_found' }, 422); }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO fin_obligations (id,kind,counterparty_id,category_id,cost_center_id,competency_date,due_date,amount_cents,currency,account_id,notes,created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(id, kind, counterpartyId, categoryId, costCenterId, competencyDate, dueDate, amountCents, currency, accountId, notes, auth.userId).run();
  await audit(env, auth.userId, 'finance.obligation_created', 'fin_obligation', id);
  return reply({ id }, 201);
}

async function financeObligationUpdate(req: Request, env: Env, id: string) {
  const auth = await mutationAuth(req, env); if (!auth) return reply({ error: 'unauthorized' }, 401); if (!auth.roles.includes('master')) return reply({ error: 'forbidden' }, 403);
  const b = await body(req);
  const has = (key: string) => b != null && key in b;
  const existing = await env.DB.prepare('SELECT status,kind FROM fin_obligations WHERE id=?').bind(id).first<{ status: string; kind: string }>();
  if (!existing) return reply({ error: 'not_found' }, 404);
  if (existing.status === 'canceled' || existing.status === 'reversed') return reply({ error: 'obligation_terminal' }, 409);
  const categoryId = typeof b?.categoryId === 'string' && UUID_RE.test(b.categoryId) ? b.categoryId : null;
  const costCenterId = typeof b?.costCenterId === 'string' && UUID_RE.test(b.costCenterId) ? b.costCenterId : null;
  const dueDate = dateOf(b?.dueDate);
  const accountId = typeof b?.accountId === 'string' && UUID_RE.test(b.accountId) ? b.accountId : null;
  const notes = text(b?.notes, 1000) || null;
  if (categoryId) {
    const category = await env.DB.prepare('SELECT kind FROM fin_categories WHERE id=? AND active=1').bind(categoryId).first<{ kind: string }>();
    if (!category) return reply({ error: 'category_not_found' }, 422);
    if (category.kind !== existing.kind) return reply({ error: 'category_kind_mismatch' }, 422);
  }
  if (has('costCenterId') && costCenterId) { const costCenter = await env.DB.prepare('SELECT 1 FROM fin_cost_centers WHERE id=?').bind(costCenterId).first(); if (!costCenter) return reply({ error: 'cost_center_not_found' }, 422); }
  if (has('accountId') && accountId) { const account = await env.DB.prepare('SELECT 1 FROM fin_accounts WHERE id=? AND active=1').bind(accountId).first(); if (!account) return reply({ error: 'account_not_found' }, 422); }
  const result = await env.DB.prepare(
    `UPDATE fin_obligations SET
        category_id=COALESCE(?,category_id),
        cost_center_id=CASE WHEN ?=1 THEN ? ELSE cost_center_id END,
        due_date=COALESCE(?,due_date),
        account_id=CASE WHEN ?=1 THEN ? ELSE account_id END,
        notes=CASE WHEN ?=1 THEN ? ELSE notes END,
        updated_at=CURRENT_TIMESTAMP
      WHERE id=?`,
  ).bind(categoryId, has('costCenterId') ? 1 : 0, costCenterId, dueDate, has('accountId') ? 1 : 0, accountId, has('notes') ? 1 : 0, notes, id).run();
  if (!result.meta.changes) return reply({ error: 'not_found' }, 404);
  await audit(env, auth.userId, 'finance.obligation_updated', 'fin_obligation', id);
  return reply({ ok: true });
}

async function financeObligationCancel(req: Request, env: Env, id: string) {
  const auth = await mutationAuth(req, env); if (!auth) return reply({ error: 'unauthorized' }, 401); if (!auth.roles.includes('master')) return reply({ error: 'forbidden' }, 403);
  const b = await body(req);
  const reasonValue = text(b?.reason, 500, 3);
  if (!reasonValue) return reply({ error: 'invalid_request' }, 400);
  const existing = await env.DB.prepare('SELECT status FROM fin_obligations WHERE id=?').bind(id).first<{ status: string }>();
  if (!existing) return reply({ error: 'not_found' }, 404);
  if (existing.status !== 'open') return reply({ error: 'obligation_has_payments_or_terminal' }, 409);
  const result = await env.DB.prepare("UPDATE fin_obligations SET status='canceled',canceled_at=CURRENT_TIMESTAMP,canceled_by=?,cancel_reason=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='open'")
    .bind(auth.userId, reasonValue, id).run();
  if (!result.meta.changes) return reply({ error: 'obligation_has_payments_or_terminal' }, 409);
  await audit(env, auth.userId, 'finance.obligation_canceled', 'fin_obligation', id);
  return reply({ ok: true });
}

async function financeObligationPayments(req: Request, env: Env, id: string) {
  if (!(await requireMaster(req, env))) return reply({ error: 'forbidden' }, 403);
  const rows = await env.DB.prepare('SELECT id,paid_amount_cents,currency,paid_at,account_id,reference,reversal_of,reversal_reason,created_at FROM fin_obligation_payments WHERE obligation_id=? ORDER BY created_at').bind(id).all<Row>();
  return reply({ payments: rows.results.map(serializeFinPayment) });
}

async function financeObligationPaymentCreate(req: Request, env: Env, obligationId: string) {
  const auth = await mutationAuth(req, env); if (!auth) return reply({ error: 'unauthorized' }, 401); if (!auth.roles.includes('master')) return reply({ error: 'forbidden' }, 403);
  const b = await body(req);
  const paidAmountCents = intOf(b?.paidAmountCents, 1, 100_000_000_00);
  const currency = typeof b?.currency === 'string' && b.currency.length === 3 ? b.currency.toUpperCase() : null;
  const paidAt = typeof b?.paidAt === 'string' && !Number.isNaN(Date.parse(b.paidAt)) ? b.paidAt : null;
  const accountId = typeof b?.accountId === 'string' && UUID_RE.test(b.accountId) ? b.accountId : null;
  const reference = text(b?.reference, 120) || null;
  if (!paidAmountCents || !currency || !validCurrency(currency) || !accountId) return reply({ error: 'invalid_payment' }, 400);

  const account = await env.DB.prepare('SELECT 1 FROM fin_accounts WHERE id=? AND active=1').bind(accountId).first();
  if (!account) return reply({ error: 'account_not_found' }, 422);
  const obligation = await env.DB.prepare('SELECT status,currency,amount_cents FROM fin_obligations WHERE id=?').bind(obligationId).first<{ status: string; currency: string; amount_cents: number }>();
  if (!obligation) return reply({ error: 'not_found' }, 404);
  if (obligation.status === 'canceled' || obligation.status === 'reversed' || obligation.status === 'paid') return reply({ error: 'obligation_not_payable' }, 409);
  if (currency !== obligation.currency) return reply({ error: 'payment_currency_must_match_obligation' }, 422);

  const paymentId = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO fin_obligation_payments (id,obligation_id,paid_amount_cents,currency,paid_at,account_id,reference,created_by) VALUES (?,?,?,?,COALESCE(?,CURRENT_TIMESTAMP),?,?,?)')
    .bind(paymentId, obligationId, paidAmountCents, currency, paidAt, accountId, reference, auth.userId).run();
  const total = await env.DB.prepare('SELECT COALESCE(sum(paid_amount_cents),0) n FROM fin_obligation_payments WHERE obligation_id=?').bind(obligationId).first<{ n: number }>();
  const totalPaid = total?.n ?? 0;
  const newStatus = totalPaid >= obligation.amount_cents ? 'paid' : totalPaid > 0 ? 'partial' : 'open';
  await env.DB.prepare('UPDATE fin_obligations SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(newStatus, obligationId).run();
  await audit(env, auth.userId, 'finance.obligation_payment_created', 'fin_obligation', obligationId);
  return reply({ id: paymentId }, 201);
}

async function financeObligationPaymentReverse(req: Request, env: Env, paymentId: string) {
  const auth = await mutationAuth(req, env); if (!auth) return reply({ error: 'unauthorized' }, 401); if (!auth.roles.includes('master')) return reply({ error: 'forbidden' }, 403);
  const b = await body(req);
  const reasonValue = text(b?.reason, 500, 3);
  if (!reasonValue) return reply({ error: 'invalid_request' }, 400);
  const payment = await env.DB.prepare('SELECT obligation_id,paid_amount_cents,currency,account_id FROM fin_obligation_payments WHERE id=?').bind(paymentId).first<{ obligation_id: string; paid_amount_cents: number; currency: string; account_id: string }>();
  if (!payment) return reply({ error: 'not_found' }, 404);
  if (payment.paid_amount_cents < 0) return reply({ error: 'cannot_reverse_a_reversal' }, 409);
  const obligation = await env.DB.prepare('SELECT amount_cents FROM fin_obligations WHERE id=?').bind(payment.obligation_id).first<{ amount_cents: number }>();
  if (!obligation) return reply({ error: 'not_found' }, 404);

  const reversalId = crypto.randomUUID();
  try {
    await env.DB.prepare('INSERT INTO fin_obligation_payments (id,obligation_id,paid_amount_cents,currency,account_id,reversal_of,reversal_reason,created_by) VALUES (?,?,?,?,?,?,?,?)')
      .bind(reversalId, payment.obligation_id, -payment.paid_amount_cents, payment.currency, payment.account_id, paymentId, reasonValue, auth.userId).run();
  } catch (error) {
    return reply({ error: 'payment_already_reversed' }, 409);
  }
  const total = await env.DB.prepare('SELECT COALESCE(sum(paid_amount_cents),0) n FROM fin_obligation_payments WHERE obligation_id=?').bind(payment.obligation_id).first<{ n: number }>();
  const totalPaid = total?.n ?? 0;
  const newStatus = totalPaid >= obligation.amount_cents ? 'paid' : totalPaid > 0 ? 'partial' : 'open';
  await env.DB.prepare('UPDATE fin_obligations SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(newStatus, payment.obligation_id).run();
  await audit(env, auth.userId, 'finance.obligation_payment_reversed', 'fin_obligation_payment', paymentId);
  return reply({ id: reversalId }, 201);
}

// --- Financeiro (Fase 3 — vendas e contas a receber) ----------------------------------------
// Mirrors src/routes/finance-sales.ts. A fin_sales row always originates from an already
// "converted" lead_requests row (the existing, unmodified conversion/commission flow above) —
// this section never recreates or touches partner_commissions, it only reads lead_requests.
const FINANCE_SALE_STATUSES = ['confirmed', 'canceled', 'refunded'];
const FINANCE_RECEIVABLE_METHODS = ['pix', 'transfer', 'card', 'cash', 'boleto', 'other'];

interface SaleTotalsRow { expectedTotal: number; receivedTotal: number; receivableCount: number }

/** Same application-code aggregation as src/routes/finance-sales.ts's receivableTotalsBySale — avoids a SQL FILTER (WHERE ...) / correlated subquery whose D1/SQLite support is not something this repo relies on elsewhere. */
async function financeReceivableTotalsBySale(env: Env, saleId?: string): Promise<Map<string, SaleTotalsRow>> {
  const receivables = saleId
    ? await env.DB.prepare('SELECT sale_id,status,expected_amount_cents FROM fin_receivables WHERE sale_id=?').bind(saleId).all<Row>()
    : await env.DB.prepare('SELECT sale_id,status,expected_amount_cents FROM fin_receivables').all<Row>();
  const payments = saleId
    ? await env.DB.prepare('SELECT r.sale_id sale_id,p.received_amount_cents received_amount_cents FROM fin_receivable_payments p JOIN fin_receivables r ON r.id=p.receivable_id WHERE r.sale_id=?').bind(saleId).all<Row>()
    : await env.DB.prepare('SELECT r.sale_id sale_id,p.received_amount_cents received_amount_cents FROM fin_receivable_payments p JOIN fin_receivables r ON r.id=p.receivable_id').all<Row>();
  const totals = new Map<string, SaleTotalsRow>();
  for (const row of receivables.results) {
    const key = String(row.sale_id);
    const entry = totals.get(key) ?? { expectedTotal: 0, receivedTotal: 0, receivableCount: 0 };
    if (row.status !== 'canceled') { entry.expectedTotal += Number(row.expected_amount_cents); entry.receivableCount += 1; }
    totals.set(key, entry);
  }
  for (const row of payments.results) {
    const key = String(row.sale_id);
    const entry = totals.get(key) ?? { expectedTotal: 0, receivedTotal: 0, receivableCount: 0 };
    entry.receivedTotal += Number(row.received_amount_cents);
    totals.set(key, entry);
  }
  return totals;
}

function serializeFinSale(row: Row, totals?: SaleTotalsRow) {
  const expectedTotal = totals?.expectedTotal ?? 0;
  const receivedTotal = totals?.receivedTotal ?? 0;
  const receivableCount = totals?.receivableCount ?? 0;
  let financialStatus: string;
  if (row.status === 'canceled') financialStatus = 'canceled';
  else if (row.status === 'refunded') financialStatus = 'refunded';
  else if (receivableCount === 0) financialStatus = 'no_receivables';
  else if (receivedTotal >= expectedTotal && expectedTotal > 0) financialStatus = 'paid';
  else if (receivedTotal > 0) financialStatus = 'partial';
  else financialStatus = 'open';
  return {
    id: row.id, leadRequestId: row.lead_request_id, protocol: row.protocol, saleDate: row.sale_date, currency: row.currency,
    grossAmountCents: row.gross_amount_cents, discountCents: row.discount_cents, netAmountCents: row.net_amount_cents,
    passengerCount: row.passenger_count, ownerUserId: row.owner_user_id, partnerId: row.partner_id, status: row.status, financialStatus,
    internalNotes: row.internal_notes, terminatedAt: row.terminated_at, terminationReason: row.termination_reason,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
function serializeFinReceivable(row: Row) {
  return {
    id: row.id, installmentNumber: row.installment_number, dueDate: row.due_date, expectedAmountCents: row.expected_amount_cents,
    currency: row.currency, accountId: row.account_id, method: row.method, status: row.status,
    canceledAt: row.canceled_at, cancelReason: row.cancel_reason, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
function serializeFinReceivablePayment(row: Row) {
  return {
    id: row.id, receivedAmountCents: row.received_amount_cents, currency: row.currency, receivedAt: row.received_at,
    accountId: row.account_id, gatewayFeeCents: row.gateway_fee_cents, reference: row.reference,
    reversalOf: row.reversal_of, reversalReason: row.reversal_reason, createdAt: row.created_at,
  };
}

const financeSalesSelectColumns = 'id,lead_request_id,protocol,sale_date,currency,gross_amount_cents,discount_cents,net_amount_cents,passenger_count,owner_user_id,partner_id,status,internal_notes,terminated_at,termination_reason,created_at,updated_at';

async function financeSales(req: Request, env: Env, url: URL) {
  if (!(await requireMaster(req, env))) return reply({ error: 'forbidden' }, 403);
  const status = url.searchParams.get('status');
  const partnerId = url.searchParams.get('partnerId');
  const currency = url.searchParams.get('currency');
  if (status && !FINANCE_SALE_STATUSES.includes(status)) return reply({ error: 'invalid_filter' }, 400);
  if (partnerId && !UUID_RE.test(partnerId)) return reply({ error: 'invalid_filter' }, 400);
  const rows = await env.DB.prepare(
    `SELECT ${financeSalesSelectColumns} FROM fin_sales
      WHERE (?1 IS NULL OR status=?1) AND (?2 IS NULL OR partner_id=?2) AND (?3 IS NULL OR currency=?3)
      ORDER BY sale_date DESC,created_at DESC LIMIT 500`,
  ).bind(status, partnerId, currency).all<Row>();
  const totals = await financeReceivableTotalsBySale(env);
  return reply({ sales: rows.results.map((row) => serializeFinSale(row, totals.get(String(row.id)))) });
}

async function financeSaleDetail(req: Request, env: Env, id: string) {
  if (!(await requireMaster(req, env))) return reply({ error: 'forbidden' }, 403);
  const row = await env.DB.prepare(`SELECT ${financeSalesSelectColumns} FROM fin_sales WHERE id=?`).bind(id).first<Row>();
  if (!row) return reply({ error: 'not_found' }, 404);
  const receivables = await env.DB.prepare('SELECT id,installment_number,due_date,expected_amount_cents,currency,account_id,method,status,canceled_at,cancel_reason,created_at,updated_at FROM fin_receivables WHERE sale_id=? ORDER BY installment_number').bind(id).all<Row>();
  const totals = await financeReceivableTotalsBySale(env, id);
  const issuances = await env.DB.prepare(`SELECT ${financeIssuancesSelectColumns} FROM fin_issuances WHERE sale_id=? ORDER BY created_at`).bind(id).all<Row>();
  const profit = calculateFinSaleProfitSummary(Number(row.net_amount_cents), issuances.results);
  return reply({
    sale: serializeFinSale(row, totals.get(id)),
    receivables: receivables.results.map(serializeFinReceivable),
    issuances: issuances.results.map(serializeFinIssuance),
    profit,
  });
}

async function financeSaleFromLead(req: Request, env: Env, leadRequestId: string) {
  const auth = await mutationAuth(req, env); if (!auth) return reply({ error: 'unauthorized' }, 401); if (!auth.roles.includes('master')) return reply({ error: 'forbidden' }, 403);
  const b = await body(req);
  const discountCents = Number.isInteger(b?.discountCents) ? Number(b?.discountCents) : 0;
  const saleDateInput = typeof b?.saleDate === 'string' ? dateOf(b.saleDate) : null;
  if (discountCents < 0) return reply({ error: 'invalid_request' }, 400);

  const existing = await env.DB.prepare('SELECT id FROM fin_sales WHERE lead_request_id=?').bind(leadRequestId).first<{ id: string }>();
  if (existing) return reply({ id: existing.id, alreadyExisted: true });

  const lead = await env.DB.prepare("SELECT id,status,protocol,sale_amount_cents,sale_currency,partner_id,adults,children,infants FROM lead_requests WHERE id=? AND kind='flight_quote'").bind(leadRequestId).first<Row>();
  if (!lead) return reply({ error: 'lead_not_found' }, 404);
  if (lead.status !== 'converted') return reply({ error: 'lead_not_converted' }, 409);
  if (lead.sale_amount_cents === null || lead.sale_amount_cents === undefined || !lead.sale_currency) return reply({ error: 'sale_amount_missing' }, 422);
  if (!lead.protocol) return reply({ error: 'lead_protocol_missing' }, 422);

  const grossAmountCents = Number(lead.sale_amount_cents);
  if (discountCents >= grossAmountCents) return reply({ error: 'discount_exceeds_gross_amount' }, 422);
  const netAmountCents = grossAmountCents - discountCents;
  const passengerCount = Number(lead.adults) + Number(lead.children) + Number(lead.infants);
  const saleDate = saleDateInput ?? new Date().toISOString().slice(0, 10);

  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(
      `INSERT INTO fin_sales (id,lead_request_id,protocol,sale_date,currency,gross_amount_cents,discount_cents,net_amount_cents,passenger_count,owner_user_id,partner_id,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(id, lead.id, lead.protocol, saleDate, lead.sale_currency, grossAmountCents, discountCents, netAmountCents, passengerCount, auth.userId, lead.partner_id, auth.userId).run();
  } catch (error) {
    const raceExisting = await env.DB.prepare('SELECT id FROM fin_sales WHERE lead_request_id=?').bind(leadRequestId).first<{ id: string }>();
    if (raceExisting) return reply({ id: raceExisting.id, alreadyExisted: true });
    return reply({ error: 'sale_creation_failed' }, 500);
  }
  await audit(env, auth.userId, 'finance.sale_created', 'fin_sale', id);
  return reply({ id, alreadyExisted: false }, 201);
}

async function financeSaleCancel(req: Request, env: Env, id: string) {
  const auth = await mutationAuth(req, env); if (!auth) return reply({ error: 'unauthorized' }, 401); if (!auth.roles.includes('master')) return reply({ error: 'forbidden' }, 403);
  const b = await body(req);
  const reasonValue = text(b?.reason, 500, 3);
  if (!reasonValue) return reply({ error: 'invalid_request' }, 400);
  const sale = await env.DB.prepare('SELECT status FROM fin_sales WHERE id=?').bind(id).first<{ status: string }>();
  if (!sale) return reply({ error: 'not_found' }, 404);
  if (sale.status !== 'confirmed') return reply({ error: 'sale_not_cancelable' }, 409);
  const received = await env.DB.prepare('SELECT COALESCE(sum(p.received_amount_cents),0) n FROM fin_receivable_payments p JOIN fin_receivables r ON r.id=p.receivable_id WHERE r.sale_id=?').bind(id).first<{ n: number }>();
  if ((received?.n ?? 0) !== 0) return reply({ error: 'sale_has_payments_use_refund' }, 409);
  const result = await env.DB.prepare("UPDATE fin_sales SET status='canceled',terminated_at=CURRENT_TIMESTAMP,terminated_by=?,termination_reason=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='confirmed'")
    .bind(auth.userId, reasonValue, id).run();
  if (!result.meta.changes) return reply({ error: 'sale_not_cancelable' }, 409);
  await audit(env, auth.userId, 'finance.sale_canceled', 'fin_sale', id);
  return reply({ ok: true });
}

async function financeSaleRefund(req: Request, env: Env, id: string) {
  const auth = await mutationAuth(req, env); if (!auth) return reply({ error: 'unauthorized' }, 401); if (!auth.roles.includes('master')) return reply({ error: 'forbidden' }, 403);
  const b = await body(req);
  const reasonValue = text(b?.reason, 500, 3);
  if (!reasonValue) return reply({ error: 'invalid_request' }, 400);
  const sale = await env.DB.prepare('SELECT status FROM fin_sales WHERE id=?').bind(id).first<{ status: string }>();
  if (!sale) return reply({ error: 'not_found' }, 404);
  if (sale.status !== 'confirmed') return reply({ error: 'sale_not_refundable' }, 409);
  const received = await env.DB.prepare('SELECT COALESCE(sum(p.received_amount_cents),0) n FROM fin_receivable_payments p JOIN fin_receivables r ON r.id=p.receivable_id WHERE r.sale_id=?').bind(id).first<{ n: number }>();
  if ((received?.n ?? 0) <= 0) return reply({ error: 'sale_has_no_payments_use_cancel' }, 409);
  const result = await env.DB.prepare("UPDATE fin_sales SET status='refunded',terminated_at=CURRENT_TIMESTAMP,terminated_by=?,termination_reason=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='confirmed'")
    .bind(auth.userId, reasonValue, id).run();
  if (!result.meta.changes) return reply({ error: 'sale_not_refundable' }, 409);
  await audit(env, auth.userId, 'finance.sale_refunded', 'fin_sale', id);
  return reply({ ok: true });
}

async function financeSaleReceivables(req: Request, env: Env, saleId: string) {
  if (!(await requireMaster(req, env))) return reply({ error: 'forbidden' }, 403);
  const rows = await env.DB.prepare('SELECT id,installment_number,due_date,expected_amount_cents,currency,account_id,method,status,canceled_at,cancel_reason,created_at,updated_at FROM fin_receivables WHERE sale_id=? ORDER BY installment_number').bind(saleId).all<Row>();
  return reply({ receivables: rows.results.map(serializeFinReceivable) });
}

async function financeSaleReceivablesCreate(req: Request, env: Env, saleId: string) {
  const auth = await mutationAuth(req, env); if (!auth) return reply({ error: 'unauthorized' }, 401); if (!auth.roles.includes('master')) return reply({ error: 'forbidden' }, 403);
  const b = await body(req);
  const installmentsInput = Array.isArray(b?.installments) ? b.installments : null;
  if (!installmentsInput || installmentsInput.length < 1 || installmentsInput.length > 24) return reply({ error: 'invalid_request' }, 400);
  const installments: { dueDate: string; expectedAmountCents: number; method: string; accountId: string | null }[] = [];
  for (const item of installmentsInput as Row[]) {
    const dueDate = dateOf(item?.dueDate);
    const expectedAmountCents = intOf(item?.expectedAmountCents, 1, 100_000_000_00);
    const method = typeof item?.method === 'string' && FINANCE_RECEIVABLE_METHODS.includes(item.method) ? item.method : null;
    const accountId = typeof item?.accountId === 'string' && UUID_RE.test(item.accountId) ? item.accountId : null;
    if (!dueDate || !expectedAmountCents || !method) return reply({ error: 'invalid_request' }, 400);
    installments.push({ dueDate, expectedAmountCents, method, accountId });
  }
  for (const installment of installments) {
    if (installment.accountId) {
      const account = await env.DB.prepare('SELECT 1 FROM fin_accounts WHERE id=? AND active=1').bind(installment.accountId).first();
      if (!account) return reply({ error: 'account_not_found' }, 422);
    }
  }

  const sale = await env.DB.prepare('SELECT status,currency,net_amount_cents FROM fin_sales WHERE id=?').bind(saleId).first<{ status: string; currency: string; net_amount_cents: number }>();
  if (!sale) return reply({ error: 'not_found' }, 404);
  if (sale.status !== 'confirmed') return reply({ error: 'sale_not_confirmed' }, 409);

  const existingTotal = await env.DB.prepare("SELECT COALESCE(sum(expected_amount_cents),0) sum,COALESCE(max(installment_number),0) max_installment FROM fin_receivables WHERE sale_id=? AND status<>'canceled'").bind(saleId).first<{ sum: number; max_installment: number }>();
  const alreadyCommitted = existingTotal?.sum ?? 0;
  let nextNumber = (existingTotal?.max_installment ?? 0) + 1;
  const newTotal = installments.reduce((sum, item) => sum + item.expectedAmountCents, 0);
  if (alreadyCommitted + newTotal > sale.net_amount_cents) return reply({ error: 'installments_exceed_sale_amount' }, 409);

  const createdIds: string[] = [];
  const statements: D1PreparedStatement[] = [];
  for (const installment of installments) {
    const id = crypto.randomUUID();
    statements.push(env.DB.prepare('INSERT INTO fin_receivables (id,sale_id,installment_number,due_date,expected_amount_cents,currency,account_id,method) VALUES (?,?,?,?,?,?,?,?)')
      .bind(id, saleId, nextNumber, installment.dueDate, installment.expectedAmountCents, sale.currency, installment.accountId, installment.method));
    createdIds.push(id);
    nextNumber += 1;
  }
  await env.DB.batch(statements);
  await audit(env, auth.userId, 'finance.receivables_created', 'fin_sale', saleId);
  return reply({ ids: createdIds }, 201);
}

async function financeReceivablePayments(req: Request, env: Env, receivableId: string) {
  if (!(await requireMaster(req, env))) return reply({ error: 'forbidden' }, 403);
  const rows = await env.DB.prepare('SELECT id,received_amount_cents,currency,received_at,account_id,gateway_fee_cents,reference,reversal_of,reversal_reason,created_at FROM fin_receivable_payments WHERE receivable_id=? ORDER BY created_at').bind(receivableId).all<Row>();
  return reply({ payments: rows.results.map(serializeFinReceivablePayment) });
}

async function financeReceivablePaymentCreate(req: Request, env: Env, receivableId: string) {
  const auth = await mutationAuth(req, env); if (!auth) return reply({ error: 'unauthorized' }, 401); if (!auth.roles.includes('master')) return reply({ error: 'forbidden' }, 403);
  const b = await body(req);
  const receivedAmountCents = intOf(b?.receivedAmountCents, 1, 100_000_000_00);
  const currency = typeof b?.currency === 'string' && b.currency.length === 3 ? b.currency.toUpperCase() : null;
  const receivedAt = typeof b?.receivedAt === 'string' && !Number.isNaN(Date.parse(b.receivedAt)) ? b.receivedAt : null;
  const accountId = typeof b?.accountId === 'string' && UUID_RE.test(b.accountId) ? b.accountId : null;
  const gatewayFeeCents = Number.isInteger(b?.gatewayFeeCents) ? Number(b?.gatewayFeeCents) : null;
  const reference = text(b?.reference, 120) || null;
  if (!receivedAmountCents || !currency || !validCurrency(currency) || !accountId) return reply({ error: 'invalid_payment' }, 400);

  const account = await env.DB.prepare('SELECT 1 FROM fin_accounts WHERE id=? AND active=1').bind(accountId).first();
  if (!account) return reply({ error: 'account_not_found' }, 422);
  const receivable = await env.DB.prepare('SELECT status,currency,expected_amount_cents FROM fin_receivables WHERE id=?').bind(receivableId).first<{ status: string; currency: string; expected_amount_cents: number }>();
  if (!receivable) return reply({ error: 'not_found' }, 404);
  if (receivable.status === 'canceled' || receivable.status === 'refunded' || receivable.status === 'paid') return reply({ error: 'receivable_not_payable' }, 409);
  if (currency !== receivable.currency) return reply({ error: 'payment_currency_must_match_receivable' }, 422);

  const paymentId = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO fin_receivable_payments (id,receivable_id,received_amount_cents,currency,received_at,account_id,gateway_fee_cents,reference,created_by) VALUES (?,?,?,?,COALESCE(?,CURRENT_TIMESTAMP),?,?,?,?)')
    .bind(paymentId, receivableId, receivedAmountCents, currency, receivedAt, accountId, gatewayFeeCents, reference, auth.userId).run();
  const total = await env.DB.prepare('SELECT COALESCE(sum(received_amount_cents),0) n FROM fin_receivable_payments WHERE receivable_id=?').bind(receivableId).first<{ n: number }>();
  const totalReceived = total?.n ?? 0;
  const newStatus = totalReceived >= receivable.expected_amount_cents ? 'paid' : totalReceived > 0 ? 'partial' : 'open';
  await env.DB.prepare('UPDATE fin_receivables SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(newStatus, receivableId).run();
  await audit(env, auth.userId, 'finance.receivable_payment_created', 'fin_receivable', receivableId);
  return reply({ id: paymentId }, 201);
}

async function financeReceivablePaymentReverse(req: Request, env: Env, paymentId: string) {
  const auth = await mutationAuth(req, env); if (!auth) return reply({ error: 'unauthorized' }, 401); if (!auth.roles.includes('master')) return reply({ error: 'forbidden' }, 403);
  const b = await body(req);
  const reasonValue = text(b?.reason, 500, 3);
  if (!reasonValue) return reply({ error: 'invalid_request' }, 400);
  const payment = await env.DB.prepare('SELECT receivable_id,received_amount_cents,currency,account_id FROM fin_receivable_payments WHERE id=?').bind(paymentId).first<{ receivable_id: string; received_amount_cents: number; currency: string; account_id: string }>();
  if (!payment) return reply({ error: 'not_found' }, 404);
  if (payment.received_amount_cents < 0) return reply({ error: 'cannot_reverse_a_reversal' }, 409);
  const receivable = await env.DB.prepare('SELECT expected_amount_cents FROM fin_receivables WHERE id=?').bind(payment.receivable_id).first<{ expected_amount_cents: number }>();
  if (!receivable) return reply({ error: 'not_found' }, 404);

  const reversalId = crypto.randomUUID();
  try {
    await env.DB.prepare('INSERT INTO fin_receivable_payments (id,receivable_id,received_amount_cents,currency,account_id,reversal_of,reversal_reason,created_by) VALUES (?,?,?,?,?,?,?,?)')
      .bind(reversalId, payment.receivable_id, -payment.received_amount_cents, payment.currency, payment.account_id, paymentId, reasonValue, auth.userId).run();
  } catch (error) {
    return reply({ error: 'payment_already_reversed' }, 409);
  }
  const total = await env.DB.prepare('SELECT COALESCE(sum(received_amount_cents),0) n FROM fin_receivable_payments WHERE receivable_id=?').bind(payment.receivable_id).first<{ n: number }>();
  const totalReceived = total?.n ?? 0;
  const newStatus = totalReceived >= receivable.expected_amount_cents ? 'paid' : totalReceived > 0 ? 'partial' : 'open';
  await env.DB.prepare('UPDATE fin_receivables SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(newStatus, payment.receivable_id).run();
  await audit(env, auth.userId, 'finance.receivable_payment_reversed', 'fin_receivable_payment', paymentId);
  return reply({ id: reversalId }, 201);
}

// --- Financeiro (Fase 4 — emissões, custos e lucro) ------------------------------------------
// Mirrors src/routes/finance-issuances.ts and the profit-summary addition to GET /sales/{id} in
// src/routes/finance-sales.ts.
const FINANCE_ISSUANCE_MODES = ['cash', 'miles', 'hybrid', 'consolidator', 'airline', 'other'];
const financeIssuancesSelectColumns = 'id,sale_id,mode,airline,loyalty_program,pnr,ticket_numbers,currency,cash_amount_cents,miles_quantity,miles_cost_cents,airport_fees_cents,issuance_fee_cents,consolidator_fee_cents,gateway_fee_cents,agent_commission_cents,other_costs_cents,mileage_provider_id,consolidator_id,status,issued_at,issued_by,terminated_at,terminated_by,termination_reason,notes,created_at,updated_at';

function serializeFinIssuance(row: Row) {
  return {
    id: row.id, saleId: row.sale_id, mode: row.mode, airline: row.airline, loyaltyProgram: row.loyalty_program,
    pnr: row.pnr, ticketNumbers: row.ticket_numbers, currency: row.currency, cashAmountCents: row.cash_amount_cents,
    milesQuantity: row.miles_quantity, milesCostCents: row.miles_cost_cents, airportFeesCents: row.airport_fees_cents,
    issuanceFeeCents: row.issuance_fee_cents, consolidatorFeeCents: row.consolidator_fee_cents, gatewayFeeCents: row.gateway_fee_cents,
    agentCommissionCents: row.agent_commission_cents, otherCostsCents: row.other_costs_cents,
    mileageProviderId: row.mileage_provider_id, consolidatorId: row.consolidator_id, status: row.status,
    issuedAt: row.issued_at, issuedBy: row.issued_by, terminatedAt: row.terminated_at, terminationReason: row.termination_reason,
    notes: row.notes, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

/** Mirrors src/routes/finance-sales.ts's calculateSaleProfitSummary exactly. */
function calculateFinSaleProfitSummary(netAmountCents: number, issuanceRows: Row[]) {
  let realizedDirectCostCents = 0;
  let projectedDirectCostCents = 0;
  for (const row of issuanceRows) {
    const directCost = sumIssuanceDirectCostCents({
      cashAmountCents: Number(row.cash_amount_cents), milesCostCents: Number(row.miles_cost_cents),
      airportFeesCents: Number(row.airport_fees_cents), issuanceFeeCents: Number(row.issuance_fee_cents),
      consolidatorFeeCents: Number(row.consolidator_fee_cents), gatewayFeeCents: Number(row.gateway_fee_cents),
      agentCommissionCents: Number(row.agent_commission_cents), otherCostsCents: Number(row.other_costs_cents),
    });
    if (row.status === 'issued' || row.status === 'refunded') realizedDirectCostCents += directCost;
    else if (row.status === 'pending') projectedDirectCostCents += directCost;
  }
  const realized = calculateSaleProfit(netAmountCents, realizedDirectCostCents);
  const projected = calculateSaleProfit(netAmountCents, realizedDirectCostCents + projectedDirectCostCents);
  return {
    realizedDirectCostCents, projectedDirectCostCents,
    realizedGrossProfitCents: realized.grossProfitCents, realizedMarginBps: realized.marginBps,
    projectedGrossProfitCents: projected.grossProfitCents, projectedMarginBps: projected.marginBps,
  };
}

async function financeSaleIssuances(req: Request, env: Env, saleId: string) {
  if (!(await requireMaster(req, env))) return reply({ error: 'forbidden' }, 403);
  const rows = await env.DB.prepare(`SELECT ${financeIssuancesSelectColumns} FROM fin_issuances WHERE sale_id=? ORDER BY created_at`).bind(saleId).all<Row>();
  return reply({ issuances: rows.results.map(serializeFinIssuance) });
}

async function financeSaleIssuanceCreate(req: Request, env: Env, saleId: string) {
  const auth = await mutationAuth(req, env); if (!auth) return reply({ error: 'unauthorized' }, 401); if (!auth.roles.includes('master')) return reply({ error: 'forbidden' }, 403);
  const b = await body(req);
  const mode = typeof b?.mode === 'string' && FINANCE_ISSUANCE_MODES.includes(b.mode) ? b.mode : null;
  const currency = typeof b?.currency === 'string' && b.currency.length === 3 ? b.currency.toUpperCase() : null;
  if (!mode || !currency || !validCurrency(currency)) return reply({ error: 'invalid_issuance' }, 400);
  const airline = text(b?.airline, 120) || null;
  const loyaltyProgram = text(b?.loyaltyProgram, 120) || null;
  const pnr = text(b?.pnr, 20) || null;
  const ticketNumbers = text(b?.ticketNumbers, 500) || null;
  const cashAmountCents = intOf(b?.cashAmountCents, 0, 100_000_000_00) ?? 0;
  const milesQuantity = intOf(b?.milesQuantity, 0, 100_000_000) ?? 0;
  const milesCostCents = intOf(b?.milesCostCents, 0, 100_000_000_00) ?? 0;
  const airportFeesCents = intOf(b?.airportFeesCents, 0, 100_000_000_00) ?? 0;
  const issuanceFeeCents = intOf(b?.issuanceFeeCents, 0, 100_000_000_00) ?? 0;
  const consolidatorFeeCents = intOf(b?.consolidatorFeeCents, 0, 100_000_000_00) ?? 0;
  const gatewayFeeCents = intOf(b?.gatewayFeeCents, 0, 100_000_000_00) ?? 0;
  const agentCommissionCents = intOf(b?.agentCommissionCents, 0, 100_000_000_00) ?? 0;
  const otherCostsCents = intOf(b?.otherCostsCents, 0, 100_000_000_00) ?? 0;
  const mileageProviderId = typeof b?.mileageProviderId === 'string' && UUID_RE.test(b.mileageProviderId) ? b.mileageProviderId : null;
  const consolidatorId = typeof b?.consolidatorId === 'string' && UUID_RE.test(b.consolidatorId) ? b.consolidatorId : null;
  const notes = text(b?.notes, 1000) || null;

  const sale = await env.DB.prepare('SELECT status,currency FROM fin_sales WHERE id=?').bind(saleId).first<{ status: string; currency: string }>();
  if (!sale) return reply({ error: 'sale_not_found' }, 404);
  if (sale.status !== 'confirmed') return reply({ error: 'sale_not_confirmed' }, 409);
  if (currency !== sale.currency) return reply({ error: 'issuance_currency_must_match_sale' }, 422);
  if (mileageProviderId) { const c = await env.DB.prepare('SELECT 1 FROM fin_counterparties WHERE id=? AND active=1').bind(mileageProviderId).first(); if (!c) return reply({ error: 'mileage_provider_not_found' }, 422); }
  if (consolidatorId) { const c = await env.DB.prepare('SELECT 1 FROM fin_counterparties WHERE id=? AND active=1').bind(consolidatorId).first(); if (!c) return reply({ error: 'consolidator_not_found' }, 422); }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO fin_issuances
      (id,sale_id,mode,airline,loyalty_program,pnr,ticket_numbers,currency,cash_amount_cents,miles_quantity,miles_cost_cents,
       airport_fees_cents,issuance_fee_cents,consolidator_fee_cents,gateway_fee_cents,agent_commission_cents,other_costs_cents,
       mileage_provider_id,consolidator_id,notes,created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(id, saleId, mode, airline, loyaltyProgram, pnr, ticketNumbers, currency, cashAmountCents, milesQuantity, milesCostCents,
    airportFeesCents, issuanceFeeCents, consolidatorFeeCents, gatewayFeeCents, agentCommissionCents, otherCostsCents,
    mileageProviderId, consolidatorId, notes, auth.userId).run();
  await audit(env, auth.userId, 'finance.issuance_created', 'fin_issuance', id);
  return reply({ id }, 201);
}

async function financeIssuanceUpdate(req: Request, env: Env, id: string) {
  const auth = await mutationAuth(req, env); if (!auth) return reply({ error: 'unauthorized' }, 401); if (!auth.roles.includes('master')) return reply({ error: 'forbidden' }, 403);
  const b = await body(req);
  const has = (key: string) => b != null && key in b;
  const existing = await env.DB.prepare('SELECT status FROM fin_issuances WHERE id=?').bind(id).first<{ status: string }>();
  if (!existing) return reply({ error: 'not_found' }, 404);
  if (existing.status !== 'pending') return reply({ error: 'issuance_locked_after_issued' }, 409);

  const mode = typeof b?.mode === 'string' && FINANCE_ISSUANCE_MODES.includes(b.mode) ? b.mode : null;
  const airline = text(b?.airline, 120) || null;
  const loyaltyProgram = text(b?.loyaltyProgram, 120) || null;
  const pnr = text(b?.pnr, 20) || null;
  const ticketNumbers = text(b?.ticketNumbers, 500) || null;
  const cashAmountCents = intOf(b?.cashAmountCents, 0, 100_000_000_00);
  const milesQuantity = intOf(b?.milesQuantity, 0, 100_000_000);
  const milesCostCents = intOf(b?.milesCostCents, 0, 100_000_000_00);
  const airportFeesCents = intOf(b?.airportFeesCents, 0, 100_000_000_00);
  const issuanceFeeCents = intOf(b?.issuanceFeeCents, 0, 100_000_000_00);
  const consolidatorFeeCents = intOf(b?.consolidatorFeeCents, 0, 100_000_000_00);
  const gatewayFeeCents = intOf(b?.gatewayFeeCents, 0, 100_000_000_00);
  const agentCommissionCents = intOf(b?.agentCommissionCents, 0, 100_000_000_00);
  const otherCostsCents = intOf(b?.otherCostsCents, 0, 100_000_000_00);
  const mileageProviderId = typeof b?.mileageProviderId === 'string' && UUID_RE.test(b.mileageProviderId) ? b.mileageProviderId : null;
  const consolidatorId = typeof b?.consolidatorId === 'string' && UUID_RE.test(b.consolidatorId) ? b.consolidatorId : null;
  const notes = text(b?.notes, 1000) || null;

  if (mileageProviderId) { const c = await env.DB.prepare('SELECT 1 FROM fin_counterparties WHERE id=? AND active=1').bind(mileageProviderId).first(); if (!c) return reply({ error: 'mileage_provider_not_found' }, 422); }
  if (consolidatorId) { const c = await env.DB.prepare('SELECT 1 FROM fin_counterparties WHERE id=? AND active=1').bind(consolidatorId).first(); if (!c) return reply({ error: 'consolidator_not_found' }, 422); }

  const result = await env.DB.prepare(
    `UPDATE fin_issuances SET
        mode=COALESCE(?,mode),
        airline=CASE WHEN ?=1 THEN ? ELSE airline END,
        loyalty_program=CASE WHEN ?=1 THEN ? ELSE loyalty_program END,
        pnr=CASE WHEN ?=1 THEN ? ELSE pnr END,
        ticket_numbers=CASE WHEN ?=1 THEN ? ELSE ticket_numbers END,
        cash_amount_cents=COALESCE(?,cash_amount_cents),
        miles_quantity=COALESCE(?,miles_quantity),
        miles_cost_cents=COALESCE(?,miles_cost_cents),
        airport_fees_cents=COALESCE(?,airport_fees_cents),
        issuance_fee_cents=COALESCE(?,issuance_fee_cents),
        consolidator_fee_cents=COALESCE(?,consolidator_fee_cents),
        gateway_fee_cents=COALESCE(?,gateway_fee_cents),
        agent_commission_cents=COALESCE(?,agent_commission_cents),
        other_costs_cents=COALESCE(?,other_costs_cents),
        mileage_provider_id=CASE WHEN ?=1 THEN ? ELSE mileage_provider_id END,
        consolidator_id=CASE WHEN ?=1 THEN ? ELSE consolidator_id END,
        notes=CASE WHEN ?=1 THEN ? ELSE notes END,
        updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND status='pending'`,
  ).bind(
    mode, has('airline') ? 1 : 0, airline, has('loyaltyProgram') ? 1 : 0, loyaltyProgram, has('pnr') ? 1 : 0, pnr,
    has('ticketNumbers') ? 1 : 0, ticketNumbers, cashAmountCents, milesQuantity, milesCostCents, airportFeesCents,
    issuanceFeeCents, consolidatorFeeCents, gatewayFeeCents, agentCommissionCents, otherCostsCents,
    has('mileageProviderId') ? 1 : 0, mileageProviderId, has('consolidatorId') ? 1 : 0, consolidatorId,
    has('notes') ? 1 : 0, notes, id,
  ).run();
  if (!result.meta.changes) return reply({ error: 'issuance_locked_after_issued' }, 409);
  await audit(env, auth.userId, 'finance.issuance_updated', 'fin_issuance', id);
  return reply({ ok: true });
}

async function financeIssuanceIssue(req: Request, env: Env, id: string) {
  const auth = await mutationAuth(req, env); if (!auth) return reply({ error: 'unauthorized' }, 401); if (!auth.roles.includes('master')) return reply({ error: 'forbidden' }, 403);
  const existing = await env.DB.prepare('SELECT status,pnr FROM fin_issuances WHERE id=?').bind(id).first<{ status: string; pnr: string | null }>();
  if (!existing) return reply({ error: 'not_found' }, 404);
  if (!isValidIssuanceTransition(existing.status, 'issued')) return reply({ error: 'invalid_transition' }, 409);
  if (!existing.pnr) return reply({ error: 'pnr_required_to_issue' }, 422);
  await env.DB.prepare("UPDATE fin_issuances SET status='issued',issued_at=CURRENT_TIMESTAMP,issued_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(auth.userId, id).run();
  await audit(env, auth.userId, 'finance.issuance_issued', 'fin_issuance', id);
  return reply({ ok: true });
}

async function financeIssuanceCancel(req: Request, env: Env, id: string) {
  const auth = await mutationAuth(req, env); if (!auth) return reply({ error: 'unauthorized' }, 401); if (!auth.roles.includes('master')) return reply({ error: 'forbidden' }, 403);
  const b = await body(req);
  const reasonValue = text(b?.reason, 500, 3);
  if (!reasonValue) return reply({ error: 'invalid_request' }, 400);
  const existing = await env.DB.prepare('SELECT status FROM fin_issuances WHERE id=?').bind(id).first<{ status: string }>();
  if (!existing) return reply({ error: 'not_found' }, 404);
  if (!isValidIssuanceTransition(existing.status, 'canceled')) return reply({ error: 'invalid_transition' }, 409);
  await env.DB.prepare("UPDATE fin_issuances SET status='canceled',terminated_at=CURRENT_TIMESTAMP,terminated_by=?,termination_reason=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(auth.userId, reasonValue, id).run();
  await audit(env, auth.userId, 'finance.issuance_canceled', 'fin_issuance', id);
  return reply({ ok: true });
}

async function financeIssuanceRefund(req: Request, env: Env, id: string) {
  const auth = await mutationAuth(req, env); if (!auth) return reply({ error: 'unauthorized' }, 401); if (!auth.roles.includes('master')) return reply({ error: 'forbidden' }, 403);
  const b = await body(req);
  const reasonValue = text(b?.reason, 500, 3);
  if (!reasonValue) return reply({ error: 'invalid_request' }, 400);
  const existing = await env.DB.prepare('SELECT status FROM fin_issuances WHERE id=?').bind(id).first<{ status: string }>();
  if (!existing) return reply({ error: 'not_found' }, 404);
  if (!isValidIssuanceTransition(existing.status, 'refunded')) return reply({ error: 'invalid_transition' }, 409);
  await env.DB.prepare("UPDATE fin_issuances SET status='refunded',terminated_at=CURRENT_TIMESTAMP,terminated_by=?,termination_reason=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(auth.userId, reasonValue, id).run();
  await audit(env, auth.userId, 'finance.issuance_refunded', 'fin_issuance', id);
  return reply({ ok: true });
}

// --- Financeiro (Fase 5 — milhas e fornecedores) ----------------------------------------------
// Mirrors src/routes/finance-mileage.ts. D1/SQLite has no interactive multi-statement transaction
// the way Postgres does (see the Fase 2/3 comment above commissionTransition for the same
// limitation already documented in this file), so allocation here is sequential awaited calls
// guarded by an application-level balance re-check immediately before the INSERT, not a real
// `SELECT ... FOR UPDATE`. This is weaker than the Node/Postgres path under true concurrency —
// exactly the gap that tests/mileage-allocation-concurrency.pg-real.test.ts exists to prove only
// for the Postgres path. A Worker-side equivalent concurrency proof is not implemented in this
// pass; treat D1 concurrent-allocation safety as unverified until a dedicated Miniflare/D1 proof
// is written (tracked as a known gap in docs/financeiro/PLANO_IMPLEMENTACAO.md).
function todayIso() { return new Date().toISOString().slice(0, 10); }

function serializeFinMileageLot(row: Row, allocatedQuantity: number) {
  const quantityPurchased = Number(row.quantity_purchased);
  const isExpired = Boolean(row.expires_at) && String(row.expires_at) < todayIso();
  return {
    id: row.id, counterpartyId: row.counterparty_id, program: row.program, quantityPurchased,
    totalCostCents: row.total_cost_cents, currency: row.currency, unitCostMicros: row.unit_cost_micros,
    purchasedAt: row.purchased_at, expiresAt: row.expires_at, status: row.status, isExpired,
    obligationId: row.obligation_id, notes: row.notes, balanceQuantity: quantityPurchased - allocatedQuantity,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
function serializeFinMileageAllocation(row: Row) {
  return {
    id: row.id, lotId: row.lot_id, issuanceId: row.issuance_id, quantity: row.quantity,
    costCentsSnapshot: row.cost_cents_snapshot, voidedAt: row.voided_at, voidedBy: row.voided_by,
    voidReason: row.void_reason, createdAt: row.created_at,
  };
}
async function financeAllocatedQuantityByLot(env: Env): Promise<Map<string, number>> {
  const rows = await env.DB.prepare('SELECT lot_id,quantity FROM fin_mileage_allocations WHERE voided_at IS NULL').all<Row>();
  const totals = new Map<string, number>();
  for (const row of rows.results) { const key = String(row.lot_id); totals.set(key, (totals.get(key) ?? 0) + Number(row.quantity)); }
  return totals;
}
async function financeRecomputeIssuanceMiles(env: Env, issuanceId: string) {
  const totals = await env.DB.prepare("SELECT COALESCE(sum(quantity),0) qty,COALESCE(sum(cost_cents_snapshot),0) cost FROM fin_mileage_allocations WHERE issuance_id=? AND voided_at IS NULL").bind(issuanceId).first<{ qty: number; cost: number }>();
  await env.DB.prepare('UPDATE fin_issuances SET miles_quantity=?,miles_cost_cents=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(totals?.qty ?? 0, totals?.cost ?? 0, issuanceId).run();
}

async function financeMileageLots(req: Request, env: Env, url: URL) {
  if (!(await requireMaster(req, env))) return reply({ error: 'forbidden' }, 403);
  const counterpartyId = url.searchParams.get('counterpartyId');
  const program = url.searchParams.get('program');
  const status = url.searchParams.get('status');
  const currency = url.searchParams.get('currency');
  if (counterpartyId && !UUID_RE.test(counterpartyId)) return reply({ error: 'invalid_filter' }, 400);
  const rows = await env.DB.prepare(
    `SELECT id,counterparty_id,program,quantity_purchased,total_cost_cents,currency,unit_cost_micros,purchased_at,expires_at,status,obligation_id,notes,created_at,updated_at
       FROM fin_mileage_lots
      WHERE (?1 IS NULL OR counterparty_id=?1) AND (?2 IS NULL OR program=?2) AND (?3 IS NULL OR status=?3) AND (?4 IS NULL OR currency=?4)
      ORDER BY purchased_at DESC,created_at DESC LIMIT 500`,
  ).bind(counterpartyId, program, status, currency).all<Row>();
  const allocated = await financeAllocatedQuantityByLot(env);
  return reply({ mileageLots: rows.results.map((row) => serializeFinMileageLot(row, allocated.get(String(row.id)) ?? 0)) });
}

async function financeMileageLotDetail(req: Request, env: Env, id: string) {
  if (!(await requireMaster(req, env))) return reply({ error: 'forbidden' }, 403);
  const row = await env.DB.prepare('SELECT id,counterparty_id,program,quantity_purchased,total_cost_cents,currency,unit_cost_micros,purchased_at,expires_at,status,obligation_id,notes,created_at,updated_at FROM fin_mileage_lots WHERE id=?').bind(id).first<Row>();
  if (!row) return reply({ error: 'not_found' }, 404);
  const allocations = await env.DB.prepare('SELECT id,lot_id,issuance_id,quantity,cost_cents_snapshot,voided_at,voided_by,void_reason,created_at FROM fin_mileage_allocations WHERE lot_id=? ORDER BY created_at').bind(id).all<Row>();
  const allocatedQuantity = allocations.results.filter((allocation) => !allocation.voided_at).reduce((sum, allocation) => sum + Number(allocation.quantity), 0);
  return reply({ mileageLot: serializeFinMileageLot(row, allocatedQuantity), allocations: allocations.results.map(serializeFinMileageAllocation) });
}

async function financeMileageLotCreate(req: Request, env: Env) {
  const auth = await mutationAuth(req, env); if (!auth) return reply({ error: 'unauthorized' }, 401); if (!auth.roles.includes('master')) return reply({ error: 'forbidden' }, 403);
  const b = await body(req);
  const counterpartyId = typeof b?.counterpartyId === 'string' && UUID_RE.test(b.counterpartyId) ? b.counterpartyId : null;
  const program = text(b?.program, 120, 2);
  const quantityPurchased = intOf(b?.quantityPurchased, 1, 100_000_000);
  const totalCostCents = intOf(b?.totalCostCents, 1, 100_000_000_00);
  const currency = typeof b?.currency === 'string' && b.currency.length === 3 ? b.currency.toUpperCase() : null;
  const purchasedAt = dateOf(b?.purchasedAt);
  const expiresAt = typeof b?.expiresAt === 'string' ? dateOf(b.expiresAt) : null;
  const categoryId = typeof b?.categoryId === 'string' && UUID_RE.test(b.categoryId) ? b.categoryId : null;
  const dueDate = dateOf(b?.dueDate);
  const accountId = typeof b?.accountId === 'string' && UUID_RE.test(b.accountId) ? b.accountId : null;
  const costCenterIdInput = typeof b?.costCenterId === 'string' && UUID_RE.test(b.costCenterId) ? b.costCenterId : null;
  const notes = text(b?.notes, 1000) || null;
  if (!counterpartyId || !program || !quantityPurchased || !totalCostCents || !currency || !validCurrency(currency) || !purchasedAt || !categoryId || !dueDate) {
    return reply({ error: 'invalid_mileage_lot' }, 400);
  }

  const counterparty = await env.DB.prepare('SELECT 1 FROM fin_counterparties WHERE id=? AND active=1').bind(counterpartyId).first();
  if (!counterparty) return reply({ error: 'counterparty_not_found' }, 422);
  const category = await env.DB.prepare('SELECT kind,default_cost_center_id FROM fin_categories WHERE id=? AND active=1').bind(categoryId).first<{ kind: string; default_cost_center_id: string | null }>();
  if (!category) return reply({ error: 'category_not_found' }, 422);
  if (category.kind !== 'direct_cost') return reply({ error: 'category_must_be_direct_cost' }, 422);
  if (accountId) { const account = await env.DB.prepare('SELECT 1 FROM fin_accounts WHERE id=? AND active=1').bind(accountId).first(); if (!account) return reply({ error: 'account_not_found' }, 422); }
  const costCenterId = costCenterIdInput ?? category.default_cost_center_id ?? null;
  if (costCenterIdInput) { const costCenter = await env.DB.prepare('SELECT 1 FROM fin_cost_centers WHERE id=?').bind(costCenterIdInput).first(); if (!costCenter) return reply({ error: 'cost_center_not_found' }, 422); }

  const lotId = crypto.randomUUID();
  const obligationId = crypto.randomUUID();
  const unitCost = unitCostMicros(totalCostCents, quantityPurchased);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO fin_obligations (id,kind,counterparty_id,category_id,cost_center_id,competency_date,due_date,amount_cents,currency,account_id,notes,created_by)
       VALUES (?,'direct_cost',?,?,?,?,?,?,?,?,?,?)`,
    ).bind(obligationId, counterpartyId, categoryId, costCenterId, purchasedAt, dueDate, totalCostCents, currency, accountId, `Compra de lote de milhas: ${program}`, auth.userId),
    env.DB.prepare(
      `INSERT INTO fin_mileage_lots (id,counterparty_id,program,quantity_purchased,total_cost_cents,currency,unit_cost_micros,purchased_at,expires_at,obligation_id,notes,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(lotId, counterpartyId, program, quantityPurchased, totalCostCents, currency, unitCost, purchasedAt, expiresAt, obligationId, notes, auth.userId),
  ]);
  await audit(env, auth.userId, 'finance.mileage_lot_created', 'fin_mileage_lot', lotId);
  return reply({ id: lotId, obligationId }, 201);
}

async function financeMileageLotCancel(req: Request, env: Env, id: string) {
  const auth = await mutationAuth(req, env); if (!auth) return reply({ error: 'unauthorized' }, 401); if (!auth.roles.includes('master')) return reply({ error: 'forbidden' }, 403);
  const b = await body(req);
  const reasonValue = text(b?.reason, 500, 3);
  if (!reasonValue) return reply({ error: 'invalid_request' }, 400);
  const lot = await env.DB.prepare('SELECT status FROM fin_mileage_lots WHERE id=?').bind(id).first<{ status: string }>();
  if (!lot) return reply({ error: 'not_found' }, 404);
  if (lot.status === 'canceled') return reply({ error: 'mileage_lot_already_canceled' }, 409);
  const active = await env.DB.prepare('SELECT 1 FROM fin_mileage_allocations WHERE lot_id=? AND voided_at IS NULL LIMIT 1').bind(id).first();
  if (active) return reply({ error: 'mileage_lot_has_active_allocations' }, 409);
  await env.DB.prepare("UPDATE fin_mileage_lots SET status='canceled',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(id).run();
  await audit(env, auth.userId, 'finance.mileage_lot_canceled', 'fin_mileage_lot', id);
  return reply({ ok: true });
}

async function financeMileageAllocations(req: Request, env: Env, issuanceId: string) {
  if (!(await requireMaster(req, env))) return reply({ error: 'forbidden' }, 403);
  const rows = await env.DB.prepare('SELECT id,lot_id,issuance_id,quantity,cost_cents_snapshot,voided_at,voided_by,void_reason,created_at FROM fin_mileage_allocations WHERE issuance_id=? ORDER BY created_at').bind(issuanceId).all<Row>();
  return reply({ allocations: rows.results.map(serializeFinMileageAllocation) });
}

async function financeMileageAllocationCreate(req: Request, env: Env, issuanceId: string) {
  const auth = await mutationAuth(req, env); if (!auth) return reply({ error: 'unauthorized' }, 401); if (!auth.roles.includes('master')) return reply({ error: 'forbidden' }, 403);
  const b = await body(req);
  const lotId = typeof b?.lotId === 'string' && UUID_RE.test(b.lotId) ? b.lotId : null;
  const quantity = intOf(b?.quantity, 1, 100_000_000);
  if (!lotId || !quantity) return reply({ error: 'invalid_allocation' }, 400);

  const issuance = await env.DB.prepare('SELECT status,mode,currency FROM fin_issuances WHERE id=?').bind(issuanceId).first<{ status: string; mode: string; currency: string }>();
  if (!issuance) return reply({ error: 'issuance_not_found' }, 404);
  if (issuance.status !== 'pending') return reply({ error: 'issuance_locked_after_issued' }, 409);
  if (issuance.mode !== 'miles' && issuance.mode !== 'hybrid') return reply({ error: 'issuance_mode_does_not_use_miles' }, 422);

  const lot = await env.DB.prepare('SELECT status,currency,quantity_purchased,total_cost_cents,expires_at FROM fin_mileage_lots WHERE id=?').bind(lotId).first<{ status: string; currency: string; quantity_purchased: number; total_cost_cents: number; expires_at: string | null }>();
  if (!lot) return reply({ error: 'mileage_lot_not_found' }, 404);
  if (lot.status !== 'active' && lot.status !== 'depleted') return reply({ error: 'mileage_lot_not_active' }, 409);
  if (lot.expires_at && lot.expires_at < todayIso()) return reply({ error: 'mileage_lot_expired' }, 409);
  if (lot.currency !== issuance.currency) return reply({ error: 'mileage_lot_currency_must_match_issuance' }, 422);

  const allocatedTotal = await env.DB.prepare('SELECT COALESCE(sum(quantity),0) n FROM fin_mileage_allocations WHERE lot_id=? AND voided_at IS NULL').bind(lotId).first<{ n: number }>();
  const remaining = lot.quantity_purchased - (allocatedTotal?.n ?? 0);
  if (quantity > remaining) return reply({ error: 'insufficient_mileage_balance' }, 409);

  const costCentsSnapshot = allocationCostCents(lot.total_cost_cents, lot.quantity_purchased, quantity);
  const allocationId = crypto.randomUUID();
  // D1 não oferece SELECT ... FOR UPDATE nem transação interativa, então a checagem de saldo
  // acima é só uma pré-validação (mensagem de erro rápida) — não é o que garante a ausência de
  // saldo negativo. A garantia real vem daqui: um único INSERT ... SELECT ... WHERE, que o
  // SQLite/D1 executa como uma instrução atômica só. Duas requisições concorrentes (ex.: duas
  // abas) nunca podem as duas "ver" o mesmo saldo disponível e as duas inserirem — a segunda a
  // chegar já vê o efeito da primeira dentro desta mesma instrução, porque a subquery de saldo
  // roda como parte do INSERT, não como uma leitura separada e anterior a ele.
  const insertResult = await env.DB.prepare(
    `INSERT INTO fin_mileage_allocations (id,lot_id,issuance_id,quantity,cost_cents_snapshot,created_by)
     SELECT ?,?,?,?,?,?
      WHERE (SELECT quantity_purchased FROM fin_mileage_lots WHERE id = ?)
          - (SELECT COALESCE(sum(quantity),0) FROM fin_mileage_allocations WHERE lot_id = ? AND voided_at IS NULL)
         >= ?`,
  ).bind(allocationId, lotId, issuanceId, quantity, costCentsSnapshot, auth.userId, lotId, lotId, quantity).run();
  if (insertResult.meta.changes === 0) return reply({ error: 'insufficient_mileage_balance' }, 409);

  const freshAllocatedTotal = await env.DB.prepare('SELECT COALESCE(sum(quantity),0) n FROM fin_mileage_allocations WHERE lot_id=? AND voided_at IS NULL').bind(lotId).first<{ n: number }>();
  const newRemaining = lot.quantity_purchased - (freshAllocatedTotal?.n ?? 0);
  await env.DB.prepare('UPDATE fin_mileage_lots SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(newRemaining === 0 ? 'depleted' : 'active', lotId).run();
  await financeRecomputeIssuanceMiles(env, issuanceId);
  await audit(env, auth.userId, 'finance.mileage_allocation_created', 'fin_mileage_allocation', allocationId);
  return reply({ id: allocationId }, 201);
}

async function financeMileageAllocationVoid(req: Request, env: Env, id: string) {
  const auth = await mutationAuth(req, env); if (!auth) return reply({ error: 'unauthorized' }, 401); if (!auth.roles.includes('master')) return reply({ error: 'forbidden' }, 403);
  const b = await body(req);
  const reasonValue = text(b?.reason, 500, 3);
  if (!reasonValue) return reply({ error: 'invalid_request' }, 400);
  const allocation = await env.DB.prepare('SELECT lot_id,issuance_id,voided_at FROM fin_mileage_allocations WHERE id=?').bind(id).first<{ lot_id: string; issuance_id: string; voided_at: string | null }>();
  if (!allocation) return reply({ error: 'not_found' }, 404);
  if (allocation.voided_at) return reply({ error: 'allocation_already_voided' }, 409);
  const issuance = await env.DB.prepare('SELECT status FROM fin_issuances WHERE id=?').bind(allocation.issuance_id).first<{ status: string }>();
  if (issuance?.status !== 'pending') return reply({ error: 'issuance_locked_after_issued' }, 409);

  await env.DB.prepare('UPDATE fin_mileage_allocations SET voided_at=CURRENT_TIMESTAMP,voided_by=?,void_reason=? WHERE id=?').bind(auth.userId, reasonValue, id).run();
  await env.DB.prepare("UPDATE fin_mileage_lots SET status='active',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='depleted'").bind(allocation.lot_id).run();
  await financeRecomputeIssuanceMiles(env, allocation.issuance_id);
  await audit(env, auth.userId, 'finance.mileage_allocation_voided', 'fin_mileage_allocation', id);
  return reply({ ok: true });
}

// --- Financeiro (Fase 6 — dashboard e relatórios) --------------------------------------------
// Mirrors src/routes/finance-dashboard.ts. All read-only (GET), so only requireMaster — no CSRF.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function financeSumIssuanceDirectCostCents(row: Row): number {
  return Number(row.cash_amount_cents) + Number(row.miles_cost_cents) + Number(row.airport_fees_cents) + Number(row.issuance_fee_cents)
    + Number(row.consolidator_fee_cents) + Number(row.gateway_fee_cents) + Number(row.agent_commission_cents) + Number(row.other_costs_cents);
}
function financeSumByCurrency(rows: Row[], amountKey: string): Map<string, number> {
  const totals = new Map<string, number>();
  for (const row of rows) { const currency = String(row.currency); totals.set(currency, (totals.get(currency) ?? 0) + Number(row[amountKey])); }
  return totals;
}

async function financeDashboardOverview(req: Request, env: Env, url: URL) {
  if (!(await requireMaster(req, env))) return reply({ error: 'forbidden' }, 403);
  const from = url.searchParams.get('from'); const to = url.searchParams.get('to');
  const regime = url.searchParams.get('regime') === 'cash' ? 'cash' : 'accrual';
  if (!from || !DATE_RE.test(from) || !to || !DATE_RE.test(to)) return reply({ error: 'invalid_filter' }, 400);
  if (from > to) return reply({ error: 'invalid_date_range' }, 400);

  if (regime === 'accrual') {
    const salesRows = await env.DB.prepare("SELECT currency,net_amount_cents amount FROM fin_sales WHERE status='confirmed' AND sale_date BETWEEN ? AND ?").bind(from, to).all<Row>();
    const faturamento = financeSumByCurrency(salesRows.results, 'amount');
    const expenseRows = await env.DB.prepare("SELECT currency,amount_cents amount FROM fin_obligations WHERE kind='operating_expense' AND status<>'canceled' AND competency_date BETWEEN ? AND ?").bind(from, to).all<Row>();
    const despesas = financeSumByCurrency(expenseRows.results, 'amount');
    const issuanceRows = await env.DB.prepare(
      `SELECT fi.currency,fi.cash_amount_cents,fi.miles_cost_cents,fi.airport_fees_cents,fi.issuance_fee_cents,fi.consolidator_fee_cents,fi.gateway_fee_cents,fi.agent_commission_cents,fi.other_costs_cents
         FROM fin_issuances fi JOIN fin_sales fs ON fs.id=fi.sale_id
        WHERE fs.status='confirmed' AND fs.sale_date BETWEEN ? AND ? AND fi.status IN ('issued','refunded')`,
    ).bind(from, to).all<Row>();
    const custoDireto = new Map<string, number>();
    for (const row of issuanceRows.results) { const currency = String(row.currency); custoDireto.set(currency, (custoDireto.get(currency) ?? 0) + financeSumIssuanceDirectCostCents(row)); }
    const currencies = new Set([...faturamento.keys(), ...custoDireto.keys(), ...despesas.keys()]);
    const indicators = [...currencies].sort().map((currency) => {
      const faturamentoBrutoCents = faturamento.get(currency) ?? 0;
      const custoDiretoCents = custoDireto.get(currency) ?? 0;
      const despesasOperacionaisCents = despesas.get(currency) ?? 0;
      const lucroBrutoCents = faturamentoBrutoCents - custoDiretoCents;
      const margemBrutaBps = faturamentoBrutoCents > 0 ? Math.round((lucroBrutoCents * 10_000) / faturamentoBrutoCents) : null;
      return { currency, faturamentoBrutoCents, custoDiretoCents, lucroBrutoCents, margemBrutaBps, despesasOperacionaisCents, resultadoOperacionalCents: lucroBrutoCents - despesasOperacionaisCents };
    });
    return reply({ regime: 'accrual', from, to, indicators });
  }

  const receivedRows = await env.DB.prepare("SELECT currency,received_amount_cents amount FROM fin_receivable_payments WHERE substr(received_at,1,10) BETWEEN ? AND ?").bind(from, to).all<Row>();
  const recebido = financeSumByCurrency(receivedRows.results, 'amount');
  const paidRows = await env.DB.prepare("SELECT currency,paid_amount_cents amount FROM fin_obligation_payments WHERE substr(paid_at,1,10) BETWEEN ? AND ?").bind(from, to).all<Row>();
  const pago = financeSumByCurrency(paidRows.results, 'amount');
  const currencies = new Set([...recebido.keys(), ...pago.keys()]);
  const indicators = [...currencies].sort().map((currency) => {
    const recebidoCents = recebido.get(currency) ?? 0; const pagoCents = pago.get(currency) ?? 0;
    return { currency, recebidoCents, pagoCents, saldoCaixaCents: recebidoCents - pagoCents };
  });
  return reply({ regime: 'cash', from, to, indicators });
}

async function financeDashboardAlerts(req: Request, env: Env, url: URL) {
  if (!(await requireMaster(req, env))) return reply({ error: 'forbidden' }, 403);
  const minMarginBps = intOf(url.searchParams.get('minMarginBps'), -10_000, 10_000) ?? 0;
  const lowBalanceThreshold = intOf(url.searchParams.get('lowBalanceThreshold'), 0, 100_000_000) ?? 1000;
  const expiringDays = intOf(url.searchParams.get('expiringDays'), 1, 365) ?? 30;

  const overdueObligations = await env.DB.prepare("SELECT id,due_date,amount_cents,currency,counterparty_id FROM fin_obligations WHERE status IN ('open','partial') AND due_date < date('now') ORDER BY due_date LIMIT 200").all<Row>();
  const overdueReceivables = await env.DB.prepare("SELECT id,sale_id,due_date,expected_amount_cents,currency FROM fin_receivables WHERE status IN ('open','partial') AND due_date < date('now') ORDER BY due_date LIMIT 200").all<Row>();
  const upcoming7d = await env.DB.prepare("SELECT id,due_date,amount_cents,currency,counterparty_id FROM fin_obligations WHERE status IN ('open','partial') AND due_date BETWEEN date('now') AND date('now','+7 days') ORDER BY due_date LIMIT 200").all<Row>();
  const upcoming30d = await env.DB.prepare("SELECT id,due_date,amount_cents,currency,counterparty_id FROM fin_obligations WHERE status IN ('open','partial') AND due_date BETWEEN date('now') AND date('now','+30 days') ORDER BY due_date LIMIT 200").all<Row>();
  const activeSubscriptions = await env.DB.prepare("SELECT id,service,next_charge_at,notice_days,amount_cents,currency FROM fin_subscriptions WHERE status='active'").all<Row>();
  const today = new Date().toISOString().slice(0, 10);
  const subscriptionsDueSoon = activeSubscriptions.results.filter((row) => {
    const daysUntil = Math.floor((Date.parse(`${row.next_charge_at}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
    return daysUntil <= Number(row.notice_days);
  }).map((row) => ({ id: row.id, service: row.service, nextChargeAt: row.next_charge_at, amountCents: row.amount_cents, currency: row.currency }));

  const saleIssuanceRows = await env.DB.prepare(
    `SELECT fs.id sale_id,fs.protocol,fs.net_amount_cents,fs.currency,
            fi.cash_amount_cents,fi.miles_cost_cents,fi.airport_fees_cents,fi.issuance_fee_cents,fi.consolidator_fee_cents,fi.gateway_fee_cents,fi.agent_commission_cents,fi.other_costs_cents
       FROM fin_sales fs JOIN fin_issuances fi ON fi.sale_id=fs.id
      WHERE fs.status='confirmed' AND fi.status IN ('issued','refunded')`,
  ).all<Row>();
  const costBySale = new Map<string, { protocol: string; netAmountCents: number; currency: string; costCents: number }>();
  for (const row of saleIssuanceRows.results) {
    const saleId = String(row.sale_id);
    const entry = costBySale.get(saleId) ?? { protocol: String(row.protocol), netAmountCents: Number(row.net_amount_cents), currency: String(row.currency), costCents: 0 };
    entry.costCents += financeSumIssuanceDirectCostCents(row);
    costBySale.set(saleId, entry);
  }
  const salesBelowMarginThreshold = [...costBySale.entries()]
    .map(([saleId, entry]) => ({ saleId, protocol: entry.protocol, currency: entry.currency, marginBps: entry.netAmountCents > 0 ? Math.round(((entry.netAmountCents - entry.costCents) * 10_000) / entry.netAmountCents) : null }))
    .filter((item) => item.marginBps !== null && item.marginBps < minMarginBps);

  const mileageLots = await env.DB.prepare("SELECT id,program,quantity_purchased,expires_at FROM fin_mileage_lots WHERE status IN ('active','depleted')").all<Row>();
  const allocatedRows = await env.DB.prepare('SELECT lot_id,quantity FROM fin_mileage_allocations WHERE voided_at IS NULL').all<Row>();
  const allocatedByLot = new Map<string, number>();
  for (const row of allocatedRows.results) { const key = String(row.lot_id); allocatedByLot.set(key, (allocatedByLot.get(key) ?? 0) + Number(row.quantity)); }
  const mileageLotsLowBalance: Array<{ id: unknown; program: unknown; balanceQuantity: number }> = [];
  const mileageLotsExpiringSoon: Array<{ id: unknown; program: unknown; expiresAt: unknown }> = [];
  for (const row of mileageLots.results) {
    const balance = Number(row.quantity_purchased) - (allocatedByLot.get(String(row.id)) ?? 0);
    if (balance <= lowBalanceThreshold) mileageLotsLowBalance.push({ id: row.id, program: row.program, balanceQuantity: balance });
    if (row.expires_at) {
      const daysUntil = Math.floor((Date.parse(`${row.expires_at}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
      if (daysUntil >= 0 && daysUntil <= expiringDays) mileageLotsExpiringSoon.push({ id: row.id, program: row.program, expiresAt: row.expires_at });
    }
  }

  return reply({
    overdueObligations: overdueObligations.results.map((row) => ({ id: row.id, dueDate: row.due_date, amountCents: row.amount_cents, currency: row.currency, counterpartyId: row.counterparty_id })),
    overdueReceivables: overdueReceivables.results.map((row) => ({ id: row.id, saleId: row.sale_id, dueDate: row.due_date, expectedAmountCents: row.expected_amount_cents, currency: row.currency })),
    upcomingObligations7d: upcoming7d.results.map((row) => ({ id: row.id, dueDate: row.due_date, amountCents: row.amount_cents, currency: row.currency, counterpartyId: row.counterparty_id })),
    upcomingObligations30d: upcoming30d.results.map((row) => ({ id: row.id, dueDate: row.due_date, amountCents: row.amount_cents, currency: row.currency, counterpartyId: row.counterparty_id })),
    subscriptionsDueSoon, salesBelowMarginThreshold, mileageLotsLowBalance, mileageLotsExpiringSoon,
  });
}

async function financeDashboardExpensesByCategory(req: Request, env: Env, url: URL) {
  if (!(await requireMaster(req, env))) return reply({ error: 'forbidden' }, 403);
  const from = url.searchParams.get('from'); const to = url.searchParams.get('to');
  const regime = url.searchParams.get('regime') === 'cash' ? 'cash' : 'accrual';
  if (!from || !DATE_RE.test(from) || !to || !DATE_RE.test(to)) return reply({ error: 'invalid_filter' }, 400);
  if (from > to) return reply({ error: 'invalid_date_range' }, 400);

  const rows = regime === 'accrual'
    ? await env.DB.prepare("SELECT category_id,currency,amount_cents amount FROM fin_obligations WHERE status<>'canceled' AND competency_date BETWEEN ? AND ?").bind(from, to).all<Row>()
    : await env.DB.prepare("SELECT o.category_id category_id,p.currency currency,p.paid_amount_cents amount FROM fin_obligation_payments p JOIN fin_obligations o ON o.id=p.obligation_id WHERE substr(p.paid_at,1,10) BETWEEN ? AND ?").bind(from, to).all<Row>();
  const categories = await env.DB.prepare('SELECT id,name,kind FROM fin_categories').all<Row>();
  const categoryById = new Map(categories.results.map((row) => [String(row.id), row]));
  const totals = new Map<string, { categoryId: string; categoryName: string; kind: string; currency: string; amountCents: number }>();
  for (const row of rows.results) {
    const key = `${row.category_id}|${row.currency}`;
    const category = categoryById.get(String(row.category_id));
    const entry = totals.get(key) ?? { categoryId: String(row.category_id), categoryName: category ? String(category.name) : '(categoria removida)', kind: category ? String(category.kind) : 'unknown', currency: String(row.currency), amountCents: 0 };
    entry.amountCents += Number(row.amount);
    totals.set(key, entry);
  }
  return reply({ regime, from, to, categories: [...totals.values()].sort((a, b) => b.amountCents - a.amountCents) });
}

async function financeDashboardExportCsv(req: Request, env: Env, url: URL) {
  if (!(await requireMaster(req, env))) return reply({ error: 'forbidden' }, 403);
  const report = url.searchParams.get('report');
  const from = url.searchParams.get('from'); const to = url.searchParams.get('to');
  if (!report || !['sales', 'obligations', 'receivables'].includes(report)) return reply({ error: 'invalid_filter' }, 400);
  if (!from || !DATE_RE.test(from) || !to || !DATE_RE.test(to)) return reply({ error: 'invalid_filter' }, 400);
  if (from > to) return reply({ error: 'invalid_date_range' }, 400);
  const maxRows = 5000;

  let csv: string;
  if (report === 'sales') {
    const rows = await env.DB.prepare('SELECT protocol,sale_date,currency,gross_amount_cents,discount_cents,net_amount_cents,status FROM fin_sales WHERE sale_date BETWEEN ? AND ? ORDER BY sale_date LIMIT ?').bind(from, to, maxRows).all<Row>();
    csv = buildCsv(['Protocolo', 'Data', 'Moeda', 'Valor bruto (centavos)', 'Desconto (centavos)', 'Valor líquido (centavos)', 'Status'],
      rows.results.map((row) => [String(row.protocol), String(row.sale_date), String(row.currency), Number(row.gross_amount_cents), Number(row.discount_cents), Number(row.net_amount_cents), String(row.status)]));
  } else if (report === 'obligations') {
    const rows = await env.DB.prepare(
      `SELECT o.due_date due_date,o.currency currency,o.amount_cents amount_cents,o.status status,o.kind kind,cp.display_name counterparty_name,cat.name category_name
         FROM fin_obligations o LEFT JOIN fin_counterparties cp ON cp.id=o.counterparty_id LEFT JOIN fin_categories cat ON cat.id=o.category_id
        WHERE o.due_date BETWEEN ? AND ? ORDER BY o.due_date LIMIT ?`,
    ).bind(from, to, maxRows).all<Row>();
    csv = buildCsv(['Vencimento', 'Tipo', 'Categoria', 'Contraparte', 'Moeda', 'Valor (centavos)', 'Status'],
      rows.results.map((row) => [String(row.due_date), String(row.kind), row.category_name ? String(row.category_name) : '', row.counterparty_name ? String(row.counterparty_name) : '', String(row.currency), Number(row.amount_cents), String(row.status)]));
  } else {
    const rows = await env.DB.prepare(
      `SELECT r.due_date due_date,r.currency currency,r.expected_amount_cents expected_amount_cents,r.status status,s.protocol protocol
         FROM fin_receivables r JOIN fin_sales s ON s.id=r.sale_id
        WHERE r.due_date BETWEEN ? AND ? ORDER BY r.due_date LIMIT ?`,
    ).bind(from, to, maxRows).all<Row>();
    csv = buildCsv(['Protocolo da venda', 'Vencimento', 'Moeda', 'Valor esperado (centavos)', 'Status'],
      rows.results.map((row) => [String(row.protocol), String(row.due_date), String(row.currency), Number(row.expected_amount_cents), String(row.status)]));
  }
  return new Response(csv, { headers: { ...jsonHeaders, 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${report}-${from}-a-${to}.csv"` } });
}
