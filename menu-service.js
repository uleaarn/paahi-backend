/**
 * Menu service: the single source of truth for menu facts.
 *
 * Everything the agent says about items, sizes, modifiers, prices and hours
 * must come through here. Nothing in this file calls a model.
 */
import { MenuMatcher } from './menu-matcher.js';

// Lookup confidence rules (scores come from MenuMatcher, 0-100).
const CONFIDENT_SCORE = 75;     // minimum score to accept a single match
const CLEAR_MARGIN = 8;         // top match must beat the runner-up by this much
const CANDIDATE_SCORE = 60;     // minimum score to offer as a "did you mean"

const SPICE_MODIFIER_IDS = new Set(['mild', 'extra_spicy']);

export const SPICE_LEVELS = ['mild', 'regular', 'extra_spicy'];

function normalize(text) {
    return String(text || '')
        .toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '') // jalapeño -> jalapeno
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function titleFromId(id) {
    return id.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

export class MenuService {
    constructor(menu) {
        if (!menu || !Array.isArray(menu.categories)) {
            throw new Error('Menu data must have a categories array');
        }
        this.menu = menu;
        this.matcher = new MenuMatcher();
        this.matcher.menu = menu;
        this.matcher.buildSearchIndex();

        this.itemsById = new Map();
        this.categoryByItemId = new Map();
        for (const category of menu.categories) {
            for (const item of category.items || []) {
                this.itemsById.set(item.id, { ...item, category: category.name });
                this.categoryByItemId.set(item.id, category);
            }
        }
        this.globalModifiers = menu.modifiers || {};
    }

    getItem(id) {
        return this.itemsById.get(id) || null;
    }

    /** Can this item be ordered for this time? (e.g. lunch specials only Mon-Thu lunch) */
    availability(item, at, timeZone) {
        const category = this.categoryByItemId.get(item.id);
        if (categoryAvailableAt(category, at, timeZone)) return { ok: true };
        const a = category.available;
        const days = a.days?.length === 7 ? 'daily' : a.days?.join(', ');
        return { ok: false, error: 'not_available_at_that_time', item: item.name, available: [days, a.hours].filter(Boolean).join(' ') };
    }

    /**
     * Find a menu item from what the caller said.
     * @returns {{status:'matched', item}|{status:'ambiguous', candidates}|{status:'not_found', candidates}}
     */
    findItem(query) {
        const q = String(query || '').trim();
        if (!q) return { status: 'not_found', candidates: [] };

        // Exact id or exact name always wins.
        const byId = this.getItem(q);
        if (byId) return { status: 'matched', item: byId };
        const exact = [...this.itemsById.values()].find(i => normalize(i.name) === normalize(q));
        if (exact) return { status: 'matched', item: exact };

        const results = this.matcher.search(q, CANDIDATE_SCORE, 5);
        const candidates = results.map(r => this.getItem(r.item.id)).filter(Boolean);
        if (results.length === 0) return { status: 'not_found', candidates: [] };

        const [top, second] = results;
        const clearWinner = top.score >= CONFIDENT_SCORE &&
            (!second || top.score - second.score >= CLEAR_MARGIN);
        if (clearWinner) return { status: 'matched', item: this.getItem(top.item.id) };

        if (top.score >= CONFIDENT_SCORE) return { status: 'ambiguous', candidates };
        return { status: 'not_found', candidates };
    }

    /** Sizes for an item, e.g. [{name:'half', price:18}, {name:'full', price:32}] */
    getSizes(item) {
        if (Array.isArray(item.sizes) && item.sizes.length > 0) return item.sizes;
        return [{ name: 'regular', price: item.base_price }];
    }

    resolveSize(item, requested) {
        const sizes = this.getSizes(item);
        if (!requested) {
            if (sizes.length === 1) return { ok: true, size: sizes[0] };
            return { ok: false, error: 'size_required', options: sizes.map(s => s.name) };
        }
        const want = normalize(requested);
        const size = sizes.find(s => normalize(s.name) === want) ||
            sizes.find(s => normalize(s.name).startsWith(want) || want.startsWith(normalize(s.name)));
        if (size) return { ok: true, size };
        return { ok: false, error: 'invalid_size', options: sizes.map(s => s.name) };
    }

    /** Modifiers this item allows, excluding spice (spice is its own field). */
    getAllowedModifiers(item) {
        return (item.modifiers || [])
            .filter(id => !SPICE_MODIFIER_IDS.has(id))
            .map(id => {
                const def = this.globalModifiers[id];
                return {
                    id,
                    name: def?.name || titleFromId(id),
                    price: typeof def?.price === 'number' ? def.price : 0,
                    defined_in_menu: Boolean(def),
                };
            });
    }

    resolveModifier(item, requested) {
        const want = normalize(requested);
        const allowed = this.getAllowedModifiers(item);
        const match = allowed.find(m => {
            const id = normalize(m.id);
            const name = normalize(m.name);
            return want === id || want === name ||
                want === name.replace(/^add_/, '') || `add_${want}` === name ||
                want.replace(/^add_/, '') === id;
        });
        if (match) return { ok: true, modifier: match };
        return { ok: false, error: 'modifier_not_allowed', options: allowed.map(m => m.name) };
    }

    /** Which spice levels an item supports. Empty means spice cannot be changed. */
    getSpiceOptions(item) {
        const mods = new Set(item.modifiers || []);
        if (!mods.has('mild') && !mods.has('extra_spicy')) return [];
        const options = ['regular'];
        if (mods.has('mild')) options.unshift('mild');
        if (mods.has('extra_spicy')) options.push('extra_spicy');
        return options;
    }

    resolveSpice(item, requested) {
        if (requested === null || requested === undefined || requested === '') return { ok: true, spice: null };
        let want = normalize(requested);
        if (['medium', 'normal', 'regular', 'standard', 'default'].includes(want)) want = 'regular';
        if (['hot', 'spicy', 'extra_hot', 'very_spicy', 'extra_spicy'].includes(want)) want = 'extra_spicy';
        if (['not_spicy', 'less_spicy', 'mild'].includes(want)) want = 'mild';
        const options = this.getSpiceOptions(item);
        if (options.includes(want)) return { ok: true, spice: want };
        return { ok: false, error: 'spice_not_adjustable', options };
    }

    /** Short public description used to answer "what is X?" */
    describe(item) {
        return {
            id: item.id,
            name: item.name,
            category: item.category,
            description: item.description || null,
            sizes: this.getSizes(item),
            modifiers: this.getAllowedModifiers(item).map(m => m.name),
            spice_options: this.getSpiceOptions(item),
            vegetarian: item.vegetarian ?? null,
            vegan: item.vegan ?? null,
            listed_gluten_free: item.gluten_free ?? null,
        };
    }

    /** Compact menu text for the model prompt (names, sizes, prices only). */
    compactMenuText() {
        const lines = [];
        for (const category of this.menu.categories) {
            const a = category.available;
            const when = a ? ` (only ${a.days?.length === 7 ? 'daily' : a.days.join(', ')} ${a.hours || ''})`.replace(/\s+\)/, ')') : '';
            lines.push(`${category.name}${when}:${category.description ? ` ${category.description}` : ''}`);
            for (const item of category.items || []) {
                const sizes = this.getSizes(item)
                    .map(s => (s.name === 'regular' ? `$${s.price}` : `${s.name} $${s.price}`)).join(' / ');
                const flags = [item.vegetarian ? 'veg' : null, item.popular ? 'popular' : null].filter(Boolean);
                lines.push(`- ${item.name} — ${sizes}${flags.length ? ` (${flags.join(', ')})` : ''}`);
            }
        }
        return lines.join('\n');
    }

    /** Modifier ids items reference but the menu never defines (data gaps). */
    undefinedModifierIds() {
        const missing = new Set();
        for (const item of this.itemsById.values()) {
            for (const id of item.modifiers || []) {
                if (!this.globalModifiers[id] && !SPICE_MODIFIER_IDS.has(id)) missing.add(id);
            }
        }
        return [...missing].sort();
    }
}

