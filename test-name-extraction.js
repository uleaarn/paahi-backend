// Test name extraction regex patterns

const testCases = [
    "B a b u, Babu",
    "n a y a n",
    "My name is J o h n, John",
    "C a r d, Card",
    "My name is Sarah",
    "It's Mike",
    "Alice",
    "B o b"
];

console.log("Testing IMPROVED name extraction patterns:\n");

testCases.forEach(input => {
    let userResponse = input.trim();
    let customerName = 'Unknown';

    // Remove common filler words first
    userResponse = userResponse.replace(/^(my name is|i'm|i am|it's|its|this is)\s+/i, '');

    // Check if there's a pattern like "B a b u, Babu" (spelling followed by actual name)
    const spellingWithName = userResponse.match(/^([a-z]\s+){2,}[a-z],\s*([a-z]+)/i);
    if (spellingWithName) {
        // Use the actual name after the comma
        customerName = spellingWithName[2];
    } else {
        // Check if it's ONLY letter-by-letter spelling (e.g., "B o b" or "n a y a n")
        const onlySpelling = userResponse.match(/^([a-z]\s+)+[a-z]$/i);
        if (onlySpelling) {
            // Join the letters together to form the name
            customerName = userResponse.replace(/\s+/g, '');
        } else {
            // Regular name, just clean it up
            customerName = userResponse
                .replace(/[.,!?]$/g, '')
                .trim();
        }
    }

    console.log(`Input:  "${input}"`);
    console.log(`Output: "${customerName}"`);
    console.log('---');
});
