import emailService from './email-service.js';

console.log('📧 Testing Email Service...\n');

// Test order data
const testOrderData = {
    customer_name: 'Test Customer',
    customer_phone: '(973) 555-1234',
    items: '2 Chicken Tikka Masala, 1 Garlic Naan, 1 Mango Lassi',
    order_summary: 'Items: 2 Chicken Tikka Masala, 1 Garlic Naan, 1 Mango Lassi. Total: $45.00. Pickup in 25-30 minutes.',
    timestamp: new Date().toISOString(),
    session_id: 'test-session-123456',
    source: 'voice_call'
};

console.log('Test Order Data:');
console.log(JSON.stringify(testOrderData, null, 2));
console.log('');

console.log('Sending test email...');
console.log('This will send an email to:', process.env.EMAIL_TO || 'jalwamcnj@gmail.com');
console.log('');

const result = await emailService.sendOrderConfirmation(testOrderData);

if (result.success) {
    console.log('✅ Email sent successfully!');
    console.log('   Message ID:', result.messageId);
    console.log('   Recipient:', result.recipient);
    console.log('');
    console.log('📬 Check the inbox at', result.recipient, 'for the test email');
} else {
    console.error('❌ Email failed to send');
    console.error('   Error:', result.error);
    console.log('');
    console.log('💡 Make sure you have configured EMAIL_USER and EMAIL_PASS in your .env file');
    console.log('   For Gmail, you need to use an App Password:');
    console.log('   1. Go to https://myaccount.google.com/apppasswords');
    console.log('   2. Generate a new app password');
    console.log('   3. Add it to your .env file as EMAIL_PASS');
}
