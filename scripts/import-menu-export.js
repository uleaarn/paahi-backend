#!/usr/bin/env node
/**
 * Import a restaurant's online-ordering menu export (JSON: a list of menus,
 * each with "children" items, option "groups" and "serviceAvailability")
 * into Paahi's menu.json. The ordering system is the source of truth for
 * items, prices, options, spice choices, availability and service hours.
 *
 *   node scripts/import-menu-export.js <export.json> businesses/<id> [--hours]
 *
 * - Writes businesses/<id>/menu.json.
 * - Keeps extra spoken names from businesses/<id>/menu-aliases.json.
 * - --hours also updates the location hours in business.json from the
 *   service hours (the union of all menus, per day).
 */
import fs from 'fs';
import path from 'path';

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const CATEGORY_NAMES = {
    'BREAKFAST': 'South Indian Breakfast',
    'LUNCH SPECIAL': 'Lunch Special',
    'BEVERAGES': 'Beverages',
    'STARTERS-VEGETABLE': 'Vegetable Starters',
    'STARTERS-NON-VEGETABLE': 'Non-Vegetarian Starters',
    'ENTREES-CLAY': 'From Our Clay Oven',
    'ENTREES-VEGETABLE': 'Vegetable Entrées',
    'ENTREES-CHICKEN': 'Chicken Entrées',
    'ENTREES-LAMB & GOAT': 'Lamb and Goat Entrées',
    'ENTREES-FROM THE SEA': 'From The Sea',
    'RICE': 'Rice',
    'BREAD': 'Breads',
    'SIDES': 'Sides',
    'DESSERTS': 'Desserts',
};

// Friendlier names for the choice groups the caller is asked about.
const GROUP_NAMES = {
    'LUNCH APP': 'starter',
    'LUNCH ENTREE': 'entree',
    'LUNCH BREAD': 'bread',
};

const slug = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const titleCase = s => s.replace(/\b([a-z])/g, (m, c) => c.toUpperCase());

function cleanName(raw) {
    let name = String(raw).trim().replace(/\s+/g, ' ');
    const vegan = /\(vegan\)/i.test(name);
    name = name.replace(/\s*\(vegan\)\s*/ig, ' ').trim();
    // "(Crispy Okra)" becomes another name callers can use; "(3)" is dropped from the spoken name.
    const extra = [];
    name = name.replace(/\s*\(([^)]*)\)\s*/g, (m, inner) => { if (/[a-z]/i.test(inner)) extra.push(inner.trim().toLowerCase()); return ' '; }).trim();
    if (name === name.toLowerCase() || /^[A-Z][a-z]+( [a-z]+)+$/.test(name)) name = titleCase(name);
    if (name === name.toUpperCase() && /[A-Z]/.test(name)) name = titleCase(name.toLowerCase());
    return { name, vegan, extra };
}

function cleanDescription(raw) {
    let desc = String(raw || '').trim().replace(/\s+/g, ' ');
    let vegetarian = false;
    let spicy = false;
    for (;;) {
        const m = desc.match(/^(Vegetarian|Spicy)\.\s*/i);
        if (!m) break;
        if (/vegetarian/i.test(m[1])) vegetarian = true; else spicy = true;
        desc = desc.slice(m[0].length);
    }
    return { description: desc || null, vegetarian, spicy, vegan: /\bvegan\b/i.test(desc) };
}

