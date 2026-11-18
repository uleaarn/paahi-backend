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
        for (const category of menu.categories) {
            for (const item of category.items || []) {
                this.itemsById.set(item.id, { ...item, category: category.name });
            }
        }
        this.globalModifiers = menu.modifiers || {};
    }

    getItem(id) {
        return this.itemsById.get(id) || null;
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
            lines.push(`${category.name}:`);
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
