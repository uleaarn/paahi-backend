import Fastify from 'fastify';
import FastifyWebSocket from '@fastify/websocket';
import FastifyFormBody from '@fastify/formbody';
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

// Load menu and system instructions with better error handling
let menu, systemInstructions;

try {
    console.log('📂 Current directory:', __dirname);
    console.log('📂 Files in current directory:', fs.readdirSync(__dirname));

    const menuPath = path.join(__dirname, 'data', 'menu.json');
    const instructionsPath = path.join(__dirname, 'prompts', 'system-instructions.md');

    console.log('📄 Loading menu from:', menuPath);
    console.log('📄 Menu file exists:', fs.existsSync(menuPath));

    if (fs.existsSync(path.join(__dirname, 'data'))) {
        console.log('📂 Files in data directory:', fs.readdirSync(path.join(__dirname, 'data')));
    } else {
        console.error('❌ data directory does not exist!');
    }

    menu = JSON.parse(fs.readFileSync(menuPath, 'utf-8'));
    console.log('✅ Menu loaded successfully');

    console.log('📄 Loading instructions from:', instructionsPath);
    console.log('📄 Instructions file exists:', fs.existsSync(instructionsPath));

    if (fs.existsSync(path.join(__dirname, 'prompts'))) {
        console.log('📂 Files in prompts directory:', fs.readdirSync(path.join(__dirname, 'prompts')));
    } else {
        console.error('❌ prompts directory does not exist!');
    }

    systemInstructions = fs.readFileSync(instructionsPath, 'utf-8');
    console.log('✅ System instructions loaded successfully');
} catch (error) {
    console.error('❌ Failed to load required files:', error);
    console.error('Error details:', {
        message: error.message,
        code: error.code,
        syscall: error.syscall,
        path: error.path
    });
    process.exit(1);
}

// Initialize Fastify
const fastify = Fastify({ logger: true });
await fastify.register(FastifyWebSocket);
await fastify.register(FastifyFormBody);

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// Audio conversion utilities
class AudioConverter {
    /**
     * Convert Twilio's 8kHz μ-law to Gemini's 16kHz PCM16
     * @param {Buffer} mulawBuffer - μ-law encoded audio from Twilio
     * @returns {Buffer} - PCM16 audio at 16kHz
     */
    static mulawToPCM16_16kHz(mulawBuffer) {
        // Step 1: Decode μ-law to PCM16 at 8kHz
        const pcm16_8kHz = this.decodeMulaw(mulawBuffer);

        // Step 2: Resample from 8kHz to 16kHz
        const pcm16_16kHz = this.resample(pcm16_8kHz, 8000, 16000);

        return pcm16_16kHz;
    }

    /**
     * Convert Gemini's 16kHz PCM16 to Twilio's 8kHz μ-law
     * @param {Buffer} pcm16Buffer - PCM16 audio at 16kHz from Gemini
     * @returns {Buffer} - μ-law encoded audio at 8kHz
     */
    static pcm16_16kHzToMulaw(pcm16Buffer) {
        // Step 1: Resample from 16kHz to 8kHz
        const pcm16_8kHz = this.resample(pcm16Buffer, 16000, 8000);

        // Step 2: Encode PCM16 to μ-law
        const mulawBuffer = this.encodeMulaw(pcm16_8kHz);

        return mulawBuffer;
    }

