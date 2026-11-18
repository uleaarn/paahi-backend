/**
 * Menu matcher: finds the menu item a caller meant, from their words.
 *
 * Callers (and speech-to-text) spell Indian dish names many ways:
 * chole / choley / cholley / chhole, naan / nan, aloo / alu, paneer / panner.
 * Each word is reduced to a spelling-neutral key, then the query and the
 * item name are compared word by word, so "aloo tikki with pindi choley"
 * finds "Aloo Tikki With Pindi Cholley" and "pindi chole" finds
 * "Pindi Cholley" (not the starter that also contains it).
 *
 * Items can list extra names in menu.json ("aliases"), for names callers use
 * that aren't spelled like the menu (e.g. "saag paneer" for Palak Paneer).
 *
 * Scores are 0-100. MenuService decides what score counts as a match.
 */

// Filler words that don't identify a dish.
const STOPWORDS = new Set([
    'a', 'an', 'the', 'and', 'with', 'of', 'some', 'please', 'order', 'plate', 'portion',
    'i', 'id', 'me', 'want', 'like', 'get', 'have', 'can', 'could', 'for', 'my',
    'one', 'two', 'three', 'four', 'five',
]);

/** Spelling-neutral key for one word. */
export function wordKey(word) {
    let k = String(word).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
    if (k.length > 3) k = k.replace(/(ey|ay|ie|ee)$/, 'e').replace(/([^aeiou])y$/, '$1e'); // choley -> chole
    k = k.replace(/(.)\1+/g, '$1');            // cholley -> choley, naan -> nan, tikki -> tiki
    k = k.replace(/([bcdgjkpt])h/g, '$1');     // chhole/chole -> cole, bhindi -> bindi, kh -> k
    k = k.replace(/w/g, 'v');                  // wala / vala
    return k.replace(/(.)\1+/g, '$1');
}

export function tokens(text) {
    return String(text || '')
        .toLowerCase()
        .split(/[^a-z0-9À-ɏ]+/)
        .filter(w => w && !STOPWORDS.has(w))
        .map(wordKey)
        .filter(Boolean);
}

function levenshtein(a, b) {
    const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        let diag = prev[0];
        prev[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const tmp = prev[j];
            prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
            diag = tmp;
        }
    }
    return prev[b.length];
}

/** 0..1 similarity of two word keys; small typos count, different words don't. */
function wordSimilarity(a, b) {
    if (a === b) return 1;
    if (Math.min(a.length, b.length) < 4) return 0;
    const sim = 1 - levenshtein(a, b) / Math.max(a.length, b.length);
    return sim >= 0.75 ? sim : 0;
}

/** 0..100: how well the query words match a name's words, in both directions. */
export function nameScore(queryTokens, nameTokens) {
    if (!queryTokens.length || !nameTokens.length) return 0;
    if (queryTokens.join(' ') === nameTokens.join(' ')) return 100;
    const best = (w, pool) => Math.max(...pool.map(p => wordSimilarity(w, p)));
    const queryCovered = queryTokens.reduce((s, w) => s + best(w, nameTokens), 0) / queryTokens.length;
    const nameCovered = nameTokens.reduce((s, w) => s + best(w, queryTokens), 0) / nameTokens.length;
    // What the caller said matters most; extra words in the menu name cost a little.
    return Math.round(100 * (0.6 * queryCovered + 0.4 * nameCovered));
}

export class MenuMatcher {
    constructor() {
        this.menu = null;
        this.entries = []; // { item, names: [tokens...] }
    }

    buildSearchIndex() {
        this.entries = [];
        for (const category of this.menu?.categories || []) {
            for (const item of category.items || []) {
                const names = [item.name, ...(item.aliases || [])].map(tokens).filter(t => t.length);
                this.entries.push({ item: { ...item, category: category.name }, names });
            }
        }
    }

    /** Items scoring at least minScore, best first: [{ item, score }] */
    search(query, minScore = 60, maxResults = 5) {
        const q = tokens(query);
        if (!q.length) return [];
        return this.entries
            .map(e => ({ item: e.item, score: Math.max(...e.names.map(n => nameScore(q, n))) }))
            .filter(r => r.score >= minScore)
            .sort((a, b) => b.score - a.score)
            .slice(0, maxResults);
    }
}
