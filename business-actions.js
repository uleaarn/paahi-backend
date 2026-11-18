/**
 * Business actions: what a call is allowed to DO for one business.
 *
 *   submit(order)          -> saves the confirmed order in the database. Placed means saved.
 *   notifyCallback(...)    -> saves a staff callback request in the database.
 *   logCall(state)         -> saves the call record (stages, language, outcome; no transcript).
 *
 * Staff notifications (email, optional webhook) go into an outbox table in the
 * SAME transaction, and are delivered afterwards by the Notifier, with retries.
 * Whether the order exists and whether staff were notified are tracked separately.
 */
import { formatPhone } from './order-state.js';

const MAX_ATTEMPTS = 6;

/** Upsert a business's profile and locations so orders can reference them. */
export async function syncBusiness(db, business) {
    await db.forBusiness(business.id, async tx => {
        await tx.query(
            `insert into public.businesses (id, name) values ($1, $2)
             on conflict (id) do update set name = excluded.name, updated_at = now()`,
            [business.id, business.name]);
        for (const loc of business.locations) {
            await tx.query(
                `insert into public.locations (business_id, id, name, address, phone) values ($1, $2, $3, $4, $5)
                 on conflict (business_id, id) do update
                 set name = excluded.name, address = excluded.address, phone = excluded.phone, updated_at = now()`,
                [business.id, loc.id, loc.name || null, loc.address || null, loc.phone || null]);
        }
    });
}

/** Which notification channels this business can actually use right now. */
export function notificationChannels(business, emailService) {
    const channels = [];
    if (business.notifications.emailTo && emailService?.configured) channels.push('email');
    if (business.notifications.webhookUrl) channels.push('webhook');
    return channels;
}

export class BusinessActions {
    constructor({ business, db, notifier, emailService = null, logger = console }) {
        this.business = business;
        this.db = db;
        this.notifier = notifier;
        this.emailService = emailService;
        this.log = logger;
        this.lastDelivery = null; // promise, for tests
    }

    channels() {
        return notificationChannels(this.business, this.emailService);
    }

    describeDestinations() {
        return { database: true, notify: this.channels() };
    }

    kickDelivery() {
        // Never block the caller on email/webhook delivery.
        this.lastDelivery = this.notifier.deliverDue(this.business)
            .catch(err => this.log.error(`❌ Notification delivery (${this.business.id}):`, err.message));
        return this.lastDelivery;
    }

    /**
     * Save a confirmed order exactly once per idempotency key.
     * @returns {Promise<{success: boolean, order_id?: string, duplicate?: boolean, error?: string}>}
     */
    async submit(order, idempotencyKey, { locationId, language } = {}) {
        const channels = this.channels();
        let result;
        try {
            result = await this.db.forBusiness(this.business.id, async tx => {
                const inserted = await tx.query(
                    `insert into public.orders
                        (business_id, location_id, call_sid, idempotency_key, order_type, customer_name, customer_phone,
                         delivery_address, items, subtotal, order_notes, allergy_notes, language, confirmed_at)
                     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14)
                     on conflict (business_id, idempotency_key) do nothing
                     returning id`,
                    [this.business.id, locationId, order.call_id, idempotencyKey, order.intent,
                        order.customer.name, order.customer.phone, order.customer.delivery_address,
                        JSON.stringify(order.items.map(l => ({
                            line_id: l.line_id, menu_item_id: l.menu_item_id, name: l.name, quantity: l.quantity,
                            size: l.size, unit_price: l.unit_price, modifiers: l.modifiers, spice_level: l.spice_level,
                            allergy_notes: l.allergy_notes, special_instructions: l.special_instructions, line_total: l.line_total,
                        }))),
                        order.subtotal, order.order_notes, order.allergy_notes, language || 'en',
                        order.confirmed_at || new Date().toISOString()]);
                if (inserted.rows.length === 0) {
                    const existing = await tx.query(
                        'select id from public.orders where business_id = $1 and idempotency_key = $2', [this.business.id, idempotencyKey]);
                    return { success: true, order_id: existing.rows[0].id, duplicate: true };
                }
                const orderId = inserted.rows[0].id;
                for (const channel of channels) {
                    await tx.query(
                        'insert into public.notifications (business_id, order_id, channel) values ($1, $2, $3)',
                        [this.business.id, orderId, channel]);
                }
                return { success: true, order_id: orderId, duplicate: false };
            });
        } catch (error) {
            this.log.error(`❌ Order save failed (${this.business.id}):`, error.message);
            return { success: false, error: 'database_write_failed', detail: error.message };
        }
        this.log.log(`✅ Order saved ${result.order_id} (${this.business.id})${result.duplicate ? ' [duplicate]' : ''}; notify: ${channels.join(', ') || 'none'}`);
        if (!result.duplicate && channels.length) this.kickDelivery();
        return { ...result, notifications: result.duplicate ? 'unchanged' : (channels.length ? 'queued' : 'none_configured') };
    }

