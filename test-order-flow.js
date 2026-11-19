/**
 * Focused checks for business routing, isolation, languages, the order flow and the
 * database (real Postgres via PGlite, with the Supabase migration and row-level security).
 * No network, no API keys.
 *   npm run test:order
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { MenuService, openStatus, checkPickupTime, nextOpening } from './menu-service.js';
import { EmailService } from './email-service.js';
import { ticketHtml, ticketText, ticketSubject } from './staff-ticket.js';
import { OrderState, PHASES, isExplicitConfirmation, normalizePhone } from './order-state.js';
import { BusinessRegistry } from './business-registry.js';
import { createConversation, actionsFactory } from './call-factory.js';
import { BusinessActions, Notifier, syncBusiness, orderMessage } from './business-actions.js';
import { Database } from './database.js';
import { createDevDatabase } from './dev-database.js';
import { TextToSpeech } from './tts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const menuData = JSON.parse(fs.readFileSync(path.join(__dirname, 'test-fixtures', 'sample-menu.json'), 'utf-8'));
const menu = new MenuService(menuData);

// Tuesday 2026-11-17, 1:00 PM New York (open) and 4:00 PM (closed between lunch and dinner)
const OPEN_TIME = () => new Date('2026-11-17T18:00:00Z');
const CLOSED_TIME = () => new Date('2026-11-17T21:00:00Z');

const quiet = { log() {}, error() {}, warn() {} };
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'paahi-test-'));

function newOrder(opts = {}) {
    return new OrderState({ callId: 'CA_test', menu, clock: OPEN_TIME, ...opts });
}

function fillPickup(order) {
    assert.equal(order.setIntent('pickup').ok, true);
    assert.equal(order.addItem({ item: 'butter chicken', quantity: 2, spice_level: 'mild' }).ok, true);
    assert.equal(order.addItem({ item: 'garlic naan' }).ok, true);
    assert.equal(order.setCustomer({ name: 'Babu', phone: '(973) 555-1234' }).ok, true);
}

// ---------------------------------------------------------------- menu lookup

test('menu lookup: exact, fuzzy, ambiguous, and not on menu', () => {
    assert.equal(menu.findItem('Butter Chicken').item.id, 'chicken_004');
    assert.equal(menu.findItem('chicken tika masala').item.name, 'Chicken Tikka Masala');
    assert.equal(menu.findItem('mango lasi').item.name, 'Mango Lassi');
    const samosa = menu.findItem('samosa');
    assert.equal(samosa.status, 'ambiguous');
    assert.ok(samosa.candidates.map(c => c.name).includes('Vegetable Samosa'));
    assert.equal(menu.findItem('pizza').status, 'not_found');
    assert.equal(menu.findItem('').status, 'not_found');
});

test('invalid items are rejected, never added', () => {
    const order = newOrder();
    const r = order.addItem({ item: 'pepperoni pizza' });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'item_not_on_menu');
    const amb = order.addItem({ item: 'biryani' });
    assert.equal(amb.error, 'ambiguous_item');
    assert.equal(order.data.items.length, 0);
});

// ---------------------------------------------------------- quantity/modifiers

test('quantity validation', () => {
    const order = newOrder();
    assert.equal(order.addItem({ item: 'naan', quantity: 0 }).error, 'invalid_quantity');
    assert.equal(order.addItem({ item: 'naan', quantity: 2.5 }).error, 'invalid_quantity');
    assert.equal(order.addItem({ item: 'naan', quantity: 25 }).error, 'quantity_too_large');
    assert.equal(order.addItem({ item: 'naan', quantity: 3 }).ok, true);
    assert.equal(order.data.items[0].quantity, 3);
});

test('modifiers and spice must be allowed for that item', () => {
    const order = newOrder();
    assert.equal(order.addItem({ item: 'butter chicken', modifiers: ['no onion'] }).error, 'modifier_not_allowed');
    assert.equal(order.addItem({ item: 'butter chicken', spice_level: 'extra_spicy' }).error, 'spice_not_adjustable');
    assert.equal(order.addItem({ item: 'raita', spice_level: 'mild' }).error, 'spice_not_adjustable');
    const ok = order.addItem({ item: 'butter chicken', modifiers: ['less cream'], spice_level: 'mild' });
    assert.equal(ok.ok, true);
    assert.deepEqual(order.data.items[0].modifiers.map(m => m.id), ['less_cream']);
    assert.equal(order.data.items[0].spice_level, 'mild');
    // Spice sent as a modifier is routed to spice_level
    order.addItem({ item: 'chicken vindaloo', modifiers: ['extra spicy'] });
    assert.equal(order.data.items[1].spice_level, 'extra_spicy');
    assert.equal(order.data.items[1].modifiers.length, 0);
});

test('sizes: required when an item has several, priced from the menu', () => {
    const order = newOrder();
    const r = order.addItem({ item: 'tandoori chicken' });
    assert.equal(r.error, 'size_required');
    assert.deepEqual(r.options, ['half', 'full']);
    assert.equal(order.addItem({ item: 'tandoori chicken', size: 'half' }).ok, true);
    assert.equal(order.data.subtotal, 18);
    assert.equal(order.addItem({ item: 'mango lassi', size: 'large', quantity: 2 }).ok, true);
    assert.equal(order.data.subtotal, 32);
});

// ---------------------------------------------------------- required fields

test('pickup requires type, items, name and phone', () => {
    const order = newOrder();
    assert.deepEqual(order.missingFields(), ['order_type', 'items', 'customer_name', 'customer_phone']);
    fillPickup(order);
    assert.deepEqual(order.missingFields(), []);
    assert.equal(order.setCustomer({ phone: '555-12' }).error, 'invalid_phone');
    assert.equal(normalizePhone('+1 973 555 1234'), '9735551234');
});

test('delivery is refused unless enabled; when enabled it requires an address', () => {
    assert.equal(newOrder().setIntent('delivery').error, 'delivery_not_available');
    const order = newOrder({ deliveryEnabled: true });
    order.setIntent('delivery');
    order.addItem({ item: 'naan' });
    order.setCustomer({ name: 'A', phone: '9735551234' });
    assert.deepEqual(order.missingFields(), ['delivery_address']);
});

// ------------------------------------------------ readback and confirmation

test('readback is refused while fields are missing', () => {
    const order = newOrder();
    order.setIntent('pickup');
    const r = order.readBack();
    assert.equal(r.ok, false);
    assert.deepEqual(r.missing, ['items', 'customer_name', 'customer_phone']);
});

test('confirmation requires a readback first and an unqualified yes', () => {
    const order = newOrder();
    fillPickup(order);
    assert.equal(order.confirm({ callerUtterance: 'yes' }).error, 'read_back_first');
    const rb = order.readBack();
    assert.equal(rb.ok, true);
    assert.match(rb.say_exactly, /two Butter Chicken, mild; one Garlic Naan/);
    assert.match(rb.say_exactly, /\$42\.00 before tax/);
    assert.match(rb.say_exactly, /9 7 3, 5 5 5, 1 2 3 4/);
    assert.equal(order.confirm({ callerUtterance: 'yes but add a raita' }).error, 'not_explicit_confirmation');
    assert.equal(order.confirm({ callerUtterance: "yes that's right" }).ok, true);
    assert.equal(order.phase, PHASES.CONFIRMED);
    assert.equal(order.addItem({ item: 'naan' }).error, 'order_locked');
});

test('correction after readback forces a new readback', () => {
    const order = newOrder();
    fillPickup(order);
    order.readBack();
    assert.equal(order.phase, PHASES.AWAITING_CONFIRMATION);
    assert.equal(order.updateItem({ line_id: 'L1', quantity: 1 }).ok, true);
    assert.equal(order.phase, PHASES.COLLECTING);
    assert.equal(order.confirm({ callerUtterance: 'yes' }).error, 'read_back_first');
    assert.equal(order.removeItem({ line_id: 'L2' }).ok, true);
    assert.equal(order.data.subtotal, 19);
    assert.match(order.readBack().say_exactly, /one Butter Chicken, mild\./);
    assert.equal(order.confirm({ callerUtterance: 'yep' }).ok, true);
});

test('explicit confirmation detector', () => {
    for (const yes of ['Yes', 'yeah', "That's correct", 'yes please', 'Sounds good', 'go ahead', 'perfect, thank you']) {
        assert.equal(isExplicitConfirmation(yes), true, yes);
    }
    for (const notYet of ['no', 'wait', 'yes but make it two', 'actually change the naan', 'hmm', '', 'can you add rice']) {
        assert.equal(isExplicitConfirmation(notYet), false, notYet);
    }
});

// ------------------------------------------------------------- database

function fakeFetch(status = 200) {
    const calls = [];
    const fn = async (url, init) => { calls.push({ url, init }); return { ok: status < 400, status }; };
    fn.calls = calls;
    return fn;
}

// One in-process Postgres for the whole file, with the real Supabase migration applied.
const { db, raw } = await createDevDatabase();
let callCounter = 0;
const nextCallId = () => `CA_test_${++callCounter}`;

function testBusiness(id, extra = {}) {
    return {
        id, name: id, shortName: id, locations: [{ id: 'main', hours: {} }],
        notifications: { emailTo: null, webhookUrl: `https://hooks.example/${id}`, ...extra },
    };
}

function confirmedOrder(callId = nextCallId()) {
    const order = new OrderState({ callId, menu, clock: OPEN_TIME });
    fillPickup(order);
    order.readBack();
    order.confirm({ callerUtterance: 'yes' });
    return order;
}

async function actionsFor(business, { fetchImpl = fakeFetch(), database = db } = {}) {
    await syncBusiness(db, business);
    const notifier = new Notifier({ db: database, fetchImpl, logger: quiet });
    return { actions: new BusinessActions({ business, db: database, notifier, logger: quiet }), fetchImpl, notifier };
}

test('database: backend role cannot bypass row-level security; a superuser connection is refused', async () => {
    assert.deepEqual(await db.checkTenantSafety(), { role: 'paahi_app' });
    const asSuperuser = new Database(db.adapter); // no SET ROLE -> PGlite superuser
    await assert.rejects(asSuperuser.checkTenantSafety(), /bypasses row-level security/);
});

test('database: confirmed order is saved once, even when submitted repeatedly', async () => {
    const biz = testBusiness('rls-a');
    const { actions, fetchImpl } = await actionsFor(biz);
    const order = confirmedOrder();
    const key = order.idempotencyKey();
    const [a, b] = await Promise.all([
        actions.submit(order.snapshot(), key, { locationId: 'main', language: 'en' }),
        actions.submit(order.snapshot(), key, { locationId: 'main', language: 'en' }),
    ]);
    const c = await actions.submit(order.snapshot(), key, { locationId: 'main', language: 'en' });
    assert.equal(c.success, true);
    assert.equal(c.duplicate, true);
    assert.equal(a.order_id, c.order_id);
    assert.equal(b.order_id, c.order_id);
    assert.equal([a, b].filter(r => r.duplicate).length, 1, 'exactly one of the concurrent submits created the order');
    await actions.lastDelivery;
    const rows = (await raw.query('select * from public.orders where idempotency_key = $1', [key])).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].customer_phone, '9735551234');
    assert.equal(rows[0].items.length, 2);
    assert.equal(Number(rows[0].subtotal), 42);
    const notes = (await raw.query('select * from public.notifications where order_id = $1', [rows[0].id])).rows;
    assert.equal(notes.length, 1);
    assert.equal(notes[0].status, 'sent');
    assert.equal(fetchImpl.calls.length, 1, 'staff notified once');
    assert.equal(fetchImpl.calls[0].init.headers['Idempotency-Key'], `paahi-notification:${notes[0].id}`);
});

test('database: row-level security keeps each business to its own rows', async () => {
    const a = await actionsFor(testBusiness('tenant-a'));
    const b = await actionsFor(testBusiness('tenant-b'));
    const oa = confirmedOrder();
    const ob = confirmedOrder();
    await a.actions.submit(oa.snapshot(), oa.idempotencyKey(), { locationId: 'main' });
    await b.actions.submit(ob.snapshot(), ob.idempotencyKey(), { locationId: 'main' });

    // Even a query with no WHERE clause only sees the current business.
    const seenByA = await db.forBusiness('tenant-a', async tx => (await tx.query('select business_id from public.orders')).rows);
    assert.ok(seenByA.length >= 1);
    assert.ok(seenByA.every(r => r.business_id === 'tenant-a'));

    // Writing another tenant's row is rejected by the database itself.
    await assert.rejects(db.forBusiness('tenant-a', tx => tx.query(
        `insert into public.callback_requests (business_id, call_sid, idempotency_key, customer_phone, reason)
         values ('tenant-b', 'x', 'x', '9735550000', 'test')`)), /row-level security/);
    const updated = await db.forBusiness('tenant-a', async tx => (await tx.query(
        "update public.orders set status = 'cancelled' where business_id = 'tenant-b' returning id")).rows);
    assert.equal(updated.length, 0);

    // No business set -> nothing visible.
    const none = await db.adapter.transaction(async tx => {
        await tx.query('set local role paahi_app');
        return (await tx.query('select count(*)::int as n from public.orders')).rows[0].n;
    });
    assert.equal(none, 0);
    await assert.rejects(db.forBusiness('', async () => {}), /requires a business id/);
});

test('database: dashboard users read only businesses they belong to, and cannot write', async () => {
    await actionsFor(testBusiness('member-a'));
    await actionsFor(testBusiness('member-b'));
    const userId = '11111111-1111-4111-8111-111111111111';
    await raw.query('insert into auth.users (id) values ($1) on conflict do nothing', [userId]);
    await raw.query("insert into public.business_members (business_id, user_id, role) values ('member-a', $1, 'owner') on conflict do nothing", [userId]);
    const asUser = sql => raw.transaction(async tx => {
        await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
        await tx.query('set local role authenticated');
        return (await tx.query(sql)).rows;
    });
    const visible = await asUser('select id from public.businesses');
    assert.deepEqual(visible.map(r => r.id), ['member-a']);
    await assert.rejects(asUser("insert into public.businesses (id, name) values ('hacked', 'x')"), /permission denied/);
    const anon = raw.transaction(async tx => { await tx.query('set local role anon'); return (await tx.query('select * from public.orders')).rows; });
    await assert.rejects(anon, /permission denied/);
});

test('database: invalid order data is rejected by the schema too', async () => {
    await actionsFor(testBusiness('schema-check'));
    await assert.rejects(db.forBusiness('schema-check', tx => tx.query(
        `insert into public.orders (business_id, location_id, call_sid, idempotency_key, order_type, customer_name, customer_phone, items, subtotal, language, confirmed_at)
         values ('schema-check', 'main', 'c', 'k', 'pickup', 'A', '555', '[{"x":1}]', 1, 'en', now())`)), /check constraint/);
});

test('notifications: a failed email/webhook never un-places the order, and is retried', async () => {
    const failing = fakeFetch(500);
    const { actions, notifier } = await actionsFor(testBusiness('notify-retry'), { fetchImpl: failing });
    const order = confirmedOrder();
    const r = await actions.submit(order.snapshot(), order.idempotencyKey(), { locationId: 'main' });
    assert.equal(r.success, true, 'order is placed once saved');
    await actions.lastDelivery;
    let note = (await raw.query('select * from public.notifications where order_id = $1', [r.order_id])).rows[0];
    assert.equal(note.status, 'failed');
    assert.equal(note.attempts, 1);
    assert.match(note.last_error, /HTTP 500/);

    // Later retry (pretend the backoff has passed) succeeds.
    await raw.query('update public.notifications set next_attempt_at = now() where id = $1', [note.id]);
    notifier.fetch = fakeFetch(200);
    const results = await notifier.deliverDue(testBusiness('notify-retry'));
    assert.deepEqual(results.map(x => x.success), [true]);
    note = (await raw.query('select * from public.notifications where id = $1', [note.id])).rows[0];
    assert.equal(note.status, 'sent');
    assert.equal(note.attempts, 2);
});

test('callback requests are saved in the database and staff are notified once', async () => {
    const { actions, fetchImpl } = await actionsFor(testBusiness('callback-db'));
    const req = { call_id: 'CA_cb_1', phone: '9735550000', name: 'Asha', reason: 'caller asked for manager', language: 'te', locationId: 'main' };
    const first = await actions.notifyCallback(req);
    const again = await actions.notifyCallback(req);
    assert.equal(first.success, true);
    assert.equal(again.duplicate, true);
    await actions.lastDelivery;
    const rows = (await raw.query("select * from public.callback_requests where call_sid = 'CA_cb_1'")).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].language, 'te');
    assert.equal(fetchImpl.calls.length, 1);
    const body = JSON.parse(fetchImpl.calls[0].init.body);
    assert.equal(body.type, 'callback_request');
    assert.match(body.order_summary, /caller's language: te/);
});

test('database down: the order is NOT reported as placed', async () => {
    const broken = new Database({ transaction: async () => { throw new Error('connection refused'); }, close() {} });
    const biz = testBusiness('db-down');
    const actions = new BusinessActions({ business: biz, db: broken, notifier: new Notifier({ db: broken, logger: quiet }), logger: quiet });
    const order = confirmedOrder();
    const r = await actions.submit(order.snapshot(), order.idempotencyKey(), { locationId: 'main' });
    assert.equal(r.success, false);
    assert.equal(r.error, 'database_write_failed');
});

test('call records are saved without transcript text', async () => {
    const { actions } = await actionsFor(testBusiness('call-log'));
    const ok = await actions.logCall({
        callSid: 'CA_log_1', locationId: 'main', routedBy: 'dialed_number', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
        language: 'hi', languageHistory: [{ language: 'en' }, { language: 'hi' }], outcome: 'order_placed', handoffReason: null,
        events: [{ type: 'caller_said', chars: 12 }],
    });
    assert.equal(ok.success, true);
    const row = (await raw.query("select * from public.calls where call_sid = 'CA_log_1'")).rows[0];
    assert.equal(row.language, 'hi');
    assert.equal(row.outcome, 'order_placed');
    assert.equal(row.events[0].text, undefined);
});

// ------------------------------------------------------- businesses + routing

const JALWA_NUMBER = '+19735550100';   // test-only numbers
const HARBOR_NUMBER = '+12015550199';

/** A throwaway businesses/ folder: the real Jalwa config plus a second, unrelated business. */
function makeFixtureRoot({ mutateJalwa, extra } = {}) {
    const root = tmpDir();
    const jalwaDir = path.join(root, 'jalwa-montclair');
    fs.mkdirSync(jalwaDir);
    const jalwa = JSON.parse(fs.readFileSync(path.join(__dirname, 'businesses', 'jalwa-montclair', 'business.json'), 'utf-8'));
    jalwa.phone_numbers = [JALWA_NUMBER];
    if (mutateJalwa) mutateJalwa(jalwa);
    fs.writeFileSync(path.join(jalwaDir, 'business.json'), JSON.stringify(jalwa));
    fs.copyFileSync(path.join(__dirname, 'test-fixtures', 'sample-menu.json'), path.join(jalwaDir, 'menu.json'));

    const harborDir = path.join(root, 'harbor-cafe');
    fs.mkdirSync(harborDir);
    fs.writeFileSync(path.join(harborDir, 'business.json'), JSON.stringify({
        id: 'harbor-cafe', name: 'Harbor Cafe', business_type: 'restaurant', timezone: 'America/New_York',
        locations: [{ id: 'main', address: '1 Pier Rd', phone: '(201) 555-0100', hours: jalwa.locations[0].hours }],
        phone_numbers: [HARBOR_NUMBER],
        languages: { default: 'en', enabled: ['en'] },
        workflows: { restaurant_ordering: { enabled: true, menu_file: 'menu.json', order_types: ['pickup'] } },
        notifications: { email_to_env: 'HARBOR_EMAIL_TO' },
    }));
    fs.writeFileSync(path.join(harborDir, 'menu.json'), JSON.stringify({
        categories: [{ name: 'Coffee', items: [{ id: 'c1', name: 'Flat White', base_price: 4.5, sizes: [{ name: 'regular', price: 4.5 }], modifiers: [] }] }],
        modifiers: {},
    }));
    if (extra) extra(root);
    return root;
}