// ---------------------------------------------------------------------------
// Hours
// ---------------------------------------------------------------------------

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function parseClock(text) {
    const m = String(text).trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (!m) return null;
    let h = Number(m[1]) % 12;
    if (m[3].toUpperCase() === 'PM') h += 12;
    return h * 60 + Number(m[2]);
}

/** Current day/minute in the restaurant's time zone. */
export function localTime(now = new Date(), timeZone = 'America/New_York') {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone, weekday: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(now).map(p => [p.type, p.value]));
    return {
        day: parts.weekday.toLowerCase(),
        minutes: Number(parts.hour) * 60 + Number(parts.minute),
        label: now.toLocaleString('en-US', { timeZone, weekday: 'long', hour: 'numeric', minute: '2-digit' }),
    };
}

/**
 * Is the restaurant open right now according to menu.hours?
 * Returns { known:false } if hours are missing or unparseable — never guesses.
 */
export function openStatus(hours, now = new Date(), timeZone = 'America/New_York') {
    const t = localTime(now, timeZone);
    const today = hours?.[t.day];
    if (!today) return { known: false, today_hours: null, local_time: t.label };
    if (/closed/i.test(today)) return { known: true, open: false, today_hours: today, local_time: t.label };

    const ranges = today.split(',').map(r => r.split('-').map(parseClock));
    if (ranges.some(r => r.length !== 2 || r[0] === null || r[1] === null)) {
        return { known: false, today_hours: today, local_time: t.label };
    }
    const open = ranges.some(([start, end]) => t.minutes >= start && t.minutes < end);
    return { known: true, open, today_hours: today, local_time: t.label };
}

