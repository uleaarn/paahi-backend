/**
 * Workflow: restaurant phone ordering (pickup, optionally delivery).
 *
 * A workflow module exports:
 *   id                       stable id used in business.json "workflows"
 *   prepare(config, ctx)     validate config and load this business's data once at startup
 *   createSession(opts)      per-call state; returns an object with:
 *       tools                OpenAI-style tool definitions this workflow adds
 *       promptSection()      workflow instructions + live state for the model
 *       runTool(name, args, ctx) -> { forModel, outcome? }
 *       hasUnfinishedWork()  true if ending the call now would lose something
 *       isComplete()         true once the workflow's action is done
 *       contactPhone()       a callback number the caller gave, if any
 *       onHandoff(reason)
 *       snapshot()           structured, language-neutral record for logs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { MenuService, checkPickupTime, nextOpening, zonedParts, earliestPickup, whenText } from '../menu-service.js';
import { orderRef } from '../staff-ticket.js';
import { isExplicitConfirmation } from '../languages.js';
import { OrderState, PHASES, formatPhone, normalizePhone, speakPhone } from '../order-state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INSTRUCTIONS = fs.readFileSync(path.join(__dirname, 'restaurant-ordering.md'), 'utf-8');

export const id = 'restaurant_ordering';

const ORDER_TYPES = ['pickup', 'delivery'];

// While the location is closed these tools are blocked, unless the business
// takes scheduled orders (then the order just needs a pickup time after opening).
const BLOCKED_WHEN_CLOSED = new Set(['set_order_type', 'add_item', 'update_item', 'remove_item', 'read_back_order', 'confirm_and_submit_order']);

const SCHEDULE_DEFAULTS = { min_lead_minutes: 20, max_days_ahead: 7 };

const itemOptionProps = {
    quantity: { type: 'integer', minimum: 1, description: 'How many. Default 1.' },
    size: { type: 'string', description: 'Size name if the item has sizes (e.g. half, full, large).' },
    modifiers: { type: 'array', items: { type: 'string' }, description: 'Changes like "no onion", "extra garlic", "butter".' },
    spice_level: { type: 'string', enum: ['mild', 'regular', 'extra_spicy'], description: 'Only if the caller asked.' },
    special_instructions: { type: 'string', description: 'Short kitchen note for this item.' },
    allergy_notes: { type: 'string', description: 'Allergy the caller mentioned for this item.' },
};

const TOOLS = [
    {
        name: 'set_order_type',
        description: 'Record whether the order is for pickup or delivery.',
        parameters: { type: 'object', properties: { type: { type: 'string', enum: ORDER_TYPES } }, required: ['type'] },
    },
    {
        name: 'add_item',
        description: 'Add a menu item to the order, using the caller\'s words for the dish.',
        parameters: { type: 'object', properties: { item: { type: 'string', description: 'Dish name as the caller said it.' }, ...itemOptionProps }, required: ['item'] },
    },
    {
        name: 'update_item',
        description: 'Change quantity, size, spice, modifiers or notes on an existing line. Omitted fields stay the same. modifiers replaces the whole list.',
        parameters: { type: 'object', properties: { line_id: { type: 'string' }, ...itemOptionProps }, required: ['line_id'] },
    },
    {
        name: 'remove_item',
        description: 'Remove a line from the order.',
        parameters: { type: 'object', properties: { line_id: { type: 'string' } }, required: ['line_id'] },
    },
    {
        name: 'set_customer',
        description: 'Record the customer name, callback phone number, or delivery address. Send only what the caller just gave.',
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string' },
                phone: { type: 'string', description: 'Digits as heard.' },
                delivery_address: { type: 'string' },
            },
        },
    },
    {
        name: 'set_notes',
        description: 'Record an order-wide note or an allergy the caller mentioned.',
        parameters: { type: 'object', properties: { order_notes: { type: 'string' }, allergy_notes: { type: 'string' } } },
    },
    {
        name: 'lookup_menu_item',
        description: 'Look up a dish to answer a question about it (description, price, sizes, options).',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
    {
        name: 'set_pickup_time',
        description: 'Record when the caller will pick up. asap:true = as soon as possible (only while open). Otherwise give day and time exactly as the caller said them; the system works out the date.',
        parameters: {
            type: 'object',
            properties: {
                asap: { type: 'boolean' },
                day: { type: 'string', description: '"today", "tomorrow", or a weekday name like "friday". Use YYYY-MM-DD only if the caller gave a date.' },
                time: { type: 'string', description: 'Clock time, e.g. "11:30 AM" or "19:00".' },
            },
        },
        schedulingOnly: true,
    },
    {
        name: 'find_my_orders',
        description: 'Look up the caller\'s existing orders (placed earlier, still to be picked up) by callback number. Uses the Caller ID unless the caller gives another number; then their name is needed too.',
        parameters: {
            type: 'object',
            properties: {
                phone: { type: 'string', description: 'Only if the caller gave a number different from the Caller ID.' },
                name: { type: 'string', description: 'Name on the order (needed with a different number).' },
            },
        },
    },
    {
        name: 'cancel_order',
        description: 'Cancel one order found by find_my_orders, ONLY after the caller clearly said yes to cancelling that order. Staff are told.',
        parameters: { type: 'object', properties: { order_number: { type: 'string', description: 'The order number from find_my_orders, e.g. "7C1E".' } }, required: ['order_number'] },
    },
    {
        name: 'read_back_order',
        description: 'When nothing is missing, read the full order back to the caller. The system speaks it.',
        parameters: { type: 'object', properties: {} },
    },
    {
        name: 'confirm_and_submit_order',
        description: 'Call ONLY right after the caller clearly said yes to the readback. Sends the order to the business.',
        parameters: { type: 'object', properties: {} },
    },
];

const toolDefs = ({ scheduling }) => TOOLS
    .filter(fn => scheduling || !fn.schedulingOnly)
    .map(({ schedulingOnly, ...fn }) => ({ type: 'function', function: fn }));

/** Validate config and load the menu, once per business at startup. */
export function prepare(config, { businessDir }) {
    const errors = [];
    const orderTypes = config.order_types || ['pickup'];
    if (!Array.isArray(orderTypes) || orderTypes.length === 0 || orderTypes.some(t => !ORDER_TYPES.includes(t))) {
        errors.push(`order_types must be a non-empty list of ${ORDER_TYPES.join('/')}`);
    }
    if (orderTypes.includes('delivery') && !config.delivery) {
        // Delivery needs real rules (area, fee, minimum) before it can be offered.
        errors.push('delivery is listed in order_types but no "delivery" rules are configured');
    }
    if (!config.menu_file) errors.push('menu_file is required');
    let scheduling = null;
    if (config.scheduled_orders?.enabled) {
        scheduling = { ...SCHEDULE_DEFAULTS, ...config.scheduled_orders };
        for (const k of ['min_lead_minutes', 'max_days_ahead']) {
            if (!Number.isInteger(scheduling[k]) || scheduling[k] < 0) errors.push(`scheduled_orders.${k} must be a whole number`);
        }
    }

    let menu = null;
    if (config.menu_file) {
        const menuPath = path.resolve(businessDir, config.menu_file);
        if (!menuPath.startsWith(path.resolve(businessDir) + path.sep)) {
            errors.push('menu_file must be inside the business folder');
        } else {
            try {
                menu = new MenuService(JSON.parse(fs.readFileSync(menuPath, 'utf-8')));
            } catch (error) {
                errors.push(`could not load menu_file: ${error.message}`);
            }
        }
    }
    if (errors.length) return { errors };
    return {
        errors: [],
        prepared: { menu, orderTypes, delivery: config.delivery || null, scheduling },
        warnings: menu.undefinedModifierIds().length
            ? [`menu modifiers used by items but not defined (treated as free): ${menu.undefinedModifierIds().join(', ')}`]
            : [],
    };
}

