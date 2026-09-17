import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Database } from '../db.js';
import { audit, requireAuth, requireMutationAuth, type AuthContext } from '../auth.js';

const idSchema = z.string().uuid();
const tripSchema = z.object({
  name: z.string().trim().min(1).max(120),
  destination: z.string().trim().max(180).optional(),
  startsOn: z.string().date().optional(),
  endsOn: z.string().date().optional(),
  travelers: z.number().int().min(1).max(100).default(1),
});
const itinerarySchema = z.object({ day: z.number().int().min(1).max(365), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(), title: z.string().trim().min(1).max(240), kind: z.string().trim().min(1).max(60), notes: z.string().trim().max(2000).optional() });
const placeSchema = z.object({ name: z.string().trim().min(1).max(240), category: z.string().trim().min(1).max(60), address: z.string().trim().max(500).optional(), notes: z.string().trim().max(2000).optional() });
const expenseSchema = z.object({ amount: z.number().positive().max(10_000_000), category: z.string().trim().min(1).max(60), description: z.string().trim().min(1).max(500) });
const checklistSchema = z.object({ text: z.string().trim().min(1).max(300) });
const importSchema = z.object({
  budget: z.number().min(0).max(10_000_000).default(0),
  itinerary: z.array(z.object({ day: z.coerce.number().int().min(1).max(365), time: z.string().max(10).optional().default(''), what: z.string().trim().min(1).max(240), type: z.string().trim().max(60).default('Atividade'), notes: z.string().trim().max(2000).optional().default('') })).max(1000),
  places: z.array(z.object({ name: z.string().trim().min(1).max(240), type: z.string().trim().max(60).default('Outro'), address: z.string().trim().max(500).optional().default(''), notes: z.string().trim().max(2000).optional().default('') })).max(1000),
  expenses: z.array(z.object({ value: z.coerce.number().positive().max(10_000_000), type: z.string().trim().max(60).default('Outros'), desc: z.string().trim().min(1).max(500) })).max(1000),
  checklist: z.array(z.object({ text: z.string().trim().min(1).max(300), done: z.boolean().default(false) })).max(1000),
});

