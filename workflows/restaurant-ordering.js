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
import { MenuService, checkPickupTime, nextOpening, zonedParts } from '../menu-service.js';
import { OrderState, PHASES } from '../order-state.js';

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
        description: 'Record when the caller will pick up. Use asap:true for as soon as possible (only while open), or date + time for a scheduled pickup. Convert what the caller said ("tomorrow at 7", "6:30 tonight") into the business local date and 24-hour time.',
        parameters: {
            type: 'object',
            properties: {
                asap: { type: 'boolean' },
                date: { type: 'string', description: 'YYYY-MM-DD, business local date.' },
                time: { type: 'string', description: 'HH:MM, 24-hour, business local time.' },
            },
        },
        schedulingOnly: true,
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

export function createSession({ prepared, callId, clock, submitter, business, location }) {
    return new RestaurantOrderingSession({ prepared, callId, clock, submitter, business, location });
}

class RestaurantOrderingSession {
    constructor({ prepared, callId, clock, submitter, business, location }) {
        this.id = id;
        this.locationId = location?.id || null;
        this.hours = location?.hours || null;
        this.timeZone = business?.timezone || 'America/New_York';
        this.clock = clock || (() => new Date());
        this.menu = prepared.menu;
        this.orderTypes = prepared.orderTypes;
        this.scheduling = prepared.scheduling || null;
        this.submitter = submitter;
        this.order = new OrderState({
            callId,
            menu: this.menu,
            deliveryEnabled: this.orderTypes.includes('delivery'),
            clock: this.clock,
            timeZone: this.timeZone,
        });
        if (this.orderTypes.length === 1) this.order.setIntent(this.orderTypes[0]);
        this.readbackTurn = null;
        this.tools = toolDefs({ scheduling: Boolean(this.scheduling) });
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
        return [
            `Today is ${today.day} ${today.date} (business local time). Scheduled pickup: allowed up to ${this.scheduling.max_days_ahead} days ahead, during opening hours, at least ${this.scheduling.min_lead_minutes} minutes from now.`,
            'If the caller wants it later or names a time, call set_pickup_time with date and time. While open and no time is given, pickup is as soon as possible.',
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

    isComplete() {
        return this.order.phase === PHASES.SUBMITTED;
    }

    contactPhone() {
        return this.order.data.customer.phone;
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
                if (args.asap && !(args.date && args.time)) {
                    if (closed) {
                        const next = this.nextOpeningLabel();
                        return { forModel: { ok: false, error: 'closed_now', message: `Closed now${next ? `; next opening ${next}` : ''}. Ask what time after opening they'd like to pick up.` } };
                    }
                    return { forModel: order.setPickupTime(null) };
                }
                const check = checkPickupTime(this.hours, { date: args.date, time: args.time }, {
                    now: this.clock(), timeZone: this.timeZone,
                    minLeadMinutes: this.scheduling.min_lead_minutes, maxDaysAhead: this.scheduling.max_days_ahead,
                });
                if (!check.ok) return { forModel: check };
                return { forModel: order.setPickupTime(check.at) };
            }
            case 'set_order_type': return { forModel: order.setIntent(args.type) };
            case 'add_item': return { forModel: order.addItem(args) };
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
                if (!result.ok) return { forModel: result };
                this.readbackTurn = ctx.turn;
                return {
                    forModel: { ok: true, note: 'Readback spoken to caller. Wait for their answer.' },
                    outcome: { say: result.say_exactly, endCall: false, handoff: false },
                };
            }
            case 'confirm_and_submit_order': {
                // The caller must have heard the readback on an earlier turn.
                if (this.readbackTurn === null || this.readbackTurn >= ctx.turn) {
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
            ctx.event('order_submitted', { duplicate: Boolean(result.duplicate), order_id: result.order_id, notifications: result.notifications });
            return { say: ctx.phrases.orderPlaced(snapshot.customer.name, ctx.businessName), endCall: true, handoff: false };
        }
        this.order.markSubmissionFailed(result);
        ctx.event('order_submit_failed', { error: result.error });
        return { failToCallback: 'submission_failed' };
    }
}