/** What to do when the order only lacks a callback number. */
function phoneHint(callerPhone) {
    return callerPhone
        ? `Caller ID is ${formatPhone(callerPhone)}. Ask if that number is OK for the order; on yes, call set_customer with it. If they want a different number and need a moment, wait. A missing number is never a reason to hand off or end the call.`
        : 'Ask for a callback number. If they need a moment to find it, wait. A missing number is never a reason to hand off or end the call.';
}

export function createSession({ prepared, callId, clock, submitter, business, location, callerPhone }) {
    return new RestaurantOrderingSession({ prepared, callId, clock, submitter, business, location, callerPhone });
}

class RestaurantOrderingSession {
    constructor({ prepared, callId, clock, submitter, business, location, callerPhone }) {
        this.id = id;
        this.callId = callId;
        this.callerPhone = normalizePhone(callerPhone);
        this.taxRatePercent = business?.taxRatePercent ?? null;
        this.foundOrders = new Map(); // order number -> order id, from find_my_orders in this call
        this.placedOrders = [];       // orders placed in this call: { ref, id }
        this.locationId = location?.id || null;
        this.hours = location?.hours || null;
        this.timeZone = business?.timezone || 'America/New_York';
        this.clock = clock || (() => new Date());
        this.menu = prepared.menu;
        this.orderTypes = prepared.orderTypes;
        this.scheduling = prepared.scheduling || null;
        this.submitter = submitter;
        this.order = this.newOrder(1);
        this.readbackTurn = null;
        this.tools = toolDefs({ scheduling: Boolean(this.scheduling) });
    }