export function registerPlannerRoutes(app: FastifyInstance, db: Database, config: AppConfig) {
  app.get('/api/planner', async (request, reply) => {
    const auth = await requireAuth(db, config, request, reply);
    if (!auth || !(await requireAccess(db, auth, reply))) return;
    const query = z.object({ tripId: z.string().uuid().optional() }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_trip' });
    const trip = await ownedTrip(db, auth.userId, query.data.tripId);
    if (!trip) return reply.code(404).send({ error: 'trip_not_found' });
    const [itinerary, places, expenses, budget, checklist] = await Promise.all([
      db.query<{ id: string; day: number; time: string | null; title: string; kind: string; notes: string | null }>('SELECT id,day_number AS day,starts_at AS time,title,kind,notes FROM itinerary_items WHERE owner_user_id=$1 AND trip_id=$2 ORDER BY day_number,sort_order,starts_at', [auth.userId, trip.id]),
      db.query('SELECT id,name,category,address,notes,latitude,longitude FROM places WHERE owner_user_id=$1 AND trip_id=$2 ORDER BY created_at', [auth.userId, trip.id]),
      db.query('SELECT id,category,description,amount_cents,currency,spent_on FROM expenses WHERE owner_user_id=$1 AND trip_id=$2 ORDER BY created_at DESC', [auth.userId, trip.id]),
      db.query('SELECT amount_cents,currency FROM budgets WHERE owner_user_id=$1 AND trip_id=$2', [auth.userId, trip.id]),
      db.query('SELECT id,text,completed,sort_order FROM checklist_items WHERE owner_user_id=$1 AND trip_id=$2 ORDER BY sort_order,created_at', [auth.userId, trip.id]),
    ]);
    const normalizedItinerary = itinerary.rows.map((item) => ({ ...item, time: typeof item.time === 'string' ? item.time.slice(0, 5) : item.time }));
    return reply.send({ trip, itinerary: normalizedItinerary, places: places.rows, expenses: expenses.rows, budget: budget.rows[0] ?? { amount_cents: 0, currency: 'EUR' }, checklist: checklist.rows });
  });

  app.post('/api/planner/trips', async (request, reply) => {
    const auth = await requireMutationAuth(db, config, request, reply);
    if (!auth || !(await requireAccess(db, auth, reply))) return;
    const parsed = tripSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_trip' });
    const id = randomUUID();
    await db.transaction(async (tx) => {
      await tx.query('INSERT INTO trips (id,owner_user_id,name,destination,starts_on,ends_on,travelers) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, auth.userId, parsed.data.name, parsed.data.destination ?? null, parsed.data.startsOn ?? null, parsed.data.endsOn ?? null, parsed.data.travelers]);
      await tx.query("INSERT INTO budgets (trip_id,owner_user_id,amount_cents,currency) VALUES ($1,$2,0,'EUR')", [id, auth.userId]);
    });
    await audit(db, config, request, 'planner.trip_created', auth.userId, 'trip', id);
    return reply.code(201).send({ id });
  });

  app.post('/api/planner/:tripId/itinerary', async (request, reply) => {
    const context = await mutationTrip(db, config, request, reply);
    if (!context) return;
    const parsed = itinerarySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_itinerary_item' });
    const id = randomUUID();
    await db.query('INSERT INTO itinerary_items (id,trip_id,owner_user_id,day_number,starts_at,title,kind,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [id, context.tripId, context.auth.userId, parsed.data.day, parsed.data.time ?? null, parsed.data.title, parsed.data.kind, parsed.data.notes ?? null]);
    return reply.code(201).send({ id });
  });

  app.delete('/api/planner/:tripId/itinerary/:id', async (request, reply) => deleteOwned(db, config, request, reply, 'itinerary_items'));

  app.post('/api/planner/:tripId/places', async (request, reply) => {
    const context = await mutationTrip(db, config, request, reply);
    if (!context) return;
    const parsed = placeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_place' });
    const id = randomUUID();
    await db.query('INSERT INTO places (id,trip_id,owner_user_id,name,category,address,notes) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, context.tripId, context.auth.userId, parsed.data.name, parsed.data.category, parsed.data.address ?? null, parsed.data.notes ?? null]);
    return reply.code(201).send({ id });
  });

  app.delete('/api/planner/:tripId/places/:id', async (request, reply) => deleteOwned(db, config, request, reply, 'places'));

  app.put('/api/planner/:tripId/budget', async (request, reply) => {
    const context = await mutationTrip(db, config, request, reply);
    if (!context) return;
    const parsed = z.object({ amount: z.number().min(0).max(10_000_000) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_budget' });
    await db.query('UPDATE budgets SET amount_cents=$1,updated_at=now() WHERE trip_id=$2 AND owner_user_id=$3', [Math.round(parsed.data.amount * 100), context.tripId, context.auth.userId]);
    return reply.send({ ok: true });
  });

  app.post('/api/planner/:tripId/expenses', async (request, reply) => {
    const context = await mutationTrip(db, config, request, reply);
    if (!context) return;
    const parsed = expenseSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_expense' });
    const id = randomUUID();
    await db.query("INSERT INTO expenses (id,trip_id,owner_user_id,category,description,amount_cents,currency) VALUES ($1,$2,$3,$4,$5,$6,'EUR')", [id, context.tripId, context.auth.userId, parsed.data.category, parsed.data.description, Math.round(parsed.data.amount * 100)]);
    return reply.code(201).send({ id });
  });

  app.delete('/api/planner/:tripId/expenses/:id', async (request, reply) => deleteOwned(db, config, request, reply, 'expenses'));

  app.post('/api/planner/:tripId/checklist', async (request, reply) => {
    const context = await mutationTrip(db, config, request, reply);
    if (!context) return;
    const parsed = checklistSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_checklist_item' });
    const id = randomUUID();
    await db.query('INSERT INTO checklist_items (id,trip_id,owner_user_id,text,sort_order) VALUES ($1,$2,$3,$4,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM checklist_items WHERE trip_id=$2 AND owner_user_id=$3))', [id, context.tripId, context.auth.userId, parsed.data.text]);
    return reply.code(201).send({ id });
  });

  app.patch('/api/planner/:tripId/checklist/:id', async (request, reply) => {
    const context = await mutationTrip(db, config, request, reply);
    if (!context) return;
    const params = z.object({ id: idSchema }).safeParse(request.params);
    const body = z.object({ completed: z.boolean() }).safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'invalid_checklist_item' });
    const result = await db.query('UPDATE checklist_items SET completed=$1,updated_at=now() WHERE id=$2 AND trip_id=$3 AND owner_user_id=$4', [body.data.completed, params.data.id, context.tripId, context.auth.userId]);
    return result.rowCount ? reply.send({ ok: true }) : reply.code(404).send({ error: 'item_not_found' });
  });

  app.delete('/api/planner/:tripId/checklist/:id', async (request, reply) => deleteOwned(db, config, request, reply, 'checklist_items'));

  app.post('/api/planner/import-local', async (request, reply) => {
    const auth = await requireMutationAuth(db, config, request, reply);
    if (!auth || !(await requireAccess(db, auth, reply))) return;
    const parsed = importSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_import' });
    const tripId = randomUUID();
    await db.transaction(async (tx) => {
      await tx.query("INSERT INTO trips (id,owner_user_id,name,source) VALUES ($1,$2,'Viagem importada do navegador','local_import')", [tripId, auth.userId]);
      await tx.query("INSERT INTO budgets (trip_id,owner_user_id,amount_cents,currency) VALUES ($1,$2,$3,'EUR')", [tripId, auth.userId, Math.round(parsed.data.budget * 100)]);
      for (const item of parsed.data.itinerary) await tx.query('INSERT INTO itinerary_items (id,trip_id,owner_user_id,day_number,starts_at,title,kind,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [randomUUID(), tripId, auth.userId, item.day, item.time || null, item.what, item.type, item.notes || null]);
      for (const place of parsed.data.places) await tx.query('INSERT INTO places (id,trip_id,owner_user_id,name,category,address,notes) VALUES ($1,$2,$3,$4,$5,$6,$7)', [randomUUID(), tripId, auth.userId, place.name, place.type, place.address || null, place.notes || null]);
      for (const expense of parsed.data.expenses) await tx.query("INSERT INTO expenses (id,trip_id,owner_user_id,category,description,amount_cents,currency) VALUES ($1,$2,$3,$4,$5,$6,'EUR')", [randomUUID(), tripId, auth.userId, expense.type, expense.desc, Math.round(expense.value * 100)]);
      for (const [index, item] of parsed.data.checklist.entries()) await tx.query('INSERT INTO checklist_items (id,trip_id,owner_user_id,text,completed,sort_order) VALUES ($1,$2,$3,$4,$5,$6)', [randomUUID(), tripId, auth.userId, item.text, item.done, index]);
    });
    await audit(db, config, request, 'planner.local_import', auth.userId, 'trip', tripId, { records: parsed.data.itinerary.length + parsed.data.places.length + parsed.data.expenses.length + parsed.data.checklist.length });
    return reply.code(201).send({ id: tripId });
  });
}

async function requireAccess(db: Database, auth: AuthContext, reply: FastifyReply) {
  if (auth.roles.includes('master')) return true;
  const result = await db.query('SELECT 1 FROM subscriptions WHERE user_id=$1 AND status IN (\'trialing\',\'active\') AND ends_at > now() LIMIT 1', [auth.userId]);
  if (!result.rowCount) {
    await reply.code(402).send({ error: 'planner_access_expired' });
    return false;
  }
  return true;
}

async function ownedTrip(db: Database, userId: string, tripId?: string) {
  const result = tripId
    ? await db.query<{ id: string; name: string; destination: string | null; starts_on: string | null; ends_on: string | null; source: string }>('SELECT id,name,destination,starts_on,ends_on,source FROM trips WHERE id=$1 AND owner_user_id=$2', [tripId, userId])
    : await db.query<{ id: string; name: string; destination: string | null; starts_on: string | null; ends_on: string | null; source: string }>('SELECT id,name,destination,starts_on,ends_on,source FROM trips WHERE owner_user_id=$1 ORDER BY updated_at DESC LIMIT 1', [userId]);
  return result.rows[0] ?? null;
}

async function mutationTrip(db: Database, config: AppConfig, request: FastifyRequest, reply: FastifyReply) {
  const auth = await requireMutationAuth(db, config, request, reply);
  if (!auth || !(await requireAccess(db, auth, reply))) return null;
  const params = z.object({ tripId: idSchema }).safeParse(request.params);
  if (!params.success || !(await ownedTrip(db, auth.userId, params.data.tripId))) {
    await reply.code(404).send({ error: 'trip_not_found' });
    return null;
  }
  return { auth, tripId: params.data.tripId };
}

async function deleteOwned(db: Database, config: AppConfig, request: FastifyRequest, reply: FastifyReply, table: 'itinerary_items' | 'places' | 'expenses' | 'checklist_items') {
  const context = await mutationTrip(db, config, request, reply);
  if (!context) return;
  const params = z.object({ id: idSchema }).safeParse(request.params);
  if (!params.success) return reply.code(400).send({ error: 'invalid_item' });
  const result = await db.query(`DELETE FROM ${table} WHERE id=$1 AND trip_id=$2 AND owner_user_id=$3`, [params.data.id, context.tripId, context.auth.userId]);
  return result.rowCount ? reply.send({ ok: true }) : reply.code(404).send({ error: 'item_not_found' });
}
