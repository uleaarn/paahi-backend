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
    const menuPath = path.join(__dirname, 'data', 'menu.json');
    const instructionsPath = path.join(__dirname, 'prompts', 'system-instructions.md');

    menu = JSON.parse(fs.readFileSync(menuPath, 'utf-8'));
    systemInstructions = fs.readFileSync(instructionsPath, 'utf-8');
    console.log('✅ Menu and Instructions loaded successfully');
} catch (error) {
    console.error('❌ Failed to load required files:', error);
    process.exit(1);
}

// Initialize Fastify
const fastify = Fastify({ logger: true });
await fastify.register(FastifyWebSocket);
await fastify.register(FastifyFormBody);

// Audio conversion utilities
class AudioConverter {
    static mulawToPCM16_24kHz(mulawBuffer) {
        const pcm16_8kHz = this.decodeMulaw(mulawBuffer);
        return this.resample(pcm16_8kHz, 8000, 24000);
    }

    static pcm16_24kHzToMulaw(pcm16Buffer) {
        const pcm16_8kHz = this.resample(pcm16Buffer, 24000, 8000);
        return this.encodeMulaw(pcm16_8kHz);
    }

    static decodeMulaw(mulawBuffer) {
        const pcm16Buffer = Buffer.alloc(mulawBuffer.length * 2);
        for (let i = 0; i < mulawBuffer.length; i++) {
            const mulaw = mulawBuffer[i];
            const pcm = this.mulawToPcm(mulaw);
            pcm16Buffer.writeInt16LE(pcm, i * 2);
        }
        return pcm16Buffer;
    }

    static encodeMulaw(pcm16Buffer) {
        const mulawBuffer = Buffer.alloc(pcm16Buffer.length / 2);
        for (let i = 0; i < mulawBuffer.length; i++) {
            const pcm = pcm16Buffer.readInt16LE(i * 2);
            mulawBuffer[i] = this.pcmToMulaw(pcm);
        }
        return mulawBuffer;
    }

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

    static pcmToMulaw(pcm) {
        const MULAW_MAX = 0x1FFF;
        const MULAW_BIAS = 33;
        const sign = pcm < 0 ? 0x80 : 0x00;
        let sample = Math.abs(pcm) + MULAW_BIAS;
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
        this.currentOrder = { items: [], customerInfo: {}, timestamp: null };
    }

    addItem(item) { this.currentOrder.items.push(item); }
    setCustomerInfo(info) { this.currentOrder.customerInfo = { ...this.currentOrder.customerInfo, ...info }; }

    calculateTotal() {
        return this.currentOrder.items.reduce((total, item) => {
            let itemTotal = (item.price || 0) * (item.quantity || 1);
            if (item.modifiers && menu.modifiers) {
                item.modifiers.forEach(modId => {
                    if (menu.modifiers[modId] && menu.modifiers[modId].price) {
                        itemTotal += menu.modifiers[modId].price * (item.quantity || 1);
                    }
                });
            }
            return total + itemTotal;
        }, 0);
    }

    async submitOrder(args) {
        if (!N8N_WEBHOOK_URL) {
            console.warn('⚠️  N8N_WEBHOOK_URL not configured');
            return { success: false, message: 'Webhook not configured' };
        }

        if (args) {
            if (args.items) this.currentOrder.items = args.items;
            if (args.customerInfo) this.currentOrder.customerInfo = args.customerInfo;
        }

        this.currentOrder.timestamp = new Date().toISOString();
        this.currentOrder.total = this.calculateTotal();

        console.log('📤 Submitting order to n8n:', JSON.stringify(this.currentOrder, null, 2));

        if (this.currentOrder.items.length === 0) {
            console.warn('⚠️ WARNING: Submitting an order with 0 items.');
        }

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

    reset() { this.currentOrder = { items: [], customerInfo: {}, timestamp: null }; }
}

// WebSocket route for Twilio Media Streams
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('📞 Twilio connected');