export { DAYS };

// ---------------------------------------------------------------------------
// Scheduled pickup times
// ---------------------------------------------------------------------------

/** Open ranges for one day's hours text, in minutes: [[660, 900], [1020, 1350]], or null if unparseable. */
export function dayRanges(dayText) {
    if (!dayText) return null;
    if (/closed/i.test(dayText)) return [];
    const ranges = dayText.split(',').map(r => r.split('-').map(parseClock));
    if (ranges.some(r => r.length !== 2 || r[0] === null || r[1] === null)) return null;
    return ranges;
}

/** Calendar date + weekday + minutes of `date` in the business's time zone. */
export function zonedParts(date, timeZone) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date).map(x => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, day: p.weekday.toLowerCase(), minutes: Number(p.hour) * 60 + Number(p.minute) };
}

/** The instant when the business's wall clock shows `dateStr` (YYYY-MM-DD) at `minutes`. */
export function zonedTime(dateStr, minutes, timeZone) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const wall = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
    let guess = wall;
    for (let i = 0; i < 2; i++) { // converge on the zone offset (handles DST)
        const p = zonedParts(new Date(guess), timeZone);
        const [py, pm, pd] = p.date.split('-').map(Number);
        const shown = Date.UTC(py, pm - 1, pd, Math.floor(p.minutes / 60), p.minutes % 60);
        guess += wall - shown;
    }
    return new Date(guess);
}

function addDays(dateStr, n) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Is the business open at this instant per its weekly hours? null when unknown. */
export function isOpenAt(hours, at, timeZone) {
    const p = zonedParts(at, timeZone);
    const ranges = dayRanges(hours?.[p.day]);
    if (ranges === null) return null;
    return ranges.some(([start, end]) => p.minutes >= start && p.minutes < end);
}

/** Next instant the business opens after `now`, within `maxDays`. null if none/unknown. */
export function nextOpening(hours, now, timeZone, maxDays = 7) {
    const today = zonedParts(now, timeZone);
    for (let n = 0; n <= maxDays; n++) {
        const dateStr = addDays(today.date, n);
        const day = DAYS[new Date(`${dateStr}T12:00:00Z`).getUTCDay()];
        const ranges = dayRanges(hours?.[day]);
        if (ranges === null) return null;
        for (const [start] of ranges) {
            if (n === 0 && start <= today.minutes) continue;
            return zonedTime(dateStr, start, timeZone);
        }
    }
    return null;
}

/**
 * Turn what the model heard into a local date: "today", "tomorrow", a weekday
 * ("friday" = the next Friday, today if it is Friday) or "YYYY-MM-DD".
 * The model is bad at date arithmetic late in the evening; code does it.
 */
export function resolvePickupDay(day, now, timeZone) {
    const today = zonedParts(now, timeZone);
    const d = String(day || '').trim().toLowerCase();
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
    if (d === 'today' || d === 'tonight') return today.date;
    if (d === 'tomorrow') return addDays(today.date, 1);
    const target = DAYS.indexOf(d);
    if (target >= 0) {
        const from = DAYS.indexOf(today.day);
        return addDays(today.date, (target - from + 7) % 7);
    }
    return null;
}

