/**
 * Order state: deterministic, validated, and the only source of truth for
 * what the caller has ordered. The model proposes changes through tools;
 * this code decides whether they are valid.
 */

import { phrases, isExplicitConfirmation } from './languages.js';

export const PHASES = Object.freeze({
    COLLECTING: 'collecting',
    AWAITING_CONFIRMATION: 'awaiting_confirmation', // readback given, waiting for "yes"
    CONFIRMED: 'confirmed',                         // caller said yes, submission in progress
    SUBMITTED: 'submitted',
    HANDOFF: 'handoff',
    ENDED: 'ended',
});

export const MAX_QUANTITY_PER_LINE = 20;
const MAX_TEXT = 200;

export { isExplicitConfirmation };

export function normalizePhone(raw) {
    let digits = String(raw || '').replace(/\D/g, '');
    if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
    if (digits.length !== 10) return null;
    return digits;
}

export function formatPhone(digits) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

/** Phone number spelled out for text-to-speech: "9 7 3, 2 5 0, 6 3 6 4" */
export function speakPhone(digits) {
    const d = digits.split('');
    return `${d.slice(0, 3).join(' ')}, ${d.slice(3, 6).join(' ')}, ${d.slice(6).join(' ')}`;
}

function cleanText(value) {
    if (value === null || value === undefined) return null;
    const text = String(value).trim().slice(0, MAX_TEXT);
    return text || null;
}

function money(n) {
    return Math.round(n * 100) / 100;
}


export class OrderState {
    /**
     * @param {object} opts
     * @param {string} opts.callId
     * @param {import('./menu-service.js').MenuService} opts.menu
     * @param {boolean} [opts.deliveryEnabled]
     * @param {() => Date} [opts.clock]
     */
    constructor({ callId, menu, deliveryEnabled = false, clock = () => new Date(), timeZone = 'America/New_York' }) {
        this.menu = menu;
        this.deliveryEnabled = deliveryEnabled;
        this.clock = clock;
        this.timeZone = timeZone;
        // Set by the workflow while the business is closed: the order needs a later pickup time.
        this.requireScheduledTime = false;
        this.nextLine = 1;
        this.version = 0;            // bumps on every change to the order
        this.readbackVersion = null; // version the caller heard read back

        const now = clock().toISOString();
        this.data = {
            call_id: callId,
            status: PHASES.COLLECTING,
            intent: 'unknown',
            customer: { name: null, phone: null, delivery_address: null },
            items: [],
            order_notes: null,
            allergy_notes: null,
            requested_time: null,
            subtotal: 0,
            confirmation_status: 'not_confirmed',
            handoff_reason: null,
            submission: null,
            created_at: now,
            updated_at: now,
        };
    }

    get phase() { return this.data.status; }

    isLocked() {
        return [PHASES.CONFIRMED, PHASES.SUBMITTED, PHASES.HANDOFF, PHASES.ENDED].includes(this.phase);
    }

    /** Any change after a readback means the caller must hear it again. */
    touch() {
        this.version += 1;
        this.data.updated_at = this.clock().toISOString();
        this.recalculate();
        if (this.phase === PHASES.AWAITING_CONFIRMATION) {
            this.data.status = PHASES.COLLECTING;
            this.data.confirmation_status = 'not_confirmed';
        }
    }

    locked() {
        return { ok: false, error: 'order_locked', message: `Order is ${this.phase}; it can no longer be changed.` };
    }

    recalculate() {
        let subtotal = 0;
        for (const line of this.data.items) {
            line.line_total = money(line.quantity * (line.unit_price + line.modifiers.reduce((s, m) => s + m.price, 0)));
            subtotal += line.line_total;
        }
        this.data.subtotal = money(subtotal);
    }

    // ------------------------------------------------------------------
    // Changes proposed by the model
    // ------------------------------------------------------------------

    setIntent(intent) {
        const allowed = ['pickup', 'delivery', 'menu_question', 'human_help', 'unknown'];
        if (!allowed.includes(intent)) return { ok: false, error: 'invalid_intent', options: allowed };
        if (this.isLocked()) return this.locked();
        if (intent === 'delivery' && !this.deliveryEnabled) {
            return {
                ok: false,
                error: 'delivery_not_available',
                message: 'Phone delivery orders are not enabled. Offer pickup, or a callback from staff.',
            };
        }
        const changed = this.data.intent !== intent;
        this.data.intent = intent;
        if (changed && (intent === 'pickup' || intent === 'delivery')) this.touch();
        return { ok: true, intent };
    }