    /** A fresh order. The callback number starts as the Caller ID; the readback says it, so the caller can change it. */
    newOrder(index, previous = null) {
        const order = new OrderState({
            callId: this.callId,
            menu: this.menu,
            deliveryEnabled: this.orderTypes.includes('delivery'),
            clock: this.clock,
            timeZone: this.timeZone,
            taxRatePercent: this.taxRatePercent,
            orderIndex: index,
        });
        if (this.orderTypes.length === 1) order.setIntent(this.orderTypes[0]);
        const phone = previous?.data.customer.phone || this.callerPhone;
        if (phone) order.setCustomer({ phone });
        if (previous?.data.customer.name) order.setCustomer({ name: previous.data.customer.name });
        return order;
    }

    /** Orders for this caller's number, labelled for the caller and remembered by order number. */
    async lookupOrders(phone) {
        if (!this.submitter.findOrders) return [];
        const rows = await this.submitter.findOrders({ phone, now: this.clock() });
        return rows.map(r => {
            const ref = orderRef(r.id);
            this.foundOrders.set(ref, r.id);
            return {
                order_number: ref,
                name: r.customer_name,
                pickup: r.pickup_at ? whenText(new Date(r.pickup_at), this.timeZone) : `as soon as possible (ordered ${whenText(new Date(r.created_at), this.timeZone)})`,
                items: (r.items || []).map(l => `${l.quantity} x ${l.name}`).join(', '),
                subtotal: Number(r.subtotal),
                placed_in_this_call: r.call_sid === this.callId,
                _pickupDay: zonedParts(new Date(r.pickup_at || r.created_at), this.timeZone).date,
            };
        });
    }

    earliestLabel() {
        if (!this.scheduling) return null;
        const at = earliestPickup(this.hours, this.clock(), this.timeZone, {
            minLeadMinutes: this.scheduling.min_lead_minutes, maxDaysAhead: this.scheduling.max_days_ahead,
        });
        return at ? whenText(at, this.timeZone) : null;
    }

    nextOpeningLabel() {
        const at = nextOpening(this.hours, this.clock(), this.timeZone, 7);
        if (!at) return null;
        return new Intl.DateTimeFormat('en-US', { timeZone: this.timeZone, weekday: 'long', hour: 'numeric', minute: '2-digit' }).format(at);
    }