    /** Save a staff callback request. Success means it is in the database. */
    async notifyCallback({ call_id, phone, name, reason, language = null, order = null, locationId = null }) {
        const channels = this.channels();
        let result;
        try {
            result = await this.db.forBusiness(this.business.id, async tx => {
                const key = `paahi:${call_id}:callback`;
                const inserted = await tx.query(
                    `insert into public.callback_requests
                        (business_id, location_id, call_sid, idempotency_key, customer_phone, customer_name, reason, language, order_snapshot)
                     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
                     on conflict (business_id, idempotency_key) do nothing
                     returning id`,
                    [this.business.id, locationId, call_id, key, phone, name, String(reason || 'unspecified').slice(0, 200),
                        language, order ? JSON.stringify(order) : null]);
                if (inserted.rows.length === 0) return { success: true, duplicate: true };
                const id = inserted.rows[0].id;
                for (const channel of channels) {
                    await tx.query(
                        'insert into public.notifications (business_id, callback_request_id, channel) values ($1, $2, $3)',
                        [this.business.id, id, channel]);
                }
                return { success: true, callback_request_id: id, duplicate: false };
            });
        } catch (error) {
            this.log.error(`❌ Callback save failed (${this.business.id}):`, error.message);
            return { success: false, error: 'database_write_failed' };
        }
        if (!result.duplicate && channels.length) this.kickDelivery();
        return result;
    }

    /** Persist the call record. No transcript text is stored here. */
    async logCall({ callSid, locationId, routedBy, startedAt, endedAt, language, languageHistory, outcome, handoffReason, events }) {
        try {
            await this.db.forBusiness(this.business.id, tx => tx.query(
                `insert into public.calls
                    (business_id, location_id, call_sid, routed_by, started_at, ended_at, language, language_history, outcome, handoff_reason, events)
                 values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11::jsonb)
                 on conflict (business_id, call_sid) do update set
                    ended_at = excluded.ended_at, language = excluded.language, language_history = excluded.language_history,
                    outcome = excluded.outcome, handoff_reason = excluded.handoff_reason, events = excluded.events`,
                [this.business.id, locationId, callSid, routedBy, startedAt, endedAt, language,
                    JSON.stringify(languageHistory || []), outcome, handoffReason, JSON.stringify(events || [])]));
            return { success: true };
        } catch (error) {
            this.log.error(`❌ Call log failed (${this.business.id}):`, error.message);
            return { success: false };
        }
    }
}

// ---------------------------------------------------------------------------
// Notifier: delivers outbox rows for one business at a time, with retries.
// ---------------------------------------------------------------------------

function itemsText(items) {
    return items.map(l => {
        const extras = [
            l.size && l.size !== 'regular' ? l.size : null,
            l.spice_level && l.spice_level !== 'regular' ? l.spice_level.replace('_', ' ') : null,
            ...(l.modifiers || []).map(m => m.name),
            l.special_instructions,
            l.allergy_notes ? `ALLERGY: ${l.allergy_notes}` : null,
        ].filter(Boolean);
        return `${l.quantity} x ${l.name}${extras.length ? ` (${extras.join(', ')})` : ''}`;
    }).join(', ');
}

/** Message for staff. Keeps the flat fields the existing email template and n8n flows use. */
export function orderMessage(business, o) {
    const text = itemsText(o.items);
    return {
        type: 'order',
        business_id: business.id,
        business_name: business.shortName,
        order_id: o.id,
        source: 'voice_call',
        session_id: o.call_sid,
        timestamp: new Date(o.created_at).toISOString(),
        order_type: o.order_type,
        customer_name: o.customer_name,
        customer_phone: formatPhone(o.customer_phone),
        delivery_address: o.delivery_address,
        items: text,
        subtotal: Number(o.subtotal),
        order_summary: [
            `${o.order_type === 'delivery' ? 'DELIVERY' : 'PICKUP'} order`,
            `Items: ${text}`,
            o.order_notes ? `Notes: ${o.order_notes}` : null,
            o.allergy_notes ? `ALLERGY: ${o.allergy_notes}` : null,
            o.delivery_address ? `Address: ${o.delivery_address}` : null,
            `Subtotal (before tax): $${Number(o.subtotal).toFixed(2)}`,
            o.language !== 'en' ? `Caller spoke: ${o.language}` : null,
        ].filter(Boolean).join('. '),
        items_structured: o.items,
    };
}