    validateQuantity(quantity) {
        const q = Number(quantity ?? 1);
        if (!Number.isInteger(q) || q < 1) return { ok: false, error: 'invalid_quantity', message: 'Quantity must be a whole number of at least 1.' };
        if (q > MAX_QUANTITY_PER_LINE) {
            return { ok: false, error: 'quantity_too_large', message: `More than ${MAX_QUANTITY_PER_LINE} of one item needs staff to confirm. Offer a staff callback.` };
        }
        return { ok: true, quantity: q };
    }

    resolveLineOptions(item, { size, modifiers, spice_level }) {
        const sizeResult = this.menu.resolveSize(item, size);
        if (!sizeResult.ok) return { ...sizeResult, item: item.name };

        const resolved = [];
        for (const raw of modifiers || []) {
            // The model sometimes sends spice as a modifier; route it to spice.
            const spiceTry = this.menu.resolveSpice(item, raw);
            if (spiceTry.ok && spiceTry.spice && !spice_level) { spice_level = spiceTry.spice; continue; }
            const mod = this.menu.resolveModifier(item, raw);
            if (!mod.ok) return { ...mod, item: item.name, requested: raw };
            if (!resolved.some(m => m.id === mod.modifier.id)) resolved.push(mod.modifier);
        }

        const spice = this.menu.resolveSpice(item, spice_level);
        if (!spice.ok) return { ...spice, item: item.name, requested: spice_level };

        return { ok: true, size: sizeResult.size, modifiers: resolved, spice: spice.spice };
    }

    addItem({ item, quantity, size, modifiers, spice_level, special_instructions, allergy_notes } = {}) {
        if (this.isLocked()) return this.locked();
        const found = this.menu.findItem(item);
        if (found.status === 'ambiguous') {
            return { ok: false, error: 'ambiguous_item', requested: item, candidates: found.candidates.map(c => c.name) };
        }
        if (found.status !== 'matched') {
            return { ok: false, error: 'item_not_on_menu', requested: item, closest: found.candidates.map(c => c.name) };
        }
        const when = this.data.requested_time ? new Date(this.data.requested_time) : this.clock();
        const avail = this.menu.availability(found.item, when, this.timeZone);
        if (!avail.ok) return avail;
        const qty = this.validateQuantity(quantity);
        if (!qty.ok) return qty;
        const opts = this.resolveLineOptions(found.item, { size, modifiers, spice_level });
        if (!opts.ok) return opts;

        const line = {
            line_id: `L${this.nextLine++}`,
            menu_item_id: found.item.id,
            name: found.item.name,
            quantity: qty.quantity,
            size: opts.size.name,
            unit_price: opts.size.price,
            modifiers: opts.modifiers,
            spice_level: opts.spice,
            allergy_notes: cleanText(allergy_notes),
            special_instructions: cleanText(special_instructions),
            line_total: 0,
        };
        this.data.items.push(line);
        this.touch();
        return { ok: true, added: this.describeLine(line), line_id: line.line_id, subtotal: this.data.subtotal };
    }

    /**
     * Record a scheduled pickup time (a Date already checked against opening
     * hours by the workflow), or null for as soon as possible.
     * Items that can't be had at that time (e.g. lunch specials) block the change.
     */
    setPickupTime(at) {
        if (this.isLocked()) return this.locked();
        const when = at || this.clock();
        const unavailable = this.data.items
            .map(l => this.menu.availability(this.menu.getItem(l.menu_item_id), when, this.timeZone))
            .filter(r => !r.ok);
        if (unavailable.length) {
            return { ok: false, error: 'items_not_available_at_that_time', items: unavailable.map(u => `${u.item} (${u.available})`) };
        }
        const iso = at ? at.toISOString() : null;
        if (iso !== this.data.requested_time) {
            this.data.requested_time = iso;
            this.touch();
        }
        return { ok: true, pickup_time: iso ? this.pickupLabel('en') : 'as soon as possible' };
    }