    /**
     * Convert Gemini's 24kHz PCM16 to Twilio's 8kHz μ-law
     * Note: Gemini output is usually 24kHz by default, so we keep this one as is or handle dynamic rates if needed.
     * We'll assume Gemini KEEPS sending 24kHz for now.
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

    static calculateRMS(buffer) {
        let sum = 0;
        for (let i = 0; i < buffer.length; i += 2) {
            const sample = buffer.readInt16LE(i);
            sum += sample * sample;
        }
        return Math.sqrt(sum / (buffer.length / 2));
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

        let streamSid = null;
        let geminiWs = null;
        const orderManager = new OrderManager();

        // Connect to Gemini Live API directly via WebSocket
        const connectToGemini = () => {
            const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;
            console.log('🌐 Connecting to Gemini:', url.split('?')[0]); // Log URL without key

            geminiWs = new WebSocket(url);

            geminiWs.on('open', () => {
                console.log('🤖 Connected to Gemini Live API');

                // 1. Send Setup Message
                const setupMessage = {
                    setup: {
                        model: "models/gemini-2.0-flash-exp",
                        generationConfig: {
                            responseModalities: ["AUDIO"],
                            speechConfig: {
                                voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } }
                            }
                        },
                        systemInstruction: {
                            parts: [
                                { text: `${systemInstructions}\n\n## Menu Data\n${JSON.stringify(menu, null, 2)}` }
                            ]
                        },
                        tools: [
                            {
                                functionDeclarations: [
                                    {
                                        name: "submit_order",
                                        description: "Finalize and submit the customer's order to the kitchen. Use this when the customer confirms they are done ordering.",
                                        parameters: {
                                            type: "OBJECT",
                                            properties: {
                                                items: {
                                                    type: "ARRAY",
                                                    description: "List of items ordered",
                                                    items: {
                                                        type: "OBJECT",
                                                        properties: {
                                                            name: { type: "STRING", description: "Name of the dish (e.g., 'Butter Chicken')" },
                                                            quantity: { type: "INTEGER", description: "Quantity ordered" },
                                                            price: { type: "NUMBER", description: "Price per unit (if known, otherwise 0)" },
                                                            modifiers: {
                                                                type: "ARRAY",
                                                                items: { type: "STRING" },
                                                                description: "List of modifiers (e.g., 'spicy', 'extra sauce')"
                                                            }
                                                        },
                                                        required: ["name", "quantity"]
                                                    }
                                                },
                                                customerInfo: {
                                                    type: "OBJECT",
                                                    properties: {
                                                        name: { type: "STRING", description: "Customer name" },
                                                        phone: { type: "STRING", description: "Customer phone number" },
                                                        address: { type: "STRING", description: "Delivery address (if applicable)" }
                                                    }
                                                }
                                            },
                                            required: ["items"]
                                        }
                                    }
                                ]
                            }
                        ]
                    }
                };
                geminiWs.send(JSON.stringify(setupMessage));

                // 2. Send Initial Greeting Trigger
                // We send a "client_content" message to prompt the AI to speak
                const greetingMessage = {
                    client_content: {
                        turns: [
                            {
                                role: "user",
                                parts: [{ text: "Start the conversation by greeting the customer warmly." }]
                            }
                        ],
                        turn_complete: true
                    }
                };
                geminiWs.send(JSON.stringify(greetingMessage));
            });

            geminiWs.on('message', async (data) => {
                try {
                    const response = JSON.parse(data.toString());

                    // Log message structure for debugging
                    if (response.serverContent) {
                        if (response.serverContent.modelTurn) {
                            console.log('🤖 Gemini sent ModelTurn (Audio/Text)');
                        }
                        if (response.serverContent.turnComplete) {
                            console.log('🏁 Gemini TurnComplete');
                        }
                        if (response.serverContent.interrupted) {
                            console.log('⚠️ Gemini Interrupted - Clearing Twilio Buffer');
                            if (streamSid) {
                                connection.send(JSON.stringify({
                                    event: 'clear',
                                    streamSid: streamSid
                                }));
                            }
                        }
                    } else if (response.toolCall) {
                        console.log('🛠️ Gemini ToolCall received');
                    } else {
                        console.log('ℹ️ Gemini sent other message:', Object.keys(response));
                    }

                    // Handle Audio Output
                    if (response.serverContent && response.serverContent.modelTurn) {
                        const parts = response.serverContent.modelTurn.parts;
                        for (const part of parts) {
                            if (part.inlineData && part.inlineData.mimeType.startsWith('audio/pcm')) {
                                // Extract PCM16 data (Base64)
                                const pcm16Base64 = part.inlineData.data;
                                const pcm16Buffer = Buffer.from(pcm16Base64, 'base64');

                                // Convert to μ-law 8kHz for Twilio
                                // Assuming 16kHz input -> 16kHz output from Gemini
                                const mulawBuffer = AudioConverter.pcm16_16kHzToMulaw(pcm16Buffer);

                                // Send to Twilio
                                if (streamSid) {
                                    connection.send(JSON.stringify({
                                        event: 'media',
                                        streamSid: streamSid,
                                        media: {
                                            payload: mulawBuffer.toString('base64')
                                        }
                                    }));
                                }
                            }
                        }
                    }

                    // Handle Tool Calls
                    if (response.toolCall) {
                        console.log('🛠️ Gemini requested tool:', JSON.stringify(response.toolCall));
                        const functionCalls = response.toolCall.functionCalls;
                        const toolResponses = [];

                        for (const call of functionCalls) {
                            if (call.name === 'submit_order') {
                                const args = call.args;
                                console.log('📦 Submitting order:', args);

                                // Update OrderManager with the details provided by AI
                                orderManager.reset(); // Clear basic state
                                if (args.items) {
                                    args.items.forEach(item => orderManager.addItem(item));
                                }
                                if (args.customerInfo) {
                                    orderManager.setCustomerInfo(args.customerInfo);
                                }

                                const result = await orderManager.submitOrder();

                                toolResponses.push({
                                    id: call.id,
                                    name: call.name,
                                    response: { result: result }
                                });
                            }
                        }

                        // Send Tool Response back to Gemini
                        const toolResponseMessage = {
                            tool_response: {
                                function_responses: toolResponses
                            }
                        };
                        geminiWs.send(JSON.stringify(toolResponseMessage));
                    }

                } catch (error) {
                    console.error('❌ Error parsing Gemini message:', error);
                }
            });

            geminiWs.on('error', (error) => {
                console.error('❌ Gemini WebSocket error:', error);
                // Speak error to user if possible
                const errorMessage = error.message || "Connection Error";
                connection.close(4000, errorMessage.substring(0, 100));
            });

            geminiWs.on('close', (code, reason) => {
                console.log(`🤖 Gemini disconnected: ${code} - ${reason}`);
            });
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
                        if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
                            // 1. Get μ-law audio from Twilio
                            const mulawPayload = msg.media.payload;
                            const mulawBuffer = Buffer.from(mulawPayload, 'base64');

                            // 2. Convert to PCM16 16kHz for Gemini
                            const pcm16Buffer = AudioConverter.mulawToPCM16_16kHz(mulawBuffer);
                            const pcm16Base64 = pcm16Buffer.toString('base64');

                            // 3. Send Realtime Input to Gemini
                            const audioMessage = {
                                realtime_input: {
                                    media_chunks: [
                                        {
                                            mime_type: "audio/pcm",
                                            data: pcm16Base64
                                        }
                                    ]
                                }
                            };
                            geminiWs.send(JSON.stringify(audioMessage));

                            // Log occasionally to verify input stream and volume
                            if (Math.random() < 0.05) { // Increased sample rate to 5% for debugging
                                const rms = AudioConverter.calculateRMS(pcm16Buffer);
                                console.log(`🎤 Sending audio chunk to Gemini (RMS: ${rms.toFixed(2)})`);
                            }
                        }
                        break;

                    case 'stop':
                        console.log('🛑 Stream stopped');
                        if (geminiWs) geminiWs.close();
                        break;
                }
            } catch (error) {
                console.error('❌ Error processing Twilio message:', error);
            }
        });

        connection.on('close', () => {
            console.log('� Twilio disconnected');
            if (geminiWs) geminiWs.close();
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

// TwiML endpoint for Twilio Voice Configuration
fastify.all('/twiml', async (request, reply) => {
    const host = request.headers.host || 'localhost';
    const protocol = host.includes('localhost') ? 'ws' : 'wss';
    const wsUrl = `${protocol}://${host}/media-stream`;

    console.log('📞 TwiML requested, WebSocket URL:', wsUrl);

    reply.type('text/xml');
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect>
        <Stream url="${wsUrl}" />
    </Connect>
    <Say>I am sorry, but the AI service is currently busy. Please try calling again in a minute.</Say>
</Response>`;
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