    schedulingSection() {
        if (!this.scheduling) {
            return 'Scheduled orders: not offered. Orders are for pickup as soon as possible while open.';
        }
        const today = zonedParts(this.clock(), this.timeZone);
        const earliest = this.earliestLabel();
        return [
            `Today is ${today.day} ${today.date} (business local time). Scheduled pickup: allowed up to ${this.scheduling.max_days_ahead} days ahead, during opening hours, at least ${this.scheduling.min_lead_minutes} minutes from now.${earliest ? ` Earliest possible pickup: ${earliest}. If the caller asks for "as soon as possible" or a time before that, offer this time.` : ''}`,
            'If the caller wants it later or names a time, call set_pickup_time with day ("today", "tomorrow", a weekday) and time. Don\'t work out dates yourself. While open and no time is given, pickup is as soon as possible.',
        ].join('\n');
    }

    promptSection() {
        const typesText = this.orderTypes.join(' or ');
        const instructions = INSTRUCTIONS
            .replaceAll('{{ORDER_TYPE_STEP}}', this.orderTypes.length === 1
                ? `Every phone order is ${this.orderTypes[0]}; it's already set. Never ask about pickup or delivery.`
                : `If you don't know yet, ask whether it's for ${typesText}. Call set_order_type.`)
            .replaceAll('{{ADDRESS_STEP}}', this.orderTypes.includes('delivery') ? ', then the delivery address if it is delivery' : '');
        return [
            instructions,
            `Phone orders accepted: ${typesText} only.`,
            this.schedulingSection(),
            '',
            'MENU (names and prices; use lookup_menu_item for details):',
            this.menu.compactMenuText(),
            '',
            'Current order:',
            JSON.stringify(this.order.summaryForModel()),
        ].join('\n');
    }

    hasUnfinishedWork() {
        return this.order.data.items.length > 0 && this.order.phase !== PHASES.SUBMITTED;
    }

    /** After an order is placed, adding food starts a second order (same name and number). */
    startAnotherOrderIfPlaced() {
        if (this.order.phase !== PHASES.SUBMITTED) return;
        this.order = this.newOrder(this.order.orderIndex + 1, this.order);
        this.readbackTurn = null;
    }

    isComplete() {
        return this.order.phase === PHASES.SUBMITTED;
    }

    contactPhone() {
        return this.order.data.customer.phone;
    }

    missingFields() {
        return this.order.missingFields();
    }

    /** Readback cut off by the caller: it has to be read again before confirming. */
    onReadbackInterrupted() {
        if (this.order.phase !== PHASES.AWAITING_CONFIRMATION) return false;
        this.order.data.status = PHASES.COLLECTING;
        this.order.data.confirmation_status = 'not_confirmed';
        this.order.readbackVersion = null;
        this.order.readbackInterrupted = true;
        this.readbackTurn = null;
        return true;
    }

    contactName() {
        return this.order.data.customer.name;
    }

    onHandoff(reason) {
        this.order.markHandoff(reason);
    }

    onEnd() {
        this.order.markEnded();
    }

    snapshot() {
        return this.order.snapshot();
    }