    /** "today at 7:00 PM" / "tomorrow at 12:30 PM" / "Friday, November 20 at 6:00 PM", in the call language. */
    pickupLabel(language = 'en') {
        if (!this.data.requested_time) return null;
        const p = phrases(language);
        const at = new Date(this.data.requested_time);
        const tz = this.timeZone;
        const dayOf = d => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
        const today = dayOf(this.clock());
        const tomorrow = dayOf(new Date(this.clock().getTime() + 86400000));
        const time = new Intl.DateTimeFormat(p.locale, { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(at);
        const day = dayOf(at) === today ? p.today
            : dayOf(at) === tomorrow ? p.tomorrow
                : new Intl.DateTimeFormat(p.locale, { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' }).format(at);
        return p.dayAt(day, time);
    }

    findLine(lineId) {
        return this.data.items.find(l => l.line_id === lineId) || null;
    }

    updateItem({ line_id, quantity, size, modifiers, spice_level, special_instructions, allergy_notes } = {}) {
        if (this.isLocked()) return this.locked();
        const line = this.findLine(line_id);
        if (!line) return { ok: false, error: 'line_not_found', lines: this.data.items.map(l => `${l.line_id}: ${l.name}`) };
        const item = this.menu.getItem(line.menu_item_id);

        let newQty = line.quantity;
        if (quantity !== undefined && quantity !== null) {
            const qty = this.validateQuantity(quantity);
            if (!qty.ok) return qty;
            newQty = qty.quantity;
        }
        const opts = this.resolveLineOptions(item, {
            size: size ?? line.size,
            modifiers: modifiers ?? line.modifiers.map(m => m.id),
            spice_level: spice_level === undefined ? line.spice_level : spice_level,
        });
        if (!opts.ok) return opts;

        line.quantity = newQty;
        line.size = opts.size.name;
        line.unit_price = opts.size.price;
        line.modifiers = opts.modifiers;
        line.spice_level = opts.spice;
        if (special_instructions !== undefined) line.special_instructions = cleanText(special_instructions);
        if (allergy_notes !== undefined) line.allergy_notes = cleanText(allergy_notes);
        this.touch();
        return { ok: true, updated: this.describeLine(line), subtotal: this.data.subtotal };
    }

    removeItem({ line_id } = {}) {
        if (this.isLocked()) return this.locked();
        const idx = this.data.items.findIndex(l => l.line_id === line_id);
        if (idx === -1) return { ok: false, error: 'line_not_found', lines: this.data.items.map(l => `${l.line_id}: ${l.name}`) };
        const [removed] = this.data.items.splice(idx, 1);
        this.touch();
        return { ok: true, removed: removed.name, subtotal: this.data.subtotal };
    }

    setCustomer({ name, phone, delivery_address } = {}) {
        if (this.isLocked()) return this.locked();
        const result = { ok: true };
        if (name !== undefined && name !== null) {
            const clean = cleanText(name);
            if (!clean || clean.length > 60) return { ok: false, error: 'invalid_name' };
            this.data.customer.name = clean;
            result.name = clean;
        }
        if (phone !== undefined && phone !== null) {
            const digits = normalizePhone(phone);
            if (!digits) return { ok: false, error: 'invalid_phone', message: 'Need a 10-digit US phone number. Ask the caller to repeat it.' };
            this.data.customer.phone = digits;
            result.phone = formatPhone(digits);
        }
        if (delivery_address !== undefined && delivery_address !== null) {
            const clean = cleanText(delivery_address);
            if (!clean) return { ok: false, error: 'invalid_address' };
            this.data.customer.delivery_address = clean;
            result.delivery_address = clean;
        }
        this.touch();
        return result;
    }

    setNotes({ order_notes, allergy_notes } = {}) {
        if (this.isLocked()) return this.locked();
        if (order_notes !== undefined) this.data.order_notes = cleanText(order_notes);
        if (allergy_notes !== undefined) this.data.allergy_notes = cleanText(allergy_notes);
        this.touch();
        return { ok: true, order_notes: this.data.order_notes, allergy_notes: this.data.allergy_notes };
    }

    // ------------------------------------------------------------------
    // Readback, confirmation, submission
    // ------------------------------------------------------------------

    missingFields() {
        const missing = [];
        if (this.data.intent !== 'pickup' && this.data.intent !== 'delivery') missing.push('order_type');
        if (this.requireScheduledTime && !this.data.requested_time) missing.push('pickup_time');
        if (this.data.items.length === 0) missing.push('items');
        if (!this.data.customer.name) missing.push('customer_name');
        if (!this.data.customer.phone) missing.push('customer_phone');
        if (this.data.intent === 'delivery' && !this.data.customer.delivery_address) missing.push('delivery_address');
        return missing;
    }

    /** One order line in words. Menu names, sizes and modifier names stay exactly as on the menu. */
    describeLine(line, language = 'en') {
        const p = phrases(language);
        const head = `${p.qty(line.quantity)} ${line.size !== 'regular' ? `${line.size} ` : ''}${line.name}`;
        const extras = [];
        if (p.spice[line.spice_level]) extras.push(p.spice[line.spice_level]);
        for (const m of line.modifiers) extras.push(language === 'en' ? m.name.toLowerCase() : m.name);
        if (line.special_instructions) extras.push(line.special_instructions);
        if (line.allergy_notes) extras.push(`${p.allergyNote}: ${line.allergy_notes}`);
        return extras.length ? `${head}, ${extras.join(', ')}` : head;
    }

    /** Builds the exact words to read back, in the call's language. The model does not paraphrase this. */
    readBack(language = 'en') {
        if (this.isLocked()) return this.locked();
        const missing = this.missingFields();
        if (missing.length) return { ok: false, error: 'missing_fields', missing };

        const p = phrases(language);
        const c = this.data.customer;
        const type = this.data.intent === 'delivery' ? 'delivery' : 'pickup';
        const sentences = p.readback({
            type: p.orderType[type],
            name: c.name,
            items: this.data.items.map(l => this.describeLine(l, language)).join('; '),
            notes: this.data.order_notes,
            allergy: this.data.allergy_notes,
            address: type === 'delivery' ? c.delivery_address : null,
            when: this.pickupLabel(language),
            subtotal: p.money(this.data.subtotal),
            phone: speakPhone(c.phone),
        }).filter(Boolean);

        this.data.status = PHASES.AWAITING_CONFIRMATION;
        this.data.confirmation_status = 'awaiting';
        this.readbackVersion = this.version;
        this.data.readback_language = language;
        return { ok: true, say_exactly: sentences.join(' ') };
    }

    /**
     * Confirmation is only accepted when the caller heard the current
     * readback and their own words are an unqualified yes.
     */
    confirm({ callerUtterance, language = 'en' } = {}) {
        if (this.phase !== PHASES.AWAITING_CONFIRMATION) {
            return { ok: false, error: 'read_back_first', message: 'Read the order back before asking for confirmation.' };
        }
        if (this.readbackVersion !== this.version) {
            return { ok: false, error: 'order_changed_since_readback' };
        }
        if (!isExplicitConfirmation(callerUtterance, language)) {
            return { ok: false, error: 'not_explicit_confirmation', message: 'The caller did not clearly say yes. Ask what they would like to change, or ask again.' };
        }
        this.data.status = PHASES.CONFIRMED;
        this.data.confirmation_status = 'confirmed';
        this.data.confirmed_at = this.clock().toISOString();
        this.data.updated_at = this.data.confirmed_at;
        return { ok: true };
    }

    markSubmitted(submission) {
        this.data.status = PHASES.SUBMITTED;
        this.data.submission = submission;
        this.data.updated_at = this.clock().toISOString();
    }

    /** Submission failed: unlock so staff can be offered, but keep it confirmed for the record. */
    markSubmissionFailed(submission) {
        this.data.submission = submission;
        this.data.status = PHASES.HANDOFF;
        this.data.handoff_reason = 'submission_failed';
        this.data.updated_at = this.clock().toISOString();
    }

    markHandoff(reason) {
        if (this.phase === PHASES.SUBMITTED) return { ok: false, error: 'already_submitted' };
        this.data.status = PHASES.HANDOFF;
        this.data.handoff_reason = cleanText(reason) || 'unspecified';
        this.data.updated_at = this.clock().toISOString();
        return { ok: true };
    }

    markEnded() {
        if (![PHASES.SUBMITTED, PHASES.HANDOFF].includes(this.phase)) this.data.status = PHASES.ENDED;
    }

    /** Idempotency key: one order per call. */
    idempotencyKey() {
        return `paahi:${this.data.call_id}:order`;
    }

    snapshot() {
        return JSON.parse(JSON.stringify(this.data));
    }

    /** Short state summary the model sees on every turn. */
    summaryForModel() {
        return {
            phase: this.phase,
            order_type: this.data.intent,
            pickup_time: this.data.requested_time ? this.pickupLabel('en') : 'as soon as possible',
            items: this.data.items.map(l => ({ line_id: l.line_id, text: this.describeLine(l), line_total: l.line_total })),
            subtotal: this.data.subtotal,
            customer: {
                name: this.data.customer.name,
                phone: this.data.customer.phone ? formatPhone(this.data.customer.phone) : null,
                delivery_address: this.data.customer.delivery_address,
            },
            order_notes: this.data.order_notes,
            allergy_notes: this.data.allergy_notes,
            missing: this.missingFields(),
        };
    }
}
