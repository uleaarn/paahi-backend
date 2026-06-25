import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Menu Matcher - Fuzzy matching and phonetic search for menu items
 * Handles typos, pronunciation variations, and common misspellings
 */
class MenuMatcher {
    constructor(menuPath = null) {
        this.menu = null;
        this.menuItems = [];
        this.aliases = new Map();

        if (menuPath) {
            this.loadMenu(menuPath);
        }
    }

    /**
     * Load menu from JSON file
     */
    loadMenu(menuPath) {
        try {
            const menuData = JSON.parse(fs.readFileSync(menuPath, 'utf-8'));
            this.menu = menuData;
            this.buildSearchIndex();
            console.log(`✅ Menu loaded: ${this.menuItems.length} items indexed`);
        } catch (error) {
            console.error('❌ Failed to load menu:', error.message);
        }
    }

    /**
     * Build search index with aliases and phonetic variations
     */
    buildSearchIndex() {
        this.menuItems = [];
        this.aliases = new Map();

        if (!this.menu || !this.menu.categories) return;

        for (const category of this.menu.categories) {
            for (const item of category.items) {
                this.menuItems.push({
                    ...item,
                    category: category.name,
                    searchName: item.name.toLowerCase()
                });

                // Add common aliases
                this.addAliases(item.name, item);
            }
        }
    }

    /**
     * Add common aliases for menu items
     */
    addAliases(itemName, item) {
        const name = itemName.toLowerCase();

        // Common aliases and variations
        const aliasMap = {
            'chicken tikka masala': ['tikka masala', 'chicken tikka', 'ctm', 'teeka masala', 'tika masala'],
            'butter chicken': ['butter chiken', 'makhani', 'butter chikn'],
            'palak paneer': ['palak panner', 'saag paneer', 'spinach paneer'],
            'garlic naan': ['naan', 'garlic nan', 'garlic bread'],
            'samosa': ['samsa', 'somosa', 'samoza'],
            'biryani': ['biriyani', 'briyani', 'beriyani'],
            'paneer': ['panner', 'panir'],
            'tandoori': ['tanduri', 'tandoori'],
            'vindaloo': ['vindaloo', 'vindalou'],
            'korma': ['kurma', 'korma'],
            'masala': ['massala', 'masalla'],
            'lollipop chicken': ['lollipop', 'lolipop', 'lolipop chicken']
        };

        // Add predefined aliases for exact names and broader dish families.
        for (const [canonicalName, aliases] of Object.entries(aliasMap)) {
            if (name === canonicalName || name.includes(canonicalName)) {
                for (const alias of aliases) {
                    if (!this.aliases.has(alias)) {
                        this.aliases.set(alias, item);
                    }
                }
            }
        }

        // Add the item name itself
        this.aliases.set(name, item);
    }

    /**
     * Calculate Levenshtein distance between two strings
     * Used for fuzzy matching with typos
     */
    levenshteinDistance(str1, str2) {
        const len1 = str1.length;
        const len2 = str2.length;
        const matrix = [];

        for (let i = 0; i <= len1; i++) {
            matrix[i] = [i];
        }

        for (let j = 0; j <= len2; j++) {
            matrix[0][j] = j;
        }

        for (let i = 1; i <= len1; i++) {
            for (let j = 1; j <= len2; j++) {
                const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
                matrix[i][j] = Math.min(
                    matrix[i - 1][j] + 1,      // deletion
                    matrix[i][j - 1] + 1,      // insertion
                    matrix[i - 1][j - 1] + cost // substitution
                );
            }
        }

        return matrix[len1][len2];
    }

    /**
     * Simple phonetic encoding (similar to Soundex)
     * Helps match words that sound similar
     */
    phoneticEncode(str) {
        let encoded = str.toLowerCase()
            .replace(/[aeiou]/g, '0')  // vowels to 0
            .replace(/[bfpv]/g, '1')   // similar sounds
            .replace(/[cgjkqsxz]/g, '2')
            .replace(/[dt]/g, '3')
            .replace(/[l]/g, '4')
            .replace(/[mn]/g, '5')
            .replace(/[r]/g, '6');

        // Remove consecutive duplicates
        encoded = encoded.replace(/(.)\1+/g, '$1');

        return encoded;
    }