export function callbackMessage(business, c) {
    const snap = c.order_snapshot;
    return {
        type: 'callback_request',
        business_id: business.id,
        business_name: business.shortName,
        callback_request_id: c.id,
        source: 'voice_call',
        session_id: c.call_sid,
        timestamp: new Date(c.created_at).toISOString(),
        customer_name: c.customer_name || 'Unknown caller',
        customer_phone: formatPhone(c.customer_phone),
        items: 'CALLBACK REQUEST — no order placed',
        order_summary: `Please call this customer back${c.language && c.language !== 'en' ? ` (caller's language: ${c.language})` : ''}. Reason: ${c.reason}.` +
            (snap?.items?.length ? ` Unsubmitted items they mentioned: ${snap.items.map(l => `${l.quantity} x ${l.name}`).join(', ')}.` : ''),
    };
}

export class Notifier {
    constructor({ db, emailService = null, fetchImpl = globalThis.fetch, timeoutMs = 8000, logger = console }) {
        Object.assign(this, { db, emailService, fetch: fetchImpl, timeoutMs });
        this.log = logger;
        this.timer = null;
    }

    async postWebhook(url, payload, key) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const res = await this.fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
                body: JSON.stringify(payload),
                signal: controller.signal,
            });
            return res.ok ? { success: true } : { success: false, error: `HTTP ${res.status}` };
        } catch (error) {
            return { success: false, error: error.name === 'AbortError' ? 'timeout' : error.message };
        } finally {
            clearTimeout(timer);
        }
    }

    async send(business, row, message) {
        if (row.channel === 'email') {
            if (!this.emailService?.configured || !business.notifications.emailTo) return { success: false, error: 'email_not_configured' };
            return this.emailService.sendOrderConfirmation(message, { to: business.notifications.emailTo, businessName: business.shortName });
        }
        if (row.channel === 'webhook') {
            if (!business.notifications.webhookUrl) return { success: false, error: 'webhook_not_configured' };
            return this.postWebhook(business.notifications.webhookUrl, message, `paahi-notification:${row.id}`);
        }
        return { success: false, error: 'unknown_channel' };
    }

    /** Claim due notifications for one business, deliver them, record the result. */
    async deliverDue(business, { limit = 20 } = {}) {
        const claimed = await this.db.forBusiness(business.id, async tx => (await tx.query(
            `update public.notifications n
                set status = 'sending', attempts = n.attempts + 1, next_attempt_at = now() + interval '5 minutes'
              where n.id in (
                    select id from public.notifications
                     where business_id = $1 and status in ('pending', 'failed', 'sending')
                       and attempts < $2 and next_attempt_at <= now()
                     order by created_at limit $3
                     for update skip locked)
              returning n.*`, [business.id, MAX_ATTEMPTS, limit])).rows);

        const results = [];
        for (const row of claimed) {
            let outcome;
            try {
                const message = await this.db.forBusiness(business.id, async tx => {
                    if (row.order_id) {
                        const o = (await tx.query('select * from public.orders where id = $1', [row.order_id])).rows[0];
                        return o ? orderMessage(business, o) : null;
                    }
                    const c = (await tx.query('select * from public.callback_requests where id = $1', [row.callback_request_id])).rows[0];
                    return c ? callbackMessage(business, c) : null;
                });
                outcome = message ? await this.send(business, row, message) : { success: false, error: 'record_not_found' };
            } catch (error) {
                outcome = { success: false, error: error.message };
            }
            const backoffMinutes = 2 ** row.attempts;
            await this.db.forBusiness(business.id, tx => tx.query(
                outcome.success
                    ? `update public.notifications set status = 'sent', sent_at = now(), last_error = null where id = $1`
                    : `update public.notifications set status = 'failed', last_error = $2,
                              next_attempt_at = now() + make_interval(mins => $3) where id = $1`,
                outcome.success ? [row.id] : [row.id, String(outcome.error || 'unknown').slice(0, 300), backoffMinutes]));
            results.push({ id: row.id, channel: row.channel, success: Boolean(outcome.success), error: outcome.error });
            this.log.log(`${outcome.success ? '📨' : '⚠️'} ${business.id} ${row.channel} notification ${outcome.success ? 'sent' : `failed (attempt ${row.attempts}): ${outcome.error}`}`);
        }
        return results;
    }

    /** Retry loop over all businesses (each in its own tenant-scoped transactions). */
    start(listBusinesses, intervalMs = 60000) {
        this.stop();
        this.timer = setInterval(async () => {
            for (const business of listBusinesses()) {
                try { await this.deliverDue(business); } catch (e) { this.log.error(`❌ Retry loop (${business.id}):`, e.message); }
            }
        }, intervalMs);
        this.timer.unref?.();
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }
}
