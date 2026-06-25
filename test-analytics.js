import analytics from './analytics.js';

console.log('🧪 Testing Analytics System...\n');

// Test 1: Log a successful call
console.log('Test 1: Logging a successful call');
const successfulCall = analytics.logCall({
    callId: 'test-call-001',
    startTime: new Date(Date.now() - 120000).toISOString(), // 2 minutes ago
    endTime: new Date().toISOString(),
    duration: 120,
    transcript: [
        { role: 'model', parts: [{ text: 'Hello! Thank you for calling the restaurant.' }] },
        { role: 'user', parts: [{ text: 'I want to order chicken tikka masala' }] },
        { role: 'model', parts: [{ text: 'Great choice! How many would you like?' }] },
        { role: 'user', parts: [{ text: 'Two please' }] }
    ],
    orderCompleted: true,
    orderData: {
        items: ['2 Chicken Tikka Masala', '1 Garlic Naan'],
        customer_name: 'John Doe',
        customer_phone: '(123) 456-7890'
    },
    customerName: 'John Doe',
    customerPhone: '(123) 456-7890'
});

console.log('Result:', successfulCall);
console.log('');

// Test 2: Log a failed call
console.log('Test 2: Logging a failed call');
const failedCall = analytics.logCall({
    callId: 'test-call-002',
    startTime: new Date(Date.now() - 60000).toISOString(), // 1 minute ago
    endTime: new Date().toISOString(),
    duration: 60,
    transcript: [
        { role: 'model', parts: [{ text: 'Hello! Thank you for calling the restaurant.' }] },
        { role: 'user', parts: [{ text: 'Hello' }] }
    ],
    orderCompleted: false,
    failureReason: 'Customer hung up'
});

console.log('Result:', failedCall);
console.log('');

// Test 3: Get recent calls
console.log('Test 3: Getting recent calls');
const recentCalls = analytics.getRecentCalls(5);
console.log(`Found ${recentCalls.length} recent calls`);
recentCalls.forEach(call => {
    console.log(`  - ${call.callId}: ${call.orderCompleted ? '✅ SUCCESS' : '❌ FAILED'} (${call.duration}s)`);
});
console.log('');

// Test 4: Get statistics
console.log('Test 4: Getting statistics');
const stats = analytics.getStats();
console.log('Statistics:', JSON.stringify(stats, null, 2));
console.log('');

// Test 5: Get KPIs
console.log('Test 5: Getting KPIs');
const kpis = analytics.getKPIs();
console.log('KPIs:', JSON.stringify(kpis, null, 2));
console.log('');

console.log('✅ All analytics tests completed!');
console.log(`📁 Check the logs directory for saved call data`);