    /**
     * Calculate similarity score between two strings
     * Returns a score from 0 (no match) to 100 (perfect match)
     */
    calculateSimilarity(query, target) {
        const queryLower = query.toLowerCase().trim();
        const targetLower = target.toLowerCase().trim();

        // Exact match
        if (queryLower === targetLower) {
            return 100;
        }

        // Contains match (high score)
        if (targetLower.includes(queryLower) || queryLower.includes(targetLower)) {
            return 90;
        }

        // Word-level matching
        const queryWords = queryLower.split(/\s+/);
        const targetWords = targetLower.split(/\s+/);

        let wordMatches = 0;
        for (const qWord of queryWords) {
            for (const tWord of targetWords) {
                if (qWord === tWord) {
                    wordMatches++;
                    break;
                }
            }
        }

        if (wordMatches > 0) {
            const wordScore = (wordMatches / Math.max(queryWords.length, targetWords.length)) * 80;
            if (wordScore > 60) return wordScore;
        }

        // Phonetic matching
        const queryPhonetic = this.phoneticEncode(queryLower);
        const targetPhonetic = this.phoneticEncode(targetLower);

        if (queryPhonetic === targetPhonetic) {
            return 75;
        }

        // Levenshtein distance (fuzzy matching)
        const distance = this.levenshteinDistance(queryLower, targetLower);
        const maxLen = Math.max(queryLower.length, targetLower.length);
        const similarity = ((maxLen - distance) / maxLen) * 100;

        return Math.max(0, similarity);
    }

    /**
     * Search for menu items matching the query
     * @param {string} query - Search query
     * @param {number} minScore - Minimum similarity score (0-100)
     * @param {number} maxResults - Maximum number of results
     * @returns {Array} Array of matching items with scores
     */
    search(query, minScore = 60, maxResults = 5) {
        if (!query || !this.menuItems.length) {
            return [];
        }

        const queryLower = query.toLowerCase().trim();

        // Check aliases first (exact matches)
        if (this.aliases.has(queryLower)) {
            return [{
                item: this.aliases.get(queryLower),
                score: 100,
                matchType: 'alias'
            }];
        }

        // Score all items
        const results = [];

        for (const item of this.menuItems) {
            const score = this.calculateSimilarity(query, item.name);

            if (score >= minScore) {
                results.push({
                    item,
                    score,
                    matchType: score === 100 ? 'exact' : score >= 90 ? 'contains' : score >= 75 ? 'phonetic' : 'fuzzy'
                });
            }
        }

        // Sort by score (highest first)
        results.sort((a, b) => b.score - a.score);

        // Return top results
        return results.slice(0, maxResults);
    }

    /**
     * Find best match for a query
     * @param {string} query - Search query
     * @param {number} minScore - Minimum acceptable score
     * @returns {Object|null} Best matching item or null
     */
    findBestMatch(query, minScore = 70) {
        const results = this.search(query, minScore, 1);
        return results.length > 0 ? results[0] : null;
    }

    /**
     * Extract menu items from natural language text
     * @param {string} text - Natural language text
     * @returns {Array} Array of detected menu items
     */
    extractItems(text) {
        const detectedById = new Map();
        const textLower = text.toLowerCase();
        const itemsBySpecificity = [...this.menuItems].sort((a, b) => b.name.length - a.name.length);

        // Try to find menu items in the text
        for (const item of itemsBySpecificity) {
            const itemName = item.name.toLowerCase();

            // Check if item name appears in text
            if (textLower.includes(itemName)) {
                detectedById.set(item.id, {
                    item,
                    score: 100,
                    matchType: 'exact'
                });
                continue;
            }

            // Check aliases
            for (const [alias, aliasItem] of this.aliases.entries()) {
                if (aliasItem.id === item.id && textLower.includes(alias)) {
                    detectedById.set(item.id, {
                        item,
                        score: 95,
                        matchType: 'alias'
                    });
                    break;
                }
            }
        }

        const detected = [...detectedById.values()];
        return detected.filter((candidate) => {
            const candidateName = candidate.item.name.toLowerCase();
            return !detected.some((other) => {
                const otherName = other.item.name.toLowerCase();
                return other.item.id !== candidate.item.id &&
                    otherName.includes(candidateName) &&
                    otherName.length > candidateName.length;
            });
        });
    }

    /**
     * Get items by category
     * @param {string} categoryName - Category name
     * @returns {Array} Array of items in category
     */
    getItemsByCategory(categoryName) {
        const categoryLower = categoryName.toLowerCase();
        return this.menuItems.filter(item =>
            item.category.toLowerCase().includes(categoryLower)
        );
    }

    /**
     * Get popular items
     * @returns {Array} Array of popular items
     */
    getPopularItems() {
        return this.menuItems.filter(item => item.popular === true);
    }
}

// Export singleton instance
const menuPath = path.join(__dirname, 'data', 'menu.json');
const menuMatcher = new MenuMatcher(menuPath);

export default menuMatcher;