const clock = hhmm => {
    const [h, m] = hhmm.split(':').map(Number);
    const ampm = h >= 12 ? 'PM' : 'AM';
    return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${ampm}`;
};
const minutes = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const hhmm = mins => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

/** {monday: [[start,end],...]} -> {monday: "11:30 AM - 3:00 PM, 4:30 PM - 10:15 PM" | "Closed"} */
function hoursText(byDay) {
    const out = {};
    for (const day of [...DAYS.slice(1), 'sunday']) {
        const ranges = byDay[day] || [];
        out[day] = ranges.length ? ranges.map(([s, e]) => `${clock(hhmm(s))} - ${clock(hhmm(e))}`).join(', ') : 'Closed';
    }
    return out;
}

function mergeRanges(ranges) {
    const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
    const out = [];
    for (const r of sorted) {
        const last = out[out.length - 1];
        if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
        else out.push([...r]);
    }
    return out;
}

export function convertExport(exportData, aliases = {}) {
    const unionByDay = {};
    const usedIds = new Set();
    const categories = [];
    for (const menu of exportData) {
        const byDay = {};
        for (const a of menu.serviceAvailability || []) {
            byDay[a.dayOfWeek] = a.enabled ? (a.timePeriods || []).map(t => [minutes(t.startTime), minutes(t.endTime)]) : [];
            unionByDay[a.dayOfWeek] = mergeRanges([...(unionByDay[a.dayOfWeek] || []), ...byDay[a.dayOfWeek]]);
        }
        const catName = CATEGORY_NAMES[menu.name.trim()] || titleCase(menu.name.trim().toLowerCase());
        const items = [];
        for (const raw of menu.children || []) {
            const { name, vegan: veganName, extra } = cleanName(raw.name);
            const d = cleanDescription(raw.description);
            let id = `${slug(catName)}_${slug(name)}`;
            while (usedIds.has(id)) id += '_2';
            usedIds.add(id);
            const item = {
                id,
                pos_id: String(raw.id),
                name,
                description: d.description,
                base_price: Number(raw.price),
                sizes: [{ name: 'regular', price: Number(raw.price) }],
                modifiers: [],
            };
            if (raw.available === false) item.available = false;
            const groups = [];
            for (const g of raw.groups || []) {
                if (g.name.trim().toLowerCase() === 'spice') {
                    item.spice_levels = g.members.filter(m => m.available !== false).map(m => m.name.toLowerCase());
                    if (g.min > 0) item.spice_required = true;
                    continue;
                }
                groups.push({
                    id: slug(g.name) || String(g.id),
                    name: GROUP_NAMES[g.name.trim()] || g.name.replace(/\.\.\.$/, '').replace(/^(Choose|Select|Add)\s+(your\s+|on to your\s+|to your\s+|yo your\s+)?/i, '').trim() || g.name,
                    min: Number(g.min || 0),
                    max: Number(g.max ?? 1),
                    options: g.members.map(m => ({
                        id: slug(m.name),
                        name: cleanName(m.name).name,
                        price: Number(m.price || 0),
                        ...(m.available === false ? { available: false } : {}),
                    })),
                });
            }
            if (groups.length) item.option_groups = groups;
            const names = [...new Set([...(aliases[name] || []), ...extra])];
            if (names.length) item.aliases = names;
            if (d.vegetarian || veganName || d.vegan) item.vegetarian = true;
            if (veganName || d.vegan) item.vegan = true;
            if (d.spicy) item.spicy = true;
            items.push(item);
        }
        const category = { name: catName, items };
        if (Object.keys(byDay).length) category.available = hoursText(byDay);
        categories.push(category);
    }
    return { categories, locationHours: hoursText(unionByDay) };
}

// ------------------------------------------------------------------ CLI
if (import.meta.url === `file://${process.argv[1]}`) {
    const [exportPath, businessDir, ...flags] = process.argv.slice(2);
    if (!exportPath || !businessDir) {
        console.error('usage: node scripts/import-menu-export.js <export.json> businesses/<id> [--hours]');
        process.exit(1);
    }
    const aliasPath = path.join(businessDir, 'menu-aliases.json');
    const aliases = fs.existsSync(aliasPath) ? JSON.parse(fs.readFileSync(aliasPath, 'utf-8')) : {};
    const { categories, locationHours } = convertExport(JSON.parse(fs.readFileSync(exportPath, 'utf-8')), aliases);
    const menu = {
        source: 'Restaurant online-ordering menu export (source of truth for items, prices, options and hours)',
        imported: new Date().toISOString().slice(0, 10),
        notes: 'Generated by scripts/import-menu-export.js. Edit menu-aliases.json for extra spoken names, then re-import. Catering is handled by staff.',
        categories,
        modifiers: {},
    };
    fs.writeFileSync(path.join(businessDir, 'menu.json'), JSON.stringify(menu, null, 2) + '\n');
    const count = categories.reduce((n, c) => n + c.items.length, 0);
    const off = categories.flatMap(c => c.items.filter(i => i.available === false).map(i => i.name));
    console.log(`menu.json: ${categories.length} categories, ${count} items (${off.length} unavailable: ${off.join(', ') || 'none'})`);
    const missingAliases = Object.keys(aliases).filter(n => !n.startsWith('_') && !categories.some(c => c.items.some(i => i.name === n)));
    if (missingAliases.length) console.log(`aliases for names not on the menu (ignored): ${missingAliases.join(', ')}`);
    if (flags.includes('--hours')) {
        const bizPath = path.join(businessDir, 'business.json');
        const biz = JSON.parse(fs.readFileSync(bizPath, 'utf-8'));
        biz.locations[0].hours = locationHours;
        fs.writeFileSync(bizPath, JSON.stringify(biz, null, 4) + '\n');
        console.log('business.json hours:', JSON.stringify(locationHours));
    }
}