function buildRegistry({ root = makeFixtureRoot(), languages, createSubmitter, env = {}, defaultBusinessId } = {}) {
    return new BusinessRegistry({
        rootDir: root,
        env,
        defaultBusinessId,
        logger: quiet,
        createSubmitter: createSubmitter || actionsFactory({ db, notifier: new Notifier({ db, logger: quiet }), logger: quiet }),
        overrides: languages ? { 'jalwa-montclair': { languages: { enabled: languages, default: languages[0], allow_experimental: true } } } : {},
    });
}

test('routing: the dialed number picks exactly one business', () => {
    const registry = buildRegistry();
    assert.equal(registry.resolve('+1 (973) 555-0100').business.id, 'jalwa-montclair');
    assert.equal(registry.resolve('2015550199').business.id, 'harbor-cafe');
    assert.equal(registry.resolve('+15555550000'), null);
    assert.equal(registry.resolve(''), null);
    const withDefault = buildRegistry({ defaultBusinessId: 'jalwa-montclair' });
    const fallback = withDefault.resolve('+15555550000');
    assert.equal(fallback.business.id, 'jalwa-montclair');
    assert.equal(fallback.routedBy, 'default_business');
});

test('config validation: bad business config fails at startup, not mid-call', () => {
    assert.throws(() => buildRegistry({ root: makeFixtureRoot({ mutateJalwa: b => { b.phone_numbers = [HARBOR_NUMBER]; } }) }), /already used by/);
    assert.throws(() => buildRegistry({ root: makeFixtureRoot({ mutateJalwa: b => { b.languages.enabled = ['en', 'te']; } }) }), /"te" is experimental/);
    assert.throws(() => buildRegistry({ root: makeFixtureRoot({ mutateJalwa: b => { b.languages.enabled = ['en', 'de']; } }) }), /"de" is not implemented/);
    assert.throws(() => buildRegistry({ root: makeFixtureRoot({ mutateJalwa: b => { b.workflows.appointments = { enabled: true }; } }) }), /"appointments" is not implemented/);
    assert.throws(() => buildRegistry({ root: makeFixtureRoot({ mutateJalwa: b => { b.workflows.restaurant_ordering.order_types = ['pickup', 'delivery']; } }) }), /no "delivery" rules/);
    assert.throws(() => buildRegistry({ root: makeFixtureRoot({ mutateJalwa: b => { b.workflows.restaurant_ordering.menu_file = '../harbor-cafe/menu.json'; } }) }), /inside the business folder/);
    assert.throws(() => buildRegistry({ defaultBusinessId: 'nope' }), /DEFAULT_BUSINESS_ID/);
});

