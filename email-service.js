import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
import { ticketHtml, ticketText, ticketSubject } from './staff-ticket.js';

dotenv.config();

// Email configuration from environment variables.
// Resend (HTTPS API) is used when RESEND_API_KEY is set. Railway's Hobby plan
// blocks outgoing SMTP, so Gmail (SMTP) only works on hosts that allow it.
const RESEND_API_URL = 'https://api.resend.com/emails';
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
const EMAIL_TO = process.env.EMAIL_TO || 'orders@example.com';
const RESTAURANT_NAME = process.env.RESTAURANT_NAME || 'Your Restaurant';

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

    /** Print-friendly staff ticket (see staff-ticket.js). */
    formatOrderEmail(orderData) {
        return ticketHtml(orderData);
    }

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
            const subject = ticketSubject(orderData);

            const mailOptions = {
                from: `"${businessName} via Paahi" <${this.provider === 'resend' ? this.resendFrom : EMAIL_USER}>`,
                to,
                subject: subject,
                html: htmlContent,
                text: ticketText(orderData),
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