    /**
     * @param ctx { turn, lastUserUtterance, language, phrases, isOpen, businessName, event }
     */
    async runTool(name, args, ctx) {
        const closed = ctx.isOpen === false;
        // Closed now: an order is still possible if it's scheduled for after opening.
        this.order.requireScheduledTime = closed && Boolean(this.scheduling);
        if (BLOCKED_WHEN_CLOSED.has(name) && closed && !this.scheduling) {
            const next = this.nextOpeningLabel();
            return { forModel: { ok: false, error: 'business_closed', message: `Closed now${next ? `; next opening ${next}` : ''}. Tell the caller; do not take an order.` } };
        }
        const order = this.order;
        switch (name) {
            case 'set_pickup_time': {
                if (!this.scheduling) return { forModel: { ok: false, error: 'scheduling_not_offered' } };
                if (args.asap && !((args.day || args.date) && args.time)) {
                    if (closed) {
                        const next = this.nextOpeningLabel();
                        return { forModel: { ok: false, error: 'closed_now', message: `Closed now${next ? `; next opening ${next}` : ''}. Ask what time after opening they'd like to pick up.` } };
                    }
                    return { forModel: order.setPickupTime(null) };
                }
                const check = checkPickupTime(this.hours, { day: args.day, date: args.date, time: args.time }, {
                    now: this.clock(), timeZone: this.timeZone,
                    minLeadMinutes: this.scheduling.min_lead_minutes, maxDaysAhead: this.scheduling.max_days_ahead,
                });
                if (!check.ok) {
                    const earliest = this.earliestLabel();
                    return { forModel: earliest && check.error !== 'invalid_time_format' ? { ...check, earliest_possible: earliest } : check };
                }
                return { forModel: order.setPickupTime(check.at) };
            }
            case 'set_order_type': return { forModel: order.setIntent(args.type) };
            case 'add_item':
                this.startAnotherOrderIfPlaced();
                return { forModel: this.order.addItem(args) };
            case 'find_my_orders': {
                let phone = this.order.data.customer.phone || this.callerPhone;
                const asked = args.phone ? normalizePhone(args.phone) : null;
                if (args.phone && !asked) return { forModel: { ok: false, error: 'invalid_phone' } };
                // A number other than the one they're calling from needs the name on the order too.
                const needsName = asked && asked !== this.callerPhone;
                if (asked) phone = asked;
                if (!phone) return { forModel: { ok: false, error: 'phone_needed', message: 'Ask for the callback number used on the order.' } };
                if (needsName && !args.name) return { forModel: { ok: false, error: 'name_needed', message: 'Ask for the name on the order.' } };
                let found = await this.lookupOrders(phone);
                if (needsName) {
                    const first = s => String(s || '').trim().toLowerCase().split(/\s+/)[0];
                    found = found.filter(o => first(o.name) === first(args.name));
                }
                ctx.event('orders_looked_up', { found: found.length });
                const clean = found.map(({ _pickupDay, ...o }) => o);
                return {
                    forModel: {
                        ok: true,
                        phone: formatPhone(phone),
                        orders: clean,
                        message: clean.length
                            ? 'Read each order to the caller: order number, pickup time and items. To cancel one, ask them to confirm, then call cancel_order.'
                            : `No open orders for ${formatPhone(phone)}. Tell the caller, and ask if it may be under another number.`,
                    },
                };
            }
            case 'cancel_order': {
                const ref = String(args.order_number || '').replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 4);
                const orderId = this.foundOrders.get(ref);
                if (!orderId) return { forModel: { ok: false, error: 'unknown_order_number', message: 'Only orders found with find_my_orders in this call can be cancelled. Look them up first.' } };
                const said = String(ctx.lastUserUtterance || '');
                if (!/cancel|cancela|annul/i.test(said) && !isExplicitConfirmation(said, ctx.language)) {
                    return { forModel: { ok: false, error: 'cancel_not_confirmed', message: `Ask: "Should I cancel order ${ref}?" and wait for a clear yes.` } };
                }
                const r = await this.submitter.cancelOrder({ orderId });
                if (!r.success) return { forModel: { ok: false, error: r.error, message: r.error === 'not_cancellable' ? 'That order is already cancelled or finished.' : 'Could not cancel it. Offer a staff callback with request_human.' } };
                this.foundOrders.delete(ref);
                ctx.event('order_cancelled', { order_number: ref });
                return { forModel: { ok: true, cancelled: ref, message: `Tell the caller: "Order ${ref} is cancelled." Then say which of their orders remain (if any), and ask if there's anything else.` } };
            }
            case 'update_item': return { forModel: order.updateItem(args) };
            case 'remove_item': return { forModel: order.removeItem(args) };
            case 'set_customer': return { forModel: order.setCustomer(args) };
            case 'set_notes': return { forModel: order.setNotes(args) };
            case 'lookup_menu_item': {
                const found = this.menu.findItem(args.query);
                return {
                    forModel: found.status === 'matched'
                        ? { ok: true, item: this.menu.describe(found.item) }
                        : { ok: false, error: found.status, candidates: found.candidates.map(c => c.name) },
                };
            }
            case 'read_back_order': {
                const result = order.readBack(ctx.language);
                if (!result.ok) {
                    if (result.missing?.includes('customer_phone')) result.hint = phoneHint(ctx.callerPhone);
                    return { forModel: result };
                }
                this.readbackTurn = ctx.turn;
                const forModel = { ok: true, note: 'Readback spoken to caller. Wait for their answer.' };
                // Possible duplicate: this number already has an order for the same day.
                try {
                    const day = zonedParts(order.data.requested_time ? new Date(order.data.requested_time) : this.clock(), this.timeZone).date;
                    const same = (await this.lookupOrders(order.data.customer.phone)).filter(o => o._pickupDay === day && !o.placed_in_this_call);
                    if (same.length) {
                        forModel.existing_orders_same_day = same.map(({ _pickupDay, ...o }) => o);
                        forModel.note = 'Readback spoken. This number already has an order for that day (existing_orders_same_day). When the caller answers, ask whether this new order is in addition to it or replaces it. If it replaces it: place this one, then cancel the old one with cancel_order after they confirm.';
                        ctx.event('possible_duplicate', { count: same.length });
                    }
                } catch { /* lookup is a courtesy; never block the order */ }
                return {
                    forModel,
                    outcome: { say: result.say_exactly, endCall: false, handoff: false, readback: true },
                };
            }
            case 'confirm_and_submit_order': {
                // The caller must have heard the readback on an earlier turn.
                if (this.readbackTurn === null || this.readbackTurn >= ctx.turn) {
                    if (order.readbackInterrupted) {
                        return { forModel: { ok: false, error: 'readback_was_interrupted', message: 'The caller talked over the readback, so they did not hear all of it (including the total). Call read_back_order again.' } };
                    }
                    return { forModel: { ok: false, error: 'caller_has_not_heard_readback', message: 'Call read_back_order and wait for the caller to answer.' } };
                }
                const confirmed = order.confirm({ callerUtterance: ctx.lastUserUtterance, language: ctx.language });
                if (!confirmed.ok) return { forModel: confirmed };
                const rt = order.data.requested_time;
                if (rt && new Date(rt).getTime() <= this.clock().getTime()) {
                    // The scheduled time passed during the call; it must be set again.
                    order.data.status = PHASES.COLLECTING;
                    order.data.confirmation_status = 'not_confirmed';
                    order.data.requested_time = null;
                    order.touch();
                    return { forModel: { ok: false, error: 'pickup_time_passed', message: 'That pickup time has passed. Ask for a new time.' } };
                }
                ctx.event('order_confirmed');
                return { forModel: { ok: true, note: 'Handled by system.' }, outcome: await this.submit(ctx) };
            }
            default:
                return null; // not this workflow's tool
        }
    }

    async submit(ctx) {
        const snapshot = this.order.snapshot();
        // Placed means saved in the database; staff notification follows separately.
        const result = await this.submitter.submit(snapshot, this.order.idempotencyKey(), { locationId: this.locationId, language: ctx.language });
        if (result.success) {
            this.order.markSubmitted(result);
            const ref = orderRef(result.order_id);
            this.placedOrders.push({ ref, id: result.order_id });
            this.foundOrders.set(ref, result.order_id); // the caller may change their mind in this call
            ctx.event('order_submitted', { duplicate: Boolean(result.duplicate), order_id: result.order_id, notifications: result.notifications });
            const p = ctx.phrases;
            const say = p.orderPlaced({
                name: snapshot.customer.name,
                ref: ref.split('').join(' '),
                when: this.order.pickupLabel(ctx.language),
                subtotal: p.money(snapshot.subtotal),
                total: this.taxRatePercent ? p.money(this.order.totalWithTax()) : null,
            });
            // The call stays open: the caller hears the confirmation and can ask for anything else.
            return { say, endCall: false, handoff: false };
        }
        this.order.markSubmissionFailed(result);
        ctx.event('order_submit_failed', { error: result.error });
        return { failToCallback: 'submission_failed' };
    }
}