test('secrets come from named environment variables, never from business.json', () => {
    const registry = buildRegistry({ env: { EMAIL_TO: 'kitchen@jalwa.test', HARBOR_EMAIL_TO: 'your_email_here' } });
    assert.equal(registry.get('jalwa-montclair').business.notifications.emailTo, 'kitchen@jalwa.test');
    // Placeholder values from .env.example are treated as unset.
    assert.equal(registry.get('harbor-cafe').business.notifications.emailTo, null);
});

// ------------------------------------------------------- conversation engine

let callSeq = 0;
const toolCall = (name, args = {}) => ({ id: `call_${++callSeq}`, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
const toolsMsg = (...calls) => ({ role: 'assistant', content: null, tool_calls: calls });
const textMsg = (content) => ({ role: 'assistant', content });

/** Fake LLM that returns scripted messages in order, and records what it was sent. */
function scriptedLLM(script) {
    const requests = [];
    return {
        requests,
        chat: {
            completions: {
                create: async (req) => {
                    requests.push(JSON.parse(JSON.stringify(req)));
                    const next = script.shift();
                    if (next instanceof Error) throw next;
                    if (!next) throw new Error('script exhausted');
                    return { choices: [{ message: next }] };
                },
            },
        },
    };
}

function fakeEmailService() {
    const emails = [];
    return {
        configured: true,
        emails,
        sendOrderConfirmation: async (msg, { to }) => { emails.push({ msg, to }); return { success: true }; },
    };
}

async function newEngine(script, { clock = OPEN_TIME, submitter, callerPhone = null, languages, dialed = JALWA_NUMBER, mutateJalwa } = {}) {
    const emailService = fakeEmailService();
    const notifier = new Notifier({ db, emailService, logger: quiet });
    const make = actionsFactory({ db, notifier, emailService, logger: quiet });
    const actions = {};
    const registry = buildRegistry({
        root: makeFixtureRoot({ mutateJalwa }),
        languages,
        // Jalwa's business.json names EMAIL_TO as its staff email.
        env: { EMAIL_TO: 'kitchen@jalwa.test' },
        createSubmitter: b => (actions[b.id] = submitter || make(b)),
    });
    for (const b of registry.list()) await syncBusiness(db, b);
    const llm = scriptedLLM(script);
    const callId = nextCallId();
    const route = registry.resolve(dialed);
    const engine = createConversation({ route, callId, callerPhone, llm, model: 'test-model', clock, logger: quiet });
    return { engine, order: engine.workflows[0].order, llm, emails: emailService.emails, actions: actions[route.business.id], callId };
}

test('happy path: pickup order is read back, confirmed, and submitted exactly once', async () => {
    const { engine, order, emails, actions, callId } = await newEngine([
        toolsMsg(toolCall('add_item', { item: 'butter chicken', quantity: 2, spice_level: 'mild' })),
        textMsg('Got it, two mild Butter Chicken. Anything else?'),
        toolsMsg(toolCall('add_item', { item: 'garlic nan' })),
        textMsg('One Garlic Naan. Can I get a name for the order?'),
        toolsMsg(toolCall('set_customer', { name: 'Babu' })),
        textMsg('Thanks, Babu. And a callback number?'),
        toolsMsg(toolCall('set_customer', { phone: '973 555 1234' }), toolCall('read_back_order')),
        toolsMsg(toolCall('confirm_and_submit_order')),
    ]);
    assert.match(engine.greeting(), /Thank you for calling Jalwa\. This is Paahi/);
    assert.equal(order.data.intent, 'pickup', 'pickup-only business sets the order type itself');
    assert.match((await engine.handleUtterance('Hi, two butter chicken, mild')).say, /Anything else/);
    await engine.handleUtterance('and a garlic naan');
    await engine.handleUtterance('Babu');
    const rb = await engine.handleUtterance('973 555 1234');
    assert.match(rb.say, /^Let me read that back\. A pickup order for Babu: two Butter Chicken, mild; one Garlic Naan\./);
    assert.equal(rb.endCall, false);
    const done = await engine.handleUtterance("Yes, that's correct");
    assert.match(done.say, /your order is in/);
    assert.equal(done.endCall, true);
    assert.equal(order.phase, PHASES.SUBMITTED);
    const saved = (await raw.query('select * from public.orders where call_sid = $1', [callId])).rows;
    assert.equal(saved.length, 1, 'order is in the database');
    assert.equal(saved[0].business_id, 'jalwa-montclair');
    assert.equal(saved[0].location_id, 'montclair');
    await actions.lastDelivery;
    assert.equal(emails.length, 1, 'kitchen emailed once');
    assert.equal(emails[0].to, 'kitchen@jalwa.test');
    assert.equal(emails[0].msg.business_id, 'jalwa-montclair');
    const after = await engine.handleUtterance('yes');
    assert.equal(after.endCall, true);
    assert.equal(emails.length, 1);
    const state = engine.callState();
    assert.equal(state.business_id, 'jalwa-montclair');
    assert.equal(state.workflows.restaurant_ordering.status, 'submitted');
});

test('tenant isolation: a call to another business never sees Jalwa data', async () => {
    const { engine, order, llm } = await newEngine([
        toolsMsg(toolCall('add_item', { item: 'butter chicken' })),
        textMsg("Sorry, we don't have that. We have a Flat White."),
    ], { dialed: HARBOR_NUMBER });
    assert.equal(engine.business.id, 'harbor-cafe');
    await engine.handleUtterance('one butter chicken please');
    assert.equal(order.data.items.length, 0);
    const prompt = llm.requests[0].messages[0].content;
    assert.match(prompt, /Flat White/);
    assert.doesNotMatch(prompt, /Butter Chicken|Jalwa|Glenridge/);
});

test('model cannot confirm in the same turn it read back', async () => {
    const { engine, order, emails } = await newEngine([
        toolsMsg(toolCall('read_back_order'), toolCall('confirm_and_submit_order')),
    ]);
    fillPickup(order);
    const r = await engine.handleUtterance('yes that is everything');
    assert.match(r.say, /Let me read that back/);
    assert.equal(order.phase, PHASES.AWAITING_CONFIRMATION);
    assert.equal(emails.length, 0);
});

test('a qualified "yes, but..." does not submit', async () => {
    const { engine, order, emails } = await newEngine([
        toolsMsg(toolCall('read_back_order')),
        toolsMsg(toolCall('confirm_and_submit_order')),
        textMsg('Sure, what would you like to change?'),
    ]);
    fillPickup(order);
    await engine.handleUtterance("that's all");
    const r = await engine.handleUtterance('yes but add a mango lassi');
    assert.equal(r.endCall, false);
    assert.equal(emails.length, 0);
    assert.notEqual(order.phase, PHASES.SUBMITTED);
});

test('business closed, no scheduled orders: order tools are blocked', async () => {
    const { engine, order } = await newEngine([
        toolsMsg(toolCall('add_item', { item: 'naan' })),
        textMsg("We're closed right now; we reopen at five."),
    ], { clock: CLOSED_TIME, mutateJalwa: b => { delete b.workflows.restaurant_ordering.scheduled_orders; } });
    assert.equal(openStatus(engine.location.hours, CLOSED_TIME()).open, false);
    await engine.handleUtterance('one naan please');
    assert.equal(order.data.items.length, 0);
    const blocked = engine.events.find(e => e.type === 'tool' && e.error === 'business_closed');
    assert.ok(blocked);
    assert.ok(!engine.workflows[0].tools.some(t => t.function.name === 'set_pickup_time'), 'no scheduling tool offered');
});

test('business closed, scheduled orders on: order is taken for a pickup time after opening', async () => {
    const { engine, order, emails, actions, callId } = await newEngine([
        toolsMsg(toolCall('add_item', { item: 'butter chicken' })),
        textMsg("We open at five. What time would you like to pick up?"),
        toolsMsg(toolCall('set_pickup_time', { asap: true })),
        textMsg("We're closed until five. What time after five works?"),
        toolsMsg(toolCall('set_pickup_time', { date: '2026-11-17', time: '16:30' })),
        textMsg("We're closed then. How about five or later?"),
        toolsMsg(toolCall('set_pickup_time', { date: '2026-11-17', time: '17:00' })),
        textMsg('Five o\'clock it is. Name for the order?'),
        toolsMsg(toolCall('set_customer', { name: 'Babu', phone: '973 555 1234' }), toolCall('read_back_order')),
        toolsMsg(toolCall('confirm_and_submit_order')),
    ], { clock: CLOSED_TIME });
    // Closed: the model is told when it opens next, and that it may schedule.
    await engine.handleUtterance('one butter chicken for later');
    const prompt = engine.systemPrompt('x');
    assert.match(prompt, /CLOSED\..*Next opening: Tuesday 5:00 PM/);
    assert.match(prompt, /Today is tuesday 2026-11-17/);
    assert.equal(order.data.items.length, 1, 'item added while closed');
    assert.deepEqual(order.missingFields(), ['pickup_time', 'customer_name', 'customer_phone']);

    await engine.handleUtterance('as soon as possible');
    assert.ok(engine.events.some(e => e.type === 'tool' && e.error === 'closed_now'));
    await engine.handleUtterance('four thirty');
    assert.ok(engine.events.some(e => e.type === 'tool' && e.error === 'outside_opening_hours'));
    await engine.handleUtterance('five then');
    assert.equal(order.data.requested_time, '2026-11-17T22:00:00.000Z');

    const rb = await engine.handleUtterance('Babu, 973 555 1234');
    assert.match(rb.say, /A pickup order for Babu: one Butter Chicken\. Pickup today at 5:00 PM\./);
    const done = await engine.handleUtterance('Yes, that is right');
    assert.equal(done.endCall, true);
    const saved = (await raw.query('select pickup_at from public.orders where call_sid = $1', [callId])).rows;
    assert.equal(new Date(saved[0].pickup_at).toISOString(), '2026-11-17T22:00:00.000Z');
    await actions.lastDelivery;
    assert.match(emails[0].msg.order_summary, /SCHEDULED for Tuesday, Nov 17, 5:00 PM/);
    assert.equal(emails[0].msg.pickup_time, 'Tuesday, Nov 17, 5:00 PM');
});

test('scheduled pickup times are checked against hours, lead time and how far ahead', () => {
    const hours = JSON.parse(fs.readFileSync(path.join(__dirname, 'businesses', 'jalwa-montclair', 'business.json'), 'utf-8')).locations[0].hours;
    const opts = { now: CLOSED_TIME(), timeZone: 'America/New_York', minLeadMinutes: 20, maxDaysAhead: 7 };
    assert.equal(checkPickupTime(hours, { date: '2026-11-17', time: '19:00' }, opts).ok, true);
    assert.equal(checkPickupTime(hours, { date: '2026-11-18', time: '12:00' }, opts).ok, true, 'tomorrow lunch');
    assert.equal(checkPickupTime(hours, { date: '2026-11-17', time: '16:10' }, opts).error, 'too_soon');
    assert.equal(checkPickupTime(hours, { date: '2026-11-17', time: '16:30' }, opts).error, 'outside_opening_hours');
    assert.equal(checkPickupTime(hours, { date: '2026-11-17', time: '22:25' }, opts).error, 'outside_opening_hours', 'not right at closing');
    assert.equal(checkPickupTime(hours, { date: '2026-11-30', time: '12:00' }, opts).error, 'too_far_ahead');
    assert.equal(checkPickupTime(hours, { date: 'someday', time: '7pm' }, opts).error, 'invalid_time_format');
    assert.equal(nextOpening(hours, CLOSED_TIME(), 'America/New_York').toISOString(), '2026-11-17T22:00:00.000Z');
});

// ------------------------------------------------------------ Jalwa's real menu

const jalwaMenu = new MenuService(JSON.parse(fs.readFileSync(path.join(__dirname, 'businesses', 'jalwa-montclair', 'menu.json'), 'utf-8')));

test('Jalwa menu: dish names are found however the caller says them', () => {
    const name = q => jalwaMenu.findItem(q).item?.name;
    assert.equal(name('Aloo Tikki with Pindi Choley'), 'Aloo Tikki With Pindi Cholley');
    assert.equal(name('aloo tikki'), 'Aloo Tikki With Pindi Cholley');
    assert.equal(name('aloo tikki chole'), 'Aloo Tikki With Pindi Cholley');
    assert.equal(name('pindi chole'), 'Pindi Cholley', 'the entree, not the starter that also contains it');
    assert.equal(name('pindi chhole'), 'Pindi Cholley');
    assert.equal(name('saag paneer'), 'Palak Paneer');
    assert.equal(name('chicken tika masala'), 'Chicken Tikka Masala');
    assert.equal(name('garlic nan'), 'Garlic Naan');
    assert.equal(name('panner tikka'), 'Paneer Tikka');
    assert.equal(jalwaMenu.findItem('naan').status, 'ambiguous');
    assert.equal(jalwaMenu.findItem('butter chicken').status, 'ambiguous');
    assert.equal(jalwaMenu.findItem('pepperoni pizza').status, 'not_found');
    const starter = jalwaMenu.getItem(jalwaMenu.findItem('aloo tikki').item.id);
    assert.equal(starter.base_price, 14);
});

test('Jalwa menu: lunch specials only for Mon-Thu lunch, including scheduled pickups', () => {
    const at = iso => () => new Date(iso);
    const tueLunch = new OrderState({ callId: 'CA_l1', menu: jalwaMenu, clock: at('2026-11-17T17:00:00Z') }); // Tue 12:00
    assert.equal(tueLunch.addItem({ item: 'palak paneer lunch special' }).ok, true);
    // Moving that order to Friday evening is refused while it holds a lunch special.
    const r = tueLunch.setPickupTime(new Date('2026-11-20T23:00:00Z'));
    assert.equal(r.error, 'items_not_available_at_that_time');
    const saturday = new OrderState({ callId: 'CA_l2', menu: jalwaMenu, clock: at('2026-11-21T17:00:00Z') });
    const sat = saturday.addItem({ item: 'palak paneer lunch special' });
    assert.equal(sat.error, 'not_available_at_that_time');
    assert.match(sat.available, /monday, tuesday, wednesday, thursday 11:30 AM - 3:00 PM/);
    assert.equal(saturday.addItem({ item: 'palak paneer' }).ok, true);
});

test('allergy mention adds a safety note to the model prompt', async () => {
    const { engine, llm } = await newEngine([textMsg("I can't confirm ingredients, but I can note it.")]);
    await engine.handleUtterance('I have a peanut allergy, is the korma safe?');
    assert.match(llm.requests[0].messages[0].content, /cannot confirm any item is safe/);
});

test('malformed tool arguments are rejected, not crashed on', async () => {
    const { engine, order } = await newEngine([
        toolsMsg(toolCall('add_item', '{not json')),
        textMsg('Sorry, which dish was that?'),
    ]);
    const r = await engine.handleUtterance('uh the chicken thing');
    assert.equal(r.say, 'Sorry, which dish was that?');
    assert.equal(order.data.items.length, 0);
});

function fakeCallbackSubmitter({ submitOk = false, callbackOk = true } = {}) {
    const callbacks = [];
    return {
        callbacks,
        submit: async () => ({ success: submitOk, error: submitOk ? null : 'all_destinations_failed' }),
        notifyCallback: async (x) => { callbacks.push(x); return { success: callbackOk }; },
    };
}

test('model failure: one retry prompt, then a staff callback instead of a dead call', async () => {
    const submitter = fakeCallbackSubmitter();
    const { engine, order } = await newEngine([new Error('timeout'), new Error('timeout')], { submitter, callerPhone: '+19735550000' });
    const first = await engine.handleUtterance('hello');
    assert.equal(first.endCall, false);
    const second = await engine.handleUtterance('hello?');
    assert.equal(second.endCall, true);
    assert.equal(second.handoff, true);
    assert.equal(order.phase, PHASES.HANDOFF);
    assert.equal(submitter.callbacks.length, 1);
    assert.match(second.say, /call you back at 9 7 3, 5 5 5, 0 0 0 0/);
});

test('caller asks for a person: callback request goes to that business only', async () => {
    const submitter = fakeCallbackSubmitter();
    const { engine } = await newEngine([toolsMsg(toolCall('request_human', { reason: 'caller asked for manager' }))], { submitter, callerPhone: '9735550000' });
    const r = await engine.handleUtterance('let me talk to a manager');
    assert.equal(r.handoff, true);
    assert.equal(submitter.callbacks[0].reason, 'caller asked for manager');
    assert.match(submitter.callbacks[0].call_id, /^CA_test_/);
    assert.equal(submitter.callbacks[0].locationId, 'montclair');
});

test('submission failure tells the truth and falls back to a callback', async () => {
    const submitter = fakeCallbackSubmitter({ callbackOk: false });
    const { engine, order } = await newEngine([
        toolsMsg(toolCall('read_back_order')),
        toolsMsg(toolCall('confirm_and_submit_order')),
    ], { submitter });
    fillPickup(order);
    await engine.handleUtterance("that's it");
    const r = await engine.handleUtterance('yes');
    assert.doesNotMatch(r.say, /order is in/);
    assert.match(r.say, /not able to finish this/);
    assert.equal(order.data.handoff_reason, 'submission_failed');
});

// ------------------------------------------------------------- languages

test('single-language business: no language tool offered', async () => {
    const { engine, llm } = await newEngine([textMsg('Hello!')]);
    await engine.handleUtterance('hi');
    assert.ok(!llm.requests[0].tools.some(t => t.function.name === 'set_language'));
});

test('language switch: Hindi readback, Hindi confirmation, structured order stays language-neutral', async () => {
    const { engine, order, emails, llm, actions, callId } = await newEngine([
        toolsMsg(toolCall('set_language', { language: 'hi' })),
        textMsg('ज़रूर, मैं हिन्दी में बात करता हूँ। आप क्या ऑर्डर करना चाहेंगे?'),
        toolsMsg(toolCall('read_back_order')),
        toolsMsg(toolCall('confirm_and_submit_order')),
    ], { languages: ['en', 'hi'] });
    const greeting = engine.greeting();
    assert.match(greeting, /You can also speak with me in Hindi\./);
    const switched = await engine.handleUtterance('क्या आप हिन्दी में बात कर सकते हैं?', { detectedLanguage: 'hi' });
    assert.equal(switched.language, 'hi');
    assert.match(llm.requests[0].messages[0].content, /Speech recognition heard mostly Hindi/);
    assert.match(llm.requests[1].messages[0].content, /CALL LANGUAGE: Hindi \(hi\)/);
    fillPickup(order);
    const rb = await engine.handleUtterance('बस इतना ही');
    assert.match(rb.say, /^मैं आपका ऑर्डर दोहरा देता हूँ। Babu के नाम पर पिकअप ऑर्डर: 2 Butter Chicken, कम तीखा; 1 Garlic Naan।/);
    assert.match(rb.say, /42 डॉलर/);
    const done = await engine.handleUtterance('हाँ, सही है');
    assert.match(done.say, /आपका ऑर्डर लग गया है/);
    await actions.lastDelivery;
    assert.equal(emails.length, 1);
    const sent = emails[0].msg;
    assert.equal(sent.items_structured[0].name, 'Butter Chicken');
    assert.equal(sent.items_structured[0].spice_level, 'mild');
    const row = (await raw.query('select language, items from public.orders where call_sid = $1', [callId])).rows[0];
    assert.equal(row.language, 'hi');
    assert.equal(row.items[0].menu_item_id, 'chicken_004');
    assert.deepEqual(engine.callState().language_history.map(h => h.language), ['en', 'hi']);
});

test('language switch to a language the business has not enabled is refused', async () => {
    const { engine } = await newEngine([
        toolsMsg(toolCall('set_language', { language: 'te' })),
        textMsg('Sorry, I can help in English or Spanish.'),
    ], { languages: ['en', 'es'] });
    const r = await engine.handleUtterance('Telugu lo matladandi');
    assert.equal(r.language, 'en');
    assert.ok(engine.events.some(e => e.type === 'tool' && e.error === 'language_not_enabled'));
});

test('every enabled language has complete fixed phrases', () => {
    const order = newOrder();
    fillPickup(order);
    for (const code of ['en', 'es', 'fr', 'hi', 'te']) {
        const o = newOrder();
        fillPickup(o);
        const text = o.readBack(code).say_exactly;
        assert.ok(text.includes('Butter Chicken') && text.includes('Babu') && text.includes('9 7 3, 5 5 5, 1 2 3 4'), `${code}: ${text}`);
        assert.doesNotMatch(text, /undefined|null/, code);
    }
});

// ------------------------------------------------------------- voice (TTS)

test('voice: English uses Deepgram Aura and asks for Twilio-ready audio', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url, init });
        return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([0xff, 0x7f, 0x00]).buffer };
    };
    const tts = new TextToSpeech({ deepgramKey: 'dg-test', fetchImpl, logger: quiet });
    const r = await tts.synthesize('Hello from Jalwa', { business: { languages: { voices: {} } }, language: 'en' });
    assert.equal(r.provider, 'deepgram');
    assert.equal(r.fellBack, false);
    assert.deepEqual([...r.audio], [0xff, 0x7f, 0x00], 'μ-law bytes are passed through unchanged');
    const u = new URL(calls[0].url);
    assert.equal(u.origin + u.pathname, 'https://api.deepgram.com/v1/speak');
    assert.equal(u.searchParams.get('model'), 'aura-2-thalia-en');
    assert.equal(u.searchParams.get('encoding'), 'mulaw');
    assert.equal(u.searchParams.get('sample_rate'), '8000');
    assert.equal(u.searchParams.get('container'), 'none');
    assert.equal(calls[0].init.headers.Authorization, 'Token dg-test');
    assert.deepEqual(JSON.parse(calls[0].init.body), { text: 'Hello from Jalwa' });
});

