import menuMatcher from './menu-matcher.js';

console.log('🧪 Testing Menu Matcher...\n');

// Test 1: Exact match
console.log('Test 1: Exact match');
const exact = menuMatcher.search('Chicken Tikka Masala');
console.log('Query: "Chicken Tikka Masala"');
console.log('Results:', exact.map(r => `${r.item.name} (score: ${r.score}, type: ${r.matchType})`));
console.log('');

// Test 2: Typo tolerance
console.log('Test 2: Typo tolerance');
const typo = menuMatcher.search('butter chiken');
console.log('Query: "butter chiken" (typo)');
console.log('Results:', typo.map(r => `${r.item.name} (score: ${r.score}, type: ${r.matchType})`));
console.log('');

// Test 3: Phonetic matching
console.log('Test 3: Phonetic matching');
const phonetic = menuMatcher.search('teeka masala');
console.log('Query: "teeka masala" (phonetic)');
console.log('Results:', phonetic.map(r => `${r.item.name} (score: ${r.score}, type: ${r.matchType})`));
console.log('');

// Test 4: Common misspelling
console.log('Test 4: Common misspelling');
const misspell = menuMatcher.search('samsa');
console.log('Query: "samsa" (common misspelling)');
console.log('Results:', misspell.map(r => `${r.item.name} (score: ${r.score}, type: ${r.matchType})`));
console.log('');

// Test 5: Partial match
console.log('Test 5: Partial match');
const partial = menuMatcher.search('naan');
console.log('Query: "naan" (partial)');
console.log('Results:', partial.slice(0, 3).map(r => `${r.item.name} (score: ${r.score}, type: ${r.matchType})`));
console.log('');

// Test 6: Best match
console.log('Test 6: Best match');
const best = menuMatcher.findBestMatch('palak panner');
console.log('Query: "palak panner" (typo)');
if (best) {
    console.log(`Best match: ${best.item.name} (score: ${best.score}, price: $${best.item.base_price})`);
} else {
    console.log('No match found');
}
console.log('');

// Test 7: Extract items from natural language
console.log('Test 7: Extract items from natural language');
const text = "I want two chicken tikka masala and one garlic naan please";
const extracted = menuMatcher.extractItems(text);
console.log(`Text: "${text}"`);
console.log('Extracted items:', extracted.map(r => r.item.name));
console.log('');

// Test 8: Get popular items
console.log('Test 8: Get popular items');
const popular = menuMatcher.getPopularItems();
console.log(`Found ${popular.length} popular items:`);
popular.slice(0, 5).forEach(item => {
    console.log(`  - ${item.name} ($${item.base_price}) [${item.category}]`);
});
console.log('');

// Test 9: Category search
console.log('Test 9: Category search');
const vegItems = menuMatcher.getItemsByCategory('Vegetarian Appetizers');
console.log(`Found ${vegItems.length} items in "Vegetarian Appetizers"`);
vegItems.slice(0, 3).forEach(item => {
    console.log(`  - ${item.name} ($${item.base_price})`);
});
console.log('');

// Test 10: Edge cases
console.log('Test 10: Edge cases');
const edgeCases = [
    'biriyani',      // Common misspelling
    'panner',        // Common misspelling
    'lolipop',       // Typo
    'CTM',           // Abbreviation
    'tikka'          // Partial
];

for (const query of edgeCases) {
    const result = menuMatcher.findBestMatch(query, 60);
    if (result) {
        console.log(`  "${query}" → ${result.item.name} (score: ${result.score})`);
    } else {
        console.log(`  "${query}" → No match found`);
    }
}

console.log('\n✅ All menu matcher tests completed!');
