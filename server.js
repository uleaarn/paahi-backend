import Fastify from 'fastify';
import FastifyWebSocket from '@fastify/websocket';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { WebSocket } from 'ws';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;

if (!GEMINI_API_KEY) {
    console.error('❌ GEMINI_API_KEY is required');
    process.exit(1);
}

// Load menu and system instructions
const menu = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'menu.json'), 'utf-8'));
const systemInstructions = fs.readFileSync(path.join(__dirname, 'prompts', 'system-instructions.md'), 'utf-8');

// Initialize Fastify
const fastify = Fastify({ logger: true });
await fastify.register(FastifyWebSocket);

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// Audio conversion utilities
class AudioConverter {
    /**
     * Convert Twilio's 8kHz μ-law to Gemini's 24kHz PCM16
     * @param {Buffer} mulawBuffer - μ-law encoded audio from Twilio
     * @returns {Buffer} - PCM16 audio at 24kHz
     */
    static mulawToPCM16_24kHz(mulawBuffer) {
        // Step 1: Decode μ-law to PCM16 at 8kHz
        const pcm16_8kHz = this.decodeMulaw(mulawBuffer);

        // Step 2: Resample from 8kHz to 24kHz
        const pcm16_24kHz = this.resample(pcm16_8kHz, 8000, 24000);

        return pcm16_24kHz;
    }

    /**
     * Convert Gemini's 24kHz PCM16 to Twilio's 8kHz μ-law
     * @param {Buffer} pcm16Buffer - PCM16 audio at 24kHz from Gemini
     * @returns {Buffer} - μ-law encoded audio at 8kHz
     */
    static pcm16_24kHzToMulaw(pcm16Buffer) {
        // Step 1: Resample from 24kHz to 8kHz
        const pcm16_8kHz = this.resample(pcm16Buffer, 24000, 8000);

        // Step 2: Encode PCM16 to μ-law
        const mulawBuffer = this.encodeMulaw(pcm16_8kHz);

        return mulawBuffer;
    }

    /**
     * Decode μ-law to PCM16
     * @param {Buffer} mulawBuffer
     * @returns {Buffer} PCM16 buffer
     */
    static decodeMulaw(mulawBuffer) {
        const pcm16Buffer = Buffer.alloc(mulawBuffer.length * 2);

        for (let i = 0; i < mulawBuffer.length; i++) {
            const mulaw = mulawBuffer[i];
            const pcm = this.mulawToPcm(mulaw);
            pcm16Buffer.writeInt16LE(pcm, i * 2);
        }

        return pcm16Buffer;
    }

    /**
     * Encode PCM16 to μ-law
     * @param {Buffer} pcm16Buffer
     * @returns {Buffer} μ-law buffer
     */
    static encodeMulaw(pcm16Buffer) {
        const mulawBuffer = Buffer.alloc(pcm16Buffer.length / 2);

        for (let i = 0; i < mulawBuffer.length; i++) {
            const pcm = pcm16Buffer.readInt16LE(i * 2);
            const mulaw = this.pcmToMulaw(pcm);
            mulawBuffer[i] = mulaw;
        }

        return mulawBuffer;
    }

    /**
     * μ-law to PCM conversion (single sample)
     */
    static mulawToPcm(mulaw) {
        const MULAW_BIAS = 33;
        mulaw = ~mulaw;
        const sign = mulaw & 0x80;
        const exponent = (mulaw >> 4) & 0x07;
        const mantissa = mulaw & 0x0F;
        let sample = mantissa << (exponent + 3);
        sample += MULAW_BIAS << exponent;
        if (sign) sample = -sample;
        return sample;
    }

    /**
     * PCM to μ-law conversion (single sample)
     */
    static pcmToMulaw(pcm) {
        const MULAW_MAX = 0x1FFF;
        const MULAW_BIAS = 33;

        const sign = pcm < 0 ? 0x80 : 0x00;
        let sample = Math.abs(pcm);
        sample += MULAW_BIAS;
        if (sample > MULAW_MAX) sample = MULAW_MAX;

        let exponent = 7;
        for (let exp = 0; exp < 8; exp++) {
            if (sample <= (MULAW_BIAS << (exp + 1))) {
                exponent = exp;
                break;
            }
        }

        const mantissa = (sample >> (exponent + 3)) & 0x0F;
        const mulaw = ~(sign | (exponent << 4) | mantissa);
        return mulaw & 0xFF;
    }

    /**
     * Simple linear resampling
     * @param {Buffer} inputBuffer - PCM16 buffer
     * @param {number} inputRate - Input sample rate
     * @param {number} outputRate - Output sample rate
     * @returns {Buffer} Resampled PCM16 buffer
     */
    static resample(inputBuffer, inputRate, outputRate) {
        const inputSamples = inputBuffer.length / 2;
        const outputSamples = Math.floor(inputSamples * outputRate / inputRate);
        const outputBuffer = Buffer.alloc(outputSamples * 2);

        const ratio = inputSamples / outputSamples;

        for (let i = 0; i < outputSamples; i++) {
            const srcIndex = Math.floor(i * ratio);
            const sample = inputBuffer.readInt16LE(srcIndex * 2);
            outputBuffer.writeInt16LE(sample, i * 2);
        }

        return outputBuffer;
    }
}

// Order management
class OrderManager {
    constructor() {
        this.currentOrder = {
            items: [],
            customerInfo: {},
            timestamp: null
        };
    }