test('voice: falls back to Google when Deepgram fails, and reports when nothing can speak', async () => {
    const failing = async () => ({ ok: false, status: 402, text: async () => 'insufficient credits' });
    const googleClient = { synthesizeSpeech: async () => [{ audioContent: Buffer.from(new Int16Array([0, 1000, -1000]).buffer) }] };
    const withGoogle = new TextToSpeech({ deepgramKey: 'dg', googleClient, fetchImpl: failing, logger: quiet });
    const r = await withGoogle.synthesize('Hi', { business: { languages: { voices: {} } }, language: 'en' });
    assert.equal(r.provider, 'google');
    assert.equal(r.fellBack, true);
    assert.equal(r.audio.length, 3, 'one μ-law byte per 16-bit sample');

    const deepgramOnly = new TextToSpeech({ deepgramKey: 'dg', fetchImpl: failing, logger: quiet });
    await assert.rejects(deepgramOnly.synthesize('Hi', { business: { languages: { voices: {} } }, language: 'en' }), /HTTP 402/);
});

test('voice: startup check names languages that have no configured voice', () => {
    const tts = new TextToSpeech({ deepgramKey: 'dg', logger: quiet }); // no Google credentials
    assert.deepEqual(tts.missingVoices({ languages: { enabled: ['en'], voices: {} } }), []);
    assert.deepEqual(tts.missingVoices({ languages: { enabled: ['en', 'hi', 'te'], voices: {} } }), ['hi', 'te']);
});