/** "19:30", "7:30 PM", "7 pm", "11:30am" -> minutes after midnight, or null. */
export function parsePickupClock(text) {
    const m = String(text || '').trim().toLowerCase().replace(/\./g, '').match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
    if (!m) return null;
    let h = Number(m[1]);
    const mi = Number(m[2] || 0);
    if (mi > 59) return null;
    if (m[3]) {
        if (h < 1 || h > 12) return null;
        h = (h % 12) + (m[3] === 'pm' ? 12 : 0);
    } else if (m[2] === undefined || h > 23) {
        return null; // bare "7" is ambiguous
    }
    return h * 60 + mi;
}

/** "Wednesday, Nov 18 at 11:30 AM" */
function whenLabel(at, timeZone) {
    const day = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long', month: 'short', day: 'numeric' }).format(at);
    const time = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(at);
    return `${day} at ${time}`;
}

/**
 * Check a requested pickup time (local date + clock time).
 * Accepts { day, time } (day words, see resolvePickupDay) or { date, time }.
 * Rules: in the future by at least minLeadMinutes, within maxDaysAhead, and
 * inside opening hours that day (not in the last few minutes before closing).
 */
export function checkPickupTime(hours, { day, date, time }, { now, timeZone, minLeadMinutes = 20, maxDaysAhead = 7, closingBufferMinutes = 15 }) {
    date = resolvePickupDay(day ?? date, now, timeZone);
    const minutes = parsePickupClock(time);
    if (!date || minutes === null) {
        return { ok: false, error: 'invalid_time_format', message: 'Send day as today, tomorrow, a weekday name or YYYY-MM-DD, and time like "19:30" or "7:30 PM".' };
    }
    const at = zonedTime(date, minutes, timeZone);
    const understood = whenLabel(at, timeZone);
    const nowLabel = whenLabel(now, timeZone);
    const today = zonedParts(now, timeZone).date;
    if (at.getTime() <= now.getTime()) {
        return { ok: false, error: 'time_has_passed', understood, now: nowLabel, message: `${understood} has already passed (it is now ${nowLabel}). If they meant a later day, say which day.` };
    }
    if (at.getTime() < now.getTime() + minLeadMinutes * 60000) {
        return { ok: false, error: 'too_soon', understood, message: `Pickup must be at least ${minLeadMinutes} minutes from now (it is now ${nowLabel}).` };
    }
    if (date > addDays(today, maxDaysAhead)) {
        return { ok: false, error: 'too_far_ahead', understood, message: `Orders can be scheduled up to ${maxDaysAhead} days ahead.` };
    }
    const weekday = DAYS[new Date(`${date}T12:00:00Z`).getUTCDay()];
    const ranges = dayRanges(hours?.[weekday]);
    if (ranges === null) return { ok: false, error: 'hours_unknown' };
    const inside = ranges.some(([start, end]) => minutes >= start && minutes <= end - closingBufferMinutes);
    if (!inside) {
        return { ok: false, error: 'outside_opening_hours', understood, hours: hours[weekday], message: `Not open at ${understood}. ${weekday} hours: ${hours[weekday]}.` };
    }
    return { ok: true, at, understood };
}

/** Earliest acceptable pickup from now (lead time, opening hours, closing buffer). */
export function earliestPickup(hours, now, timeZone, { minLeadMinutes = 20, maxDaysAhead = 7, closingBufferMinutes = 15 } = {}) {
    const step = 5 * 60000;
    let t = new Date(Math.ceil((now.getTime() + minLeadMinutes * 60000) / step) * step);
    for (let i = 0; i < 20; i++) {
        const p = zonedParts(t, timeZone);
        const ranges = dayRanges(hours?.[p.day]);
        if (ranges === null) return null;
        const inside = ranges.find(([s, e]) => p.minutes >= s && p.minutes <= e - closingBufferMinutes);
        if (inside) return t;
        const next = nextOpening(hours, t, timeZone, maxDaysAhead);
        if (!next) return null;
        t = next;
    }
    return null;
}

export function whenText(at, timeZone) {
    return whenLabel(at, timeZone);
}

/** Is a menu category available at this instant? (e.g. lunch specials Mon-Thu 11:30-3) */
export function categoryAvailableAt(category, at, timeZone) {
    const a = category?.available;
    if (!a) return true;
    const p = zonedParts(at, timeZone);
    if (a.days && !a.days.includes(p.day)) return false;
    if (a.hours) {
        const ranges = dayRanges(a.hours);
        if (ranges && !ranges.some(([s, e]) => p.minutes >= s && p.minutes < e)) return false;
    }
    return true;
}
