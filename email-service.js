import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

// Email configuration from environment variables.
// Resend (HTTPS API) is used when RESEND_API_KEY is set. Railway's Hobby plan
// blocks outgoing SMTP, so Gmail (SMTP) only works on hosts that allow it.
const RESEND_API_URL = 'https://api.resend.com/emails';
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
const EMAIL_TO = process.env.EMAIL_TO || 'orders@example.com';
const RESTAURANT_NAME = process.env.RESTAURANT_NAME || 'Your Restaurant';
const RESTAURANT_LOCATION = process.env.RESTAURANT_LOCATION || '';
const RESTAURANT_PHONE = process.env.RESTAURANT_PHONE || '';

/**
 * Email Service for Order Notifications
 * Sends formatted order confirmation emails to restaurant
 */
export class EmailService {
    constructor({ env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
        this.transporter = null;
        this.configured = false;
        this.provider = null;
        this.fetch = fetchImpl;
        this.timeoutMs = timeoutMs;
        this.resendKey = env.RESEND_API_KEY || null;
        // Without a verified domain, Resend only sends from onboarding@resend.dev
        // to the Resend account's own email address.
        this.resendFrom = env.RESEND_FROM || 'onboarding@resend.dev';
        if (this.resendKey) {
            this.provider = 'resend';
            this.configured = true;
            console.log(`✅ Email via Resend (from ${this.resendFrom})`);
            return;
        }
        this.initialize();
    }

    /**
     * Initialize Gmail SMTP transporter
     */
    initialize() {
        if (!EMAIL_USER || !EMAIL_PASS) {
            console.warn('⚠️ Email service not configured (missing EMAIL_USER or EMAIL_PASS)');
            console.warn('   Order confirmations will not be sent via email');
            return;
        }

        try {
            this.transporter = nodemailer.createTransport({
                service: 'gmail',
                auth: {
                    user: EMAIL_USER,
                    pass: EMAIL_PASS
                }
            });

            this.configured = true;
            this.provider = 'gmail';
            console.log(`✅ Email via Gmail SMTP (sending to: ${EMAIL_TO})`);

        } catch (error) {
            console.error('❌ Failed to initialize email service:', error.message);
        }
    }

    /**
     * Format order data as HTML email
     * @param {Object} orderData - Order information
     * @returns {string} HTML email content
     */
    formatOrderEmail(orderData) {
        const {
            customer_name,
            customer_phone,
            items,
            order_summary,
            timestamp,
            session_id,
            business_name = RESTAURANT_NAME
        } = orderData;

        const formattedTime = new Date(timestamp).toLocaleString('en-US', {
            timeZone: 'America/New_York',
            dateStyle: 'full',
            timeStyle: 'short'
        });

        return `
<!DOCTYPE html>
<html>
<head>
    <style>
        body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
        }
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 30px;
            border-radius: 10px 10px 0 0;
            text-align: center;
        }
        .header h1 {
            margin: 0;
            font-size: 28px;
        }
        .content {
            background: #f9f9f9;
            padding: 30px;
            border: 1px solid #ddd;
            border-top: none;
        }
        .section {
            background: white;
            padding: 20px;
            margin-bottom: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .section h2 {
            margin-top: 0;
            color: #667eea;
            font-size: 18px;
            border-bottom: 2px solid #667eea;
            padding-bottom: 10px;
        }
        .info-row {
            display: flex;
            justify-content: space-between;
            padding: 8px 0;
            border-bottom: 1px solid #eee;
        }
        .info-row:last-child {
            border-bottom: none;
        }
        .label {
            font-weight: bold;
            color: #555;
        }
        .value {
            color: #333;
        }
        .items-list {
            background: #fff8e1;
            padding: 15px;
            border-left: 4px solid #ffc107;
            margin: 10px 0;
        }
        .footer {
            text-align: center;
            padding: 20px;
            color: #777;
            font-size: 12px;
        }
        .badge {
            display: inline-block;
            background: #4caf50;
            color: white;
            padding: 5px 15px;
            border-radius: 20px;
            font-size: 14px;
            font-weight: bold;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>🎉 New Phone Order Received!</h1>
        <p style="margin: 10px 0 0 0; font-size: 16px;">${business_name}</p>
    </div>
    
    <div class="content">
        <div class="section">
            <h2>📞 Customer Information</h2>
            <div class="info-row">
                <span class="label">Name:</span>
                <span class="value">${customer_name || 'Not provided'}</span>
            </div>
            <div class="info-row">
                <span class="label">Phone:</span>
                <span class="value">${customer_phone || 'Not provided'}</span>
            </div>
            <div class="info-row">
                <span class="label">Order Time:</span>
                <span class="value">${formattedTime}</span>
            </div>
        </div>

        <div class="section">
            <h2>🍛 Order Details</h2>
            <div class="items-list">
                <strong>Items:</strong><br>
                ${items || 'See order summary below'}
            </div>
            ${order_summary ? `
            <div style="margin-top: 15px;">
                <strong>Summary:</strong><br>
                ${order_summary}
            </div>
            ` : ''}
        </div>

        <div class="section">
            <h2>⏱️ Preparation Time</h2>
            <p style="margin: 10px 0;">
                <span class="badge">Ready in 25-30 minutes</span>
            </p>
            <p style="margin: 10px 0; color: #666; font-size: 14px;">
                Customer has been notified of pickup time
            </p>
        </div>

        <div class="section">
            <h2>🔍 Technical Details</h2>
            <div class="info-row">
                <span class="label">Order Source:</span>
                <span class="value">Voice Call (AI Agent)</span>
            </div>
            <div class="info-row">
                <span class="label">Session ID:</span>
                <span class="value" style="font-family: monospace; font-size: 11px;">${session_id || 'N/A'}</span>
            </div>
        </div>
    </div>

    <div class="footer">
        <p>This is an automated notification from Paahi for ${business_name}</p>
        <p>${[RESTAURANT_LOCATION, RESTAURANT_PHONE].filter(Boolean).join(' | ')}</p>
    </div>
</body>
</html>
        `;
    }

    /**
     * Send order confirmation email
     * @param {Object} orderData - Order information
     * @returns {Promise<Object>} Result of email send
     */
    /**
     * @param {object} orderData
     * @param {{ to?: string, businessName?: string }} [options] per-business recipient and name
     */
    /** Send through Resend's HTTPS API. The idempotency key stops duplicates on retry. */
    async sendViaResend({ from, to, subject, html, text }, idempotencyKey) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const res = await this.fetch(RESEND_API_URL, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${this.resendKey}`,
                    'Content-Type': 'application/json',
                    ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
                },
                body: JSON.stringify({ from, to: [to], subject, html, text }),
                signal: controller.signal,
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(`Resend HTTP ${res.status}: ${body.message || body.name || 'error'}`);
            return { messageId: body.id };
        } catch (error) {
            throw error.name === 'AbortError' ? new Error('Resend timed out') : error;
        } finally {
            clearTimeout(timer);
        }
    }

    async sendOrderConfirmation(orderData, { to = EMAIL_TO, businessName = orderData.business_name || RESTAURANT_NAME, idempotencyKey = null } = {}) {
        if (!this.configured) {
            console.warn('⚠️ Email service not configured, skipping email notification');
            return { success: false, error: 'Email service not configured' };
        }

        try {
            const htmlContent = this.formatOrderEmail({ ...orderData, business_name: businessName });
            const scheduled = orderData.pickup_time && orderData.pickup_time !== 'ASAP' ? ` (SCHEDULED ${orderData.pickup_time})` : '';
            const subject = `${orderData.type === 'callback_request' ? 'CALL BACK' : 'New Order'}: ${orderData.customer_name || 'Customer'} - ${new Date(orderData.timestamp).toLocaleTimeString('en-US', { timeZone: 'America/New_York' })}${scheduled}`;

            const mailOptions = {
                from: `"${businessName} via Paahi" <${this.provider === 'resend' ? this.resendFrom : EMAIL_USER}>`,
                to,
                subject: subject,
                html: htmlContent,
                text: `New order from ${orderData.customer_name || 'Customer'}\nPhone: ${orderData.customer_phone}\nItems: ${orderData.items}\n\nOrder Summary: ${orderData.order_summary}`
            };

            console.log(`📧 Sending ${orderData.type === 'callback_request' ? 'callback request' : 'order'} email for ${businessName}...`);
            const info = this.provider === 'resend'
                ? await this.sendViaResend(mailOptions, idempotencyKey)
                : await this.transporter.sendMail(mailOptions);

            console.log(`✅ Email sent successfully: ${info.messageId}`);
            return {
                success: true,
                messageId: info.messageId,
                recipient: to
            };

        } catch (error) {
            console.error('❌ Failed to send email:', error.message);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Send test email to verify configuration
     * @returns {Promise<Object>} Result of test email
     */
    async sendTestEmail() {
        if (!this.configured) {
            return { success: false, error: 'Email service not configured' };
        }

        const testOrderData = {
            customer_name: 'Test Customer',
            customer_phone: '(123) 456-7890',
            items: '2 Chicken Tikka Masala, 1 Garlic Naan',
            order_summary: 'Test order from email service',
            timestamp: new Date().toISOString(),
            session_id: 'test-session-123'
        };

        return await this.sendOrderConfirmation(testOrderData);
    }
}

// Export singleton instance
const emailService = new EmailService();
export default emailService;