test('voice: audio is handed over piece by piece as it streams, then cached for repeats', async () => {
    let requests = 0;
    const fetchImpl = async () => {
        requests++;
        async function* body() { yield new Uint8Array(300).fill(1); yield new Uint8Array(200).fill(2); }
        return { ok: true, status: 200, body: body() };
    };
    const tts = new TextToSpeech({ deepgramKey: 'dg', fetchImpl, logger: quiet });
    const opts = { business: { languages: { voices: {} } }, language: 'en' };
    const chunks = [];
    const r = await tts.stream('Thank you for calling Jalwa.', opts, async c => chunks.push(c.length));
    assert.deepEqual(chunks, [300, 200], 'two pieces delivered as they arrived');
    assert.equal(r.cached, false);
    assert.equal(typeof r.firstAudioMs, 'number');

    const again = [];
    const r2 = await tts.stream('Thank you for calling Jalwa.', opts, async c => again.push(c.length));
    assert.equal(r2.cached, true);
    assert.deepEqual(again, [500], 'repeat line plays from memory');
    assert.equal(requests, 1, 'no second request to Deepgram');
});

test('voice: a failure after audio already played does not restart in another voice', async () => {
    const fetchImpl = async () => {
        async function* body() { yield new Uint8Array(160); throw new Error('connection reset'); }
        return { ok: true, status: 200, body: body() };
    };
    let googleUsed = false;
    const googleClient = { synthesizeSpeech: async () => { googleUsed = true; return [{ audioContent: Buffer.alloc(4) }]; } };
    const tts = new TextToSpeech({ deepgramKey: 'dg', googleClient, fetchImpl, logger: quiet });
    await assert.rejects(tts.stream('A longer reply that fails halfway', { business: { languages: { voices: {} } }, language: 'en' }, async () => {}), /connection reset/);
    assert.equal(googleUsed, false);
});