    addItem(item) {
        this.currentOrder.items.push(item);
    }

    setCustomerInfo(info) {
        this.currentOrder.customerInfo = { ...this.currentOrder.customerInfo, ...info };
    }

    calculateTotal() {
        return this.currentOrder.items.reduce((total, item) => {
            let itemTotal = item.price * (item.quantity || 1);

            // Add modifier costs
            if (item.modifiers) {
                item.modifiers.forEach(modId => {
                    if (menu.modifiers[modId] && menu.modifiers[modId].price) {
                        itemTotal += menu.modifiers[modId].price * (item.quantity || 1);
                    }
                });
            }

            return total + itemTotal;
        }, 0);
    }

    async submitOrder() {
        if (!N8N_WEBHOOK_URL) {
            console.warn('⚠️  N8N_WEBHOOK_URL not configured, order not sent');
            return { success: false, message: 'Webhook not configured' };
        }

        this.currentOrder.timestamp = new Date().toISOString();
        this.currentOrder.total = this.calculateTotal();

        try {
            const response = await fetch(N8N_WEBHOOK_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(this.currentOrder)
            });

            if (response.ok) {
                console.log('✅ Order submitted successfully');
                return { success: true, order: this.currentOrder };
            } else {
                console.error('❌ Failed to submit order:', response.statusText);
                return { success: false, message: response.statusText };
            }
        } catch (error) {
            console.error('❌ Error submitting order:', error);
            return { success: false, message: error.message };
        }
    }

    reset() {
        this.currentOrder = {
            items: [],
            customerInfo: {},
            timestamp: null
        };
    }

    getOrder() {
        return this.currentOrder;
    }
}

// WebSocket route for Twilio Media Streams
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('📞 Twilio connected');

        let geminiWs = null;
        let streamSid = null;
        const orderManager = new OrderManager();

        // Connect to Gemini Live API
        const connectToGemini = async () => {
            const model = genAI.getGenerativeModel({
                model: 'gemini-2.0-flash-exp',
                systemInstruction: `${systemInstructions}\n\n## Menu Data\n${JSON.stringify(menu, null, 2)}`
            });

            try {
                const session = await model.startChat({
                    generationConfig: {
                        responseModalities: 'audio',
                        speechConfig: {
                            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } }
                        }
                    }
                });

                geminiWs = session;
                console.log('🤖 Connected to Gemini Live API');

                // Send initial greeting
                await session.sendMessage('Start the conversation by greeting the customer warmly.');

            } catch (error) {
                console.error('❌ Failed to connect to Gemini:', error);
            }
        };

        connectToGemini();

        // Handle Twilio messages
        connection.on('message', async (message) => {
            try {
                const msg = JSON.parse(message.toString());

                switch (msg.event) {
                    case 'start':
                        streamSid = msg.start.streamSid;
                        console.log('🎙️  Stream started:', streamSid);
                        break;

                    case 'media':
                        if (geminiWs && msg.media.payload) {
                            // Decode base64 μ-law audio from Twilio
                            const mulawBuffer = Buffer.from(msg.media.payload, 'base64');

                            // Convert to 24kHz PCM16 for Gemini
                            const pcm16Buffer = AudioConverter.mulawToPCM16_24kHz(mulawBuffer);

                            // Send to Gemini (you'll need to implement Gemini's audio input format)
                            // This is a placeholder - actual implementation depends on Gemini's API
                            await geminiWs.sendMessage({
                                audio: pcm16Buffer.toString('base64')
                            });
                        }
                        break;

                    case 'stop':
                        console.log('📴 Stream stopped');
                        if (geminiWs) {
                            geminiWs.close();
                        }
                        break;
                }
            } catch (error) {
                console.error('❌ Error processing message:', error);
            }
        });

        // Handle Gemini responses
        // Note: This is a placeholder - actual implementation depends on Gemini's streaming API
        const handleGeminiResponse = async (audioData) => {
            try {
                // Convert Gemini's 24kHz PCM16 to Twilio's 8kHz μ-law
                const pcm16Buffer = Buffer.from(audioData, 'base64');
                const mulawBuffer = AudioConverter.pcm16_24kHzToMulaw(pcm16Buffer);

                // Send to Twilio
                connection.send(JSON.stringify({
                    event: 'media',
                    streamSid: streamSid,
                    media: {
                        payload: mulawBuffer.toString('base64')
                    }
                }));
            } catch (error) {
                console.error('❌ Error sending audio to Twilio:', error);
            }
        };

        connection.on('close', () => {
            console.log('📴 Twilio disconnected');
            if (geminiWs) {
                geminiWs.close();
            }
        });

        connection.on('error', (error) => {
            console.error('❌ WebSocket error:', error);
        });
    });
});

// Health check endpoint
fastify.get('/health', async (request, reply) => {
    return { status: 'ok', service: 'Jalwa Voice Agent' };
});

// Start server
const start = async () => {
    try {
        await fastify.listen({ port: PORT, host: '0.0.0.0' });
        console.log(`
╔════════════════════════════════════════════════════════╗
║                                                        ║
║   🎙️  Jalwa Voice Agent Server Running                ║
║                                                        ║
║   Port: ${PORT}                                       ║
║   WebSocket: /media-stream                            ║
║   Health: /health                                     ║
║                                                        ║
╚════════════════════════════════════════════════════════╝
    `);
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};

start();