        let streamSid = null;
        let geminiWs = null;
        let retryCount = 0;
        const MAX_RETRIES = 5;
        const INITIAL_RETRY_DELAY = 2000; // 2 seconds
        const orderManager = new OrderManager();

        const connectToGemini = () => {
            const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;
            console.log('🌐 Connecting to Gemini:', url.split('?')[0]);

            geminiWs = new WebSocket(url);

            geminiWs.on('open', () => {
                console.log('🤖 Connected to Gemini Live API');

                const currentTime = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
                const setupMessage = {
                    setup: {
                        model: "models/gemini-2.0-flash-exp",
                        generation_config: {
                            response_modalities: ["AUDIO", "TEXT"],
                            speech_config: {
                                voice_config: { prebuilt_voice_config: { voice_name: "Aoede" } }
                            }
                        },
                        system_instruction: {
                            parts: [
                                { text: `Current Server Time: ${currentTime}\n\n${systemInstructions}\n\n## Menu Data\n${JSON.stringify(menu, null, 2)}` }
                            ]
                        },
                        tools: [
                            {
                                function_declarations: [
                                    {
                                        name: "submit_order",
                                        description: "MANDATORY: Call this immediately after the user provides their name and phone number. This tool call is the only way to save the order to the database. DO NOT finalize the conversation until this tool call returns success. Structure the items correctly with price and quantity.",
                                        parameters: {
                                            type: "object",
                                            properties: {
                                                items: {
                                                    type: "array",
                                                    items: {
                                                        type: "object",
                                                        properties: {
                                                            name: { type: "string" },
                                                            quantity: { type: "integer" },
                                                            price: { type: "number" },
                                                            modifiers: { type: "array", items: { type: "string" } }
                                                        },
                                                        required: ["name", "quantity"]
                                                    }
                                                },
                                                customerInfo: {
                                                    type: "object",
                                                    properties: {
                                                        name: { type: "string" },
                                                        phone: { type: "string" },
                                                        address: { type: "string" }
                                                    },
                                                    required: ["name", "phone"]
                                                }
                                            },
                                            required: ["items", "customerInfo"]
                                        }
                                    }
                                ]
                            }
                        ]
                    }
                };

                console.log('📤 Sending Setup:', JSON.stringify(setupMessage, null, 2).substring(0, 1000) + '...');
                geminiWs.send(JSON.stringify(setupMessage));
            });

            geminiWs.on('message', async (data) => {
                try {
                    const response = JSON.parse(data.toString());

                    const setupComplete = response.setupComplete || response.setup_complete;
                    if (setupComplete) {
                        console.log('✅ Received SetupComplete from Gemini');
                        const greetingMessage = {
                            client_content: {
                                turns: [{ role: "user", parts: [{ text: "Start the conversation by greeting the customer warmly." }] }],
                                turn_complete: true
                            }
                        };
                        geminiWs.send(JSON.stringify(greetingMessage));
                        return;
                    }

                    const serverContent = response.serverContent || response.server_content;
                    if (serverContent) {
                        const { modelTurn, turnComplete, interrupted, model_turn, turn_complete } = serverContent;
                        const turn = modelTurn || model_turn;
                        const isComplete = turnComplete || turn_complete;

                        if (interrupted && streamSid) {
                            console.log('⚠️ Gemini Interrupted - Clearing Twilio Buffer');
                            connection.send(JSON.stringify({ event: 'clear', streamSid }));
                        }

                        if (turn && turn.parts) {
                            for (const part of turn.parts) {
                                // DIAGNOSTIC: Log parts that aren't pure audio
                                if (!part.inlineData && !part.inline_data) {
                                    console.log('📦 Gemini Part:', JSON.stringify(part, null, 2));
                                }

                                // 1. Audio Handling
                                const inlineData = part.inlineData || part.inline_data;
                                if (inlineData && inlineData.mimeType.startsWith('audio/pcm')) {
                                    const pcm16Buffer = Buffer.from(inlineData.data, 'base64');
                                    const mulawBuffer = AudioConverter.pcm16_24kHzToMulaw(pcm16Buffer);
                                    if (streamSid) {
                                        connection.send(JSON.stringify({
                                            event: 'media',
                                            streamSid,
                                            media: { payload: mulawBuffer.toString('base64') }
                                        }));
                                    }
                                }

                                // 1b. Text/Transcript Handling (If TEXT modality enabled)
                                if (part.text) {
                                    console.log('💬 Gemini Text:', part.text);
                                }

                                // 2. Tool Call Handling
                                const call = part.call || part.functionCall || part.function_call;
                                if (call) {
                                    console.log('🛠️ Gemini ToolCall:', call.name);
                                    console.log('📦 Tool Args:', JSON.stringify(call.args, null, 2));
                                    const { name, args, id } = call;

                                    if (name === 'submit_order') {
                                        const result = await orderManager.submitOrder(args);
                                        geminiWs.send(JSON.stringify({
                                            tool_response: {
                                                function_responses: [{ id, name, response: { result } }]
                                            }
                                        }));
                                        console.log('📤 Sent tool response back to Gemini');
                                    }
                                }
                            }
                        }

                        if (isComplete) console.log('🏁 Gemini TurnComplete');
                    }
                } catch (err) {
                    console.error('❌ Gemini Msg Error:', err);
                }
            });

            geminiWs.on('error', (err) => console.error('❌ Gemini WS Error:', err));
            geminiWs.on('close', (code, reason) => {
                console.log(`🤖 Gemini closed: ${code} - ${reason}`);

                // Check for quota error
                const reasonStr = reason ? reason.toString() : '';
                if (reasonStr.toLowerCase().includes('quota')) {
                    console.error('🛑 QUOTA EXCEEDED: Please check your Google AI Studio quota or status.');
                }

                // Attempt to reconnect if stream is still active and retries remain
                if (streamSid) {
                    if (retryCount < MAX_RETRIES) {
                        const delay = INITIAL_RETRY_DELAY * Math.pow(2, retryCount);
                        retryCount++;
                        console.log(`🔄 Attempting to reconnect (Attempt ${retryCount}/${MAX_RETRIES}) in ${delay}ms...`);
                        setTimeout(connectToGemini, delay);
                    } else {
                        console.error('❌ Max retries reached. Stopping Gemini reconnection.');
                    }
                }
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
                        console.log('🎙️ Stream started:', streamSid);
                        break;
                    case 'media':
                        if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
                            const mulawBuffer = Buffer.from(msg.media.payload, 'base64');
                            const pcm16Buffer = AudioConverter.mulawToPCM16_24kHz(mulawBuffer);
                            const audioMessage = {
                                realtime_input: {
                                    media_chunks: [{ mime_type: "audio/pcm", data: pcm16Buffer.toString('base64') }]
                                }
                            };
                            geminiWs.send(JSON.stringify(audioMessage));

                            if (Math.random() < 0.05) {
                                console.log(`🎤 Sending audio to Gemini (RMS: ${AudioConverter.calculateRMS(pcm16Buffer).toFixed(2)})`);
                            }
                        }
                        break;
                    case 'stop':
                        console.log('🛑 Stream stopped');
                        if (geminiWs) geminiWs.close();
                        break;
                }
            } catch (error) {
                console.error('❌ Twilio Msg Error:', error);
            }
        });

        connection.on('close', () => {
            console.log('👋 Twilio disconnected');
            if (geminiWs) geminiWs.close();
        });
    });
});

// Generic routes
fastify.get('/health', async () => ({ status: 'ok' }));

fastify.all('/twiml', async (request, reply) => {
    const host = request.headers.host || 'localhost';
    const protocol = host.includes('localhost') ? 'ws' : 'wss';
    const wsUrl = `${protocol}://${host}/media-stream`;

    reply.type('text/xml');
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${wsUrl}" /></Connect></Response>`;
});

// Start server
const start = async () => {
    try {
        await fastify.listen({ port: PORT, host: '0.0.0.0' });
        console.log(`🚀 Server running on port ${PORT}`);
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};

start();