test('prompt: pickup-only business never asks pickup or delivery; short replies; closed rule', async () => {
    const { engine, llm } = await newEngine([textMsg('Sure, what would you like?')]);
    await engine.handleUtterance('I want to order');
    const prompt = llm.requests[0].messages[0].content;
    assert.match(prompt, /Every phone order is pickup; it's already set\. Never ask about pickup or delivery\./);
    assert.doesNotMatch(prompt, /ask whether it's for pickup/);
    assert.match(prompt, /about 25 words at most/);
    assert.match(prompt, /If the business details below say CLOSED, say so in one sentence/);
});

// ------------------------------------------------------------- staff email

test('email: Resend is used when its key is set, with a retry-safe idempotency key', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ id: 'em_123' }) }; };
    const svc = new EmailService({ env: { RESEND_API_KEY: 're_test' }, fetchImpl });
    assert.equal(svc.provider, 'resend');
    const r = await svc.sendOrderConfirmation(
        { type: 'order', customer_name: 'Babu', customer_phone: '(973) 555-1234', items: '1 Naan', order_summary: 'PICKUP order', timestamp: new Date().toISOString(), pickup_time: 'Tuesday, Nov 17, 5:00 PM' },
        { to: 'kitchen@jalwa.test', businessName: 'Jalwa', idempotencyKey: 'paahi-notification:n1' });
    assert.equal(r.success, true);
    assert.equal(r.messageId, 'em_123');
    assert.equal(calls[0].url, 'https://api.resend.com/emails');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer re_test');
    assert.equal(calls[0].init.headers['Idempotency-Key'], 'paahi-notification:n1');
    const body = JSON.parse(calls[0].init.body);
    assert.deepEqual(body.to, ['kitchen@jalwa.test']);
    assert.equal(body.from, '"Jalwa via Paahi" <onboarding@resend.dev>');
    assert.equal(body.subject, 'Pickup order: Babu, SCHEDULED Tuesday, Nov 17, 5:00 PM');
    assert.match(body.text, /PICKUP: SCHEDULED Tuesday, Nov 17, 5:00 PM/);
});

test('email: a Resend error is reported as a failure (so the outbox retries)', async () => {
    const fetchImpl = async () => ({ ok: false, status: 403, json: async () => ({ name: 'validation_error', message: 'You can only send testing emails to your own email address' }) });
    const svc = new EmailService({ env: { RESEND_API_KEY: 're_test' }, fetchImpl });
    const r = await svc.sendOrderConfirmation({ type: 'order', timestamp: new Date().toISOString() }, { to: 'x@y.z' });
    assert.equal(r.success, false);
    assert.match(r.error, /Resend HTTP 403: You can only send testing emails/);
});

test('staff ticket: compact, print-friendly, escaped, and says only what is true', () => {
    const biz = { id: 'jalwa-montclair', shortName: 'Jalwa', timezone: 'America/New_York' };
    const m = orderMessage(biz, {
        id: '7c1e9a42-0000-0000-0000-000000000000', call_sid: 'CA1', created_at: '2026-11-18T16:25:53Z', pickup_at: '2026-11-18T22:30:00Z',
        order_type: 'pickup', customer_name: '<b>Babu</b>', customer_phone: '9735551234', subtotal: 28, language: 'hi',
        order_notes: null, allergy_notes: 'Peanut allergy',
        items: [{ quantity: 1, name: 'Chicken Tikka Masala', size: 'regular', modifiers: [{ name: 'White Meat', price: 2 }], line_total: 28, allergy_notes: 'no nuts' }],
    });
    const html = ticketHtml(m);
    assert.match(html, /SCHEDULED Wednesday, Nov 18, 5:30 PM/);
    assert.match(html, /Placed<\/b><\/td><td>Wed, Nov 18, 11:25 AM/);
    assert.match(html, /\+ White Meat \(\$2\.00\)/);
    assert.match(html, /ALLERGY:<\/b> Peanut allergy/);
    assert.match(html, /Caller spoke:<\/b> Hindi/);
    assert.match(html, /&lt;b&gt;Babu&lt;\/b&gt;/, 'caller text is escaped');
    assert.doesNotMatch(html, /Ready in|notified|gradient|background:#(?!fff)/i, 'no invented promises, no colored blocks');
    assert.doesNotMatch(html, /[\u{1F300}-\u{1FAFF}]/u, 'no emojis');
    assert.equal(ticketSubject(m), 'Pickup order 7C1E9A42: <b>Babu</b>, SCHEDULED Wednesday, Nov 18, 5:30 PM, ALLERGY');
    assert.match(ticketText(m), /^Jalwa - PICKUP ORDER #7C1E9A42\nPICKUP: SCHEDULED Wednesday, Nov 18, 5:30 PM/);
    const asap = ticketHtml({ ...m, pickup_time: 'ASAP' });
    assert.match(asap, /PICKUP:<\/b> As soon as possible/);
});

test('missing callback number: Paahi offers Caller ID and keeps the call going instead of handing off', async () => {
    const { engine, order } = await newEngine([
        toolsMsg(toolCall('add_item', { item: 'butter chicken' }), toolCall('set_customer', { name: 'Babu' }), toolCall('read_back_order')),
        textMsg('I just need a callback number.'),
        toolsMsg(toolCall('request_human', { reason: 'Caller cannot provide a callback phone number' })),
        textMsg('No problem. Is 973-555-0000, the number you are calling from, OK?'),
    ], { callerPhone: '9735550000' });
    const first = await engine.handleUtterance('one butter chicken for Babu');
    assert.equal(first.endCall, false);
    const missing = engine.events.find(e => e.type === 'tool' && e.name === 'read_back_order');
    assert.equal(missing.error, 'missing_fields');
    const r = await engine.handleUtterance("hold on, I don't have the number yet");
    assert.equal(r.endCall, false, 'call stays up');
    assert.equal(engine.handoff, null);
    assert.ok(engine.events.some(e => e.type === 'handoff_deferred'));
    assert.match(r.say, /calling from/);
    assert.notEqual(order.phase, PHASES.HANDOFF);
});

test('pickup day words are resolved by code, late at night too', () => {
    const hours = JSON.parse(fs.readFileSync(path.join(__dirname, 'businesses', 'jalwa-montclair', 'business.json'), 'utf-8')).locations[0].hours;
    const lateWednesday = new Date('2026-11-19T03:09:42Z'); // 10:09 PM Wednesday in New York
    const opts = { now: lateWednesday, timeZone: 'America/New_York' };
    const tomorrow = checkPickupTime(hours, { day: 'tomorrow', time: '11:30 AM' }, opts);
    assert.equal(tomorrow.ok, true);
    assert.equal(tomorrow.understood, 'Thursday, Nov 19 at 11:30 AM');
    const passed = checkPickupTime(hours, { day: 'today', time: '11:30' }, opts);
    assert.equal(passed.error, 'time_has_passed');
    assert.match(passed.message, /Wednesday, Nov 18 at 11:30 AM has already passed \(it is now Wednesday, Nov 18 at 10:09 PM\)/);
    assert.equal(checkPickupTime(hours, { day: 'friday', time: '7:30 pm' }, opts).understood, 'Friday, Nov 20 at 7:30 PM');
    assert.equal(checkPickupTime(hours, { day: 'tomorrow', time: '7' }, opts).error, 'invalid_time_format', 'bare "7" is ambiguous');
});

test('voice respells names the TTS says wrong, in speech only', () => {
    const t = new TextToSpeech({});
    assert.equal(t.applyPronunciations('Thank you for calling Jalwa. See you at Jalwa!', { pronunciations: { Jalwa: 'Jahl-wah' } }),
        'Thank you for calling Jahl-wah. See you at Jahl-wah!');
    assert.equal(t.applyPronunciations('Jalwas', { pronunciations: { Jalwa: 'Jahl-wah' } }), 'Jalwas', 'whole words only');
});
