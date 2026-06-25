import Fastify from 'fastify';
import FastifyWebSocket from '@fastify/websocket';
import FastifyFormBody from '@fastify/formbody';
import OpenAI from 'openai';
import { createClient } from '@deepgram/sdk';
import textToSpeech from '@google-cloud/text-to-speech';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mulaw from 'alawmulaw';
import analytics from './analytics.js';
import emailService from './email-service.js';
// Polyfill WebSocket for Deepgram SDK
globalThis.WebSocket = WebSocket;

dotenv.config();

// 🔐 Google Cloud Credentials Setup (for Railway deployment)
if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
    const credsPath = '/tmp/google-credentials.json';
    fs.writeFileSync(credsPath, process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credsPath;
    console.log('✅ Google Cloud credentials loaded from environment variable');
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const LLM_BASE_URL = process.env.LLM_BASE_URL || 'https://api.deepseek.com';
const LLM_MODEL = process.env.LLM_MODEL || 'deepseek-chat';
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
const GOOGLE_TTS_VOICE = process.env.GOOGLE_TTS_VOICE || 'en-US-Neural2-D';
const GOOGLE_TTS_LANGUAGE = process.env.GOOGLE_TTS_LANGUAGE || 'en-US';

if (!OPENAI_API_KEY || !DEEPGRAM_API_KEY) {
    console.error('❌ Missing required API keys');
    console.error('Required: OPENAI_API_KEY, DEEPGRAM_API_KEY');
    console.error('Optional: N8N_WEBHOOK_URL (for order submission)');
    process.exit(1);
}

// Load menu and system instructions
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

const RESTAURANT_NAME = process.env.RESTAURANT_NAME || menu.restaurant_name || 'the restaurant';
const RESTAURANT_LOCATION = process.env.RESTAURANT_LOCATION || menu.location || '';
const RESTAURANT_PHONE = process.env.RESTAURANT_PHONE || menu.phone || '';
const AGENT_NAME = process.env.AGENT_NAME || `${RESTAURANT_NAME} AI`;
const INITIAL_GREETING = process.env.INITIAL_GREETING ||
    `Hello! Thank you for calling ${RESTAURANT_NAME}. How can I help you today?`;

// Initialize AI clients
const openai = new OpenAI({
    apiKey: OPENAI_API_KEY,
    baseURL: LLM_BASE_URL
});
const deepgram = createClient(DEEPGRAM_API_KEY);

// Deepgram WebSocket diagnostic probe
async function probeDeepgramWebSocket() {
    console.log('\n🔍 Probing Deepgram WebSocket connection...');
    const url = `wss://api.deepgram.com/v1/listen?model=nova-2&language=en-US&smart_format=true&encoding=mulaw&sample_rate=8000&channels=1`;

    const ws = new WebSocket(url, {
        headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` },
    });

    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            ws.close();
            resolve({ status: 'timeout', message: 'Connection timeout after 5s' });
        }, 5000);

        ws.on('open', () => {
            clearTimeout(timeout);
            console.log('✅ Deepgram WS probe: Connection opened successfully');
            ws.close();
            resolve({ status: 'ok', message: 'Connection successful' });
        });

        ws.on('unexpected-response', (_, res) => {
            clearTimeout(timeout);
            console.error(`❌ Deepgram WS probe: Unexpected response - Status ${res.statusCode} ${res.statusMessage}`);
            resolve({ status: 'error', statusCode: res.statusCode, message: res.statusMessage });
        });

        ws.on('error', (e) => {
            clearTimeout(timeout);
            console.error('❌ Deepgram WS probe: Error -', e.message);
            resolve({ status: 'error', message: e.message });
        });
    });
}

// Health check functions
async function checkDeepgramHealth() {
    try {
        const response = await fetch('https://api.deepgram.com/v1/projects', {
            headers: {
                'Authorization': `Token ${DEEPGRAM_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        if (response.ok) {
            console.log('✅ Deepgram API key is valid');
            return { status: 'ok', service: 'Deepgram' };
        } else {
            const text = await response.text();
            console.error(`❌ Deepgram API key invalid: ${response.status} ${response.statusText}`);
            console.error(`Response: ${text.substring(0, 200)}`);
            return { status: 'error', service: 'Deepgram', error: `${response.status}: ${text.substring(0, 200)}` };
        }
    } catch (error) {
        console.error(`❌ Deepgram health check failed:`, error.message);
        return { status: 'error', service: 'Deepgram', error: error.message };
    }
}

async function checkOpenAIHealth() {
    try {
        const response = await openai.chat.completions.create({
            model: LLM_MODEL,
            messages: [{ role: "user", content: "test" }],
            max_tokens: 5
        });
        console.log('✅ LLM API key is valid');
        return { status: 'ok', service: 'LLM', model: LLM_MODEL };
    } catch (error) {
        console.error(`❌ LLM API key invalid:`, error.message);
        return { status: 'error', service: 'LLM', model: LLM_MODEL, error: error.message };
    }
}

// Run health checks on startup
async function runStartupHealthChecks() {
    console.log('\n🔍 Running API health checks...');
    const results = await Promise.all([
        checkDeepgramHealth(),
        checkOpenAIHealth()
    ]);

    const allOk = results.every(r => r.status === 'ok');
    if (allOk) {
        console.log('✅ All API keys are valid and working!\n');
    } else {
        console.error('❌ Some API keys are invalid. Check the errors above.\n');
    }

    // Run Deepgram WebSocket probe
    const probeResult = await probeDeepgramWebSocket();
    if (probeResult.status !== 'ok') {
        console.error(`❌ Deepgram WebSocket probe failed:`, probeResult);
    }

    return results;
}

// Initialize Fastify
const fastify = Fastify({ logger: true });
await fastify.register(FastifyWebSocket);
await fastify.register(FastifyFormBody);

// Audio conversion utilities
class AudioConverter {
    static mulawToPCM16(mulawBuffer) {
        const mulawToLinear = [
            -32124, -31100, -30076, -29052, -28028, -27004, -25980, -24956,
            -23932, -22908, -21884, -20860, -19836, -18812, -17788, -16764,
            -15996, -15484, -14972, -14460, -13948, -13436, -12924, -12412,
            -11900, -11388, -10876, -10364, -9852, -9340, -8828, -8316,
            -7932, -7676, -7420, -7164, -6908, -6652, -6396, -6140,
            -5884, -5628, -5372, -5116, -4860, -4604, -4348, -4092,
            -3900, -3772, -3644, -3516, -3388, -3260, -3132, -3004,
            -2876, -2748, -2620, -2492, -2364, -2236, -2108, -1980,
            -1884, -1820, -1756, -1692, -1628, -1564, -1500, -1436,
            -1372, -1308, -1244, -1180, -1116, -1052, -988, -924,
            -876, -844, -812, -780, -748, -716, -684, -652,
            -620, -588, -556, -524, -492, -460, -428, -396,
            -372, -356, -340, -324, -308, -292, -276, -260,
            -244, -228, -212, -196, -180, -164, -148, -132,
            -120, -112, -104, -96, -88, -80, -72, -64,
            -56, -48, -40, -32, -24, -16, -8, 0,
            32124, 31100, 30076, 29052, 28028, 27004, 25980, 24956,
            23932, 22908, 21884, 20860, 19836, 18812, 17788, 16764,
            15996, 15484, 14972, 14460, 13948, 13436, 12924, 12412,
            11900, 11388, 10876, 10364, 9852, 9340, 8828, 8316,
            7932, 7676, 7420, 7164, 6908, 6652, 6396, 6140,
            5884, 5628, 5372, 5116, 4860, 4604, 4348, 4092,
            3900, 3772, 3644, 3516, 3388, 3260, 3132, 3004,
            2876, 2748, 2620, 2492, 2364, 2236, 2108, 1980,
            1884, 1820, 1756, 1692, 1628, 1564, 1500, 1436,
            1372, 1308, 1244, 1180, 1116, 1052, 988, 924,
            876, 844, 812, 780, 748, 716, 684, 652,
            620, 588, 556, 524, 492, 460, 428, 396,
            372, 356, 340, 324, 308, 292, 276, 260,
            244, 228, 212, 196, 180, 164, 148, 132,
            120, 112, 104, 96, 88, 80, 72, 64,
            56, 48, 40, 32, 24, 16, 8, 0
        ];

        const pcm16Buffer = Buffer.alloc(mulawBuffer.length * 2);
        for (let i = 0; i < mulawBuffer.length; i++) {
            const linear = mulawToLinear[mulawBuffer[i]];
            pcm16Buffer.writeInt16LE(linear, i * 2);
        }
        return pcm16Buffer;
    }

    static pcm16ToMulaw(pcm16Buffer) {
        // Use proven alawmulaw library for correct ITU-T G.711 μ-law encoding
        // Create a properly aligned copy to avoid "start offset must be multiple of 2" error
        const alignedBuffer = Buffer.from(pcm16Buffer);
        const int16Array = new Int16Array(alignedBuffer.buffer, alignedBuffer.byteOffset, alignedBuffer.length / 2);
        const mulawUint8 = mulaw.mulaw.encode(int16Array);
        return Buffer.from(mulawUint8);
    }
}

// n8n Order Submission
async function submitOrderToN8n(orderData) {
    if (!N8N_WEBHOOK_URL) {
        console.log('⚠️ N8N_WEBHOOK_URL not configured, skipping order submission');
        return { success: false, error: 'No webhook URL configured' };
    }

    try {
        console.log('📤 Submitting order to n8n:', JSON.stringify(orderData, null, 2));

        const response = await fetch(N8N_WEBHOOK_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(orderData)
        });

        if (response.ok) {
            const result = await response.json();
            console.log('✅ Order submitted to n8n successfully:', result);
            return { success: true, data: result };
        } else {
            const errorText = await response.text();
            console.error(`❌ n8n webhook error: ${response.status} ${response.statusText}`);
            console.error(`Response: ${errorText}`);
            return { success: false, error: `${response.status}: ${errorText}` };
        }
    } catch (error) {
        console.error('❌ Failed to submit order to n8n:', error.message);
        return { success: false, error: error.message };
    }
}

// Session management
const sessions = new Map();

class VoiceSession {
    constructor(streamSid, connection) {
        this.streamSid = streamSid;
        this.connection = connection;
        this.conversationHistory = [];
        this.audioBuffer = [];
        this.isProcessing = false;
        this.deepgramConnection = null;
        this.lastTranscript = '';
        this.silenceTimer = null;

        // Outbound audio queue
        this.outboundQueue = [];
        this.isPlaying = false;
        this.playTimer = null;
        this.currentStreamAbort = false;

        // STT gating to prevent self-transcription
        this.isSpeaking = false;  // True when TTS is playing
        this.cooldownUntil = 0;   // Timestamp to ignore transcripts until
        this.ttsStartTime = 0;    // When TTS started (to filter short greetings)
        this.lastUserSpeechTime = 0;  // Track when user last spoke (for barge-in)
        this.bargeInDetected = false;  // Flag for user interruption

        // Order tracking
        this.orderData = {
            items: [],
            customer_name: null,
            customer_phone: null,
            total: 0,
            status: 'in_progress'
        };
        this.orderSubmitted = false;

        // Frame contract validation (Twilio outbound diagnostics)
        this.frameSizes = [];
        this.sendIntervals = [];
        this.lastFrameSendTime = 0;

        // Analytics tracking
        this.callStartTime = new Date().toISOString();
        this.callEndTime = null;

        console.log(`🎙️ New session: ${streamSid}`);
        this.initializeDeepgram();
    }

    initializeDeepgram() {
        try {
            this.deepgramConnection = deepgram.listen.live({
                model: 'nova-2',
                language: 'en-US',
                smart_format: true,
                encoding: 'mulaw',
                sample_rate: 8000,
                channels: 1,
                interim_results: true,  // Required for utterance_end_ms
                endpointing: 300,
                utterance_end_ms: 1000
            });

            this.deepgramConnection.on('open', () => {
                console.log(`🎧 Deepgram connected for ${this.streamSid}`);
            });

            this.deepgramConnection.on('Results', async (data) => {
                const alt = data.channel?.alternatives?.[0];
                const transcript = alt?.transcript;

                // ✅ Only process FINAL results
                const isFinal = data.is_final === true || data.speech_final === true;
                if (!isFinal) return;

                if (transcript && transcript.trim()) {
                    console.log(`📝 FINAL: "${transcript}"`);
                    this.lastTranscript = transcript;

                    // Process the transcript with OpenAI
                    await this.processTranscript(transcript);
                }
            });

            this.deepgramConnection.on('error', (error) => {
                console.error(`❌ Deepgram error:`, error);
            });

            this.deepgramConnection.on('close', () => {
                console.log(`👋 Deepgram closed for ${this.streamSid}`);
            });

        } catch (error) {
            console.error(`❌ Failed to initialize Deepgram:`, error);
        }
    }

    async processTranscript(transcript) {
        const now = Date.now();

        // ENHANCED VALIDATION: Filter out obvious misrecognitions and noise
        const cleanTranscript = transcript.trim();

        // Filter out very short or nonsensical transcripts
        if (cleanTranscript.length < 2) {
            console.log(`🚫 FILTERED: Too short - "${transcript}"`);
            return;
        }

        // Filter out single letters or repeated characters (likely noise)
        if (/^[a-z]$/i.test(cleanTranscript) || /^(.)\1+$/i.test(cleanTranscript)) {
            console.log(`🚫 FILTERED: Single letter/repeated chars - "${transcript}"`);
            return;
        }

        // BARGE-IN DETECTION: Allow user to interrupt during TTS
        if (this.isSpeaking) {
            // Check if this looks like intentional user speech (not echo)
            const timeSinceTTSStart = now - this.ttsStartTime;
            const isLikelyUserSpeech = cleanTranscript.length > 5 && timeSinceTTSStart > 1000;

            if (isLikelyUserSpeech) {
                console.log(`🎤 BARGE-IN DETECTED: User interrupting TTS - "${transcript}"`);
                this.bargeInDetected = true;
                this.stopPlaybackForBargeIn();
                // Continue processing the transcript
            } else {
                console.log(`🚫 STT GATED (TTS playing): isSpeaking=true, transcript="${transcript}"`);
                return;
            }
        }

        // COOLDOWN GATE: Block transcripts during post-TTS cooldown (unless barge-in)
        if (!this.bargeInDetected && now < this.cooldownUntil) {
            console.log(`🚫 STT GATED (cooldown): ${this.cooldownUntil - now}ms remaining, transcript="${transcript}"`);
            return;
        }

        // Reset barge-in flag
        this.bargeInDetected = false;

        // ECHO DETECTION: Filter short greetings that arrive within 2s of TTS start
        const timeSinceTTS = now - this.ttsStartTime;
        const isShortGreeting = /^(hello|hi|hey|yes|no)[\?]?$/i.test(cleanTranscript);
        if (isShortGreeting && timeSinceTTS < 2000) {
            console.log(`🚫 FILTERED ECHO: "${transcript}" (${timeSinceTTS}ms since TTS start)`);
            return;
        }

        // DUPLICATE DETECTION: Ignore if same as last transcript within 3 seconds
        const timeSinceLastSpeech = now - this.lastUserSpeechTime;
        if (cleanTranscript === this.lastTranscript && timeSinceLastSpeech < 3000) {
            console.log(`🚫 FILTERED DUPLICATE: "${transcript}" (${timeSinceLastSpeech}ms since last)`);
            return;
        }

        console.log(`✅ STT ACCEPTED: "${transcript}" (isSpeaking=${this.isSpeaking}, cooldownUntil=${this.cooldownUntil}, now=${now})`);
        this.lastUserSpeechTime = now;
        this.lastTranscript = cleanTranscript;

        if (this.isProcessing) {
            console.log('⏳ Already processing, queuing...');
            return;
        }

        this.isProcessing = true;

        try {
            // Add user message to history
            this.conversationHistory.push({
                role: 'user',
                parts: [{ text: transcript }]
            });

            // Get response from the configured chat model
            const response = await this.getOpenAIResponse();

            if (response) {
                console.log(`🤖 LLM: "${response}"`);

                // Add assistant response to history
                this.conversationHistory.push({
                    role: 'model',
                    parts: [{ text: response }]
                });

                // Check if order is complete and submit to n8n
                await this.checkAndSubmitOrder(response);

                // Convert response to speech and send to caller
                await this.synthesizeAndSend(response);
            }

        } catch (error) {
            console.error(`❌ Error processing transcript:`, error);
        } finally {
            this.isProcessing = false;
        }
    }

    async getOpenAIResponse() {
        try {
            const currentTime = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
            const restaurantContext = [
                `Agent Name: ${AGENT_NAME}`,
                `Restaurant Name: ${RESTAURANT_NAME}`,
                RESTAURANT_LOCATION ? `Restaurant Location: ${RESTAURANT_LOCATION}` : null,
                RESTAURANT_PHONE ? `Restaurant Phone: ${RESTAURANT_PHONE}` : null,
                '',
                'Use the following Menu Data as the source of truth for restaurant details, hours, items, modifiers, and prices:',
                JSON.stringify(menu)
            ].filter(Boolean).join('\n');

            const fullInstructions = `Current Server Time: ${currentTime}\n\n${restaurantContext}\n\n${systemInstructions}`;

            // Convert internal conversation history to OpenAI-compatible messages
            const messages = [
                { role: "system", content: fullInstructions },
                ...this.conversationHistory.map(msg => ({
                    role: msg.role === 'user' ? 'user' : 'assistant',
                    content: msg.parts[0].text
                }))
            ];

            const completion = await openai.chat.completions.create({
                model: LLM_MODEL,
                messages: messages,
                temperature: 0.9,
                max_tokens: 200,
            });

            return completion.choices[0].message.content;

        } catch (error) {
            console.error(`❌ OpenAI error:`, error);
            return "I apologize, I'm having trouble processing that. Could you please repeat?";
        }
    }

    async checkAndSubmitOrder(aiResponse) {
        // Don't submit if already submitted
        if (this.orderSubmitted) return;

        const lowerResponse = aiResponse.toLowerCase();
        const conversationText = this.conversationHistory
            .map(msg => msg.parts[0].text)
            .join(' ')
            .toLowerCase();

        // IMPROVED DETECTION: Check if AI is asking for customer details (name/phone)
        // This indicates the order is being finalized
        const isAskingForName = lowerResponse.includes('name') &&
            (lowerResponse.includes('may i have') || lowerResponse.includes('can i get') ||
                lowerResponse.includes('what is') || lowerResponse.includes('could you provide'));

        const isAskingForPhone = lowerResponse.includes('phone') &&
            (lowerResponse.includes('number') || lowerResponse.includes('contact'));

        // Also check if customer has already provided name AND phone in conversation
        const hasName = /(?:name|called?|i'm|i am)\s+(?:is\s+)?([a-z]{2,})/i.test(conversationText);
        // Fixed regex: matches (425) 683-1803, 425-683-1803, 425.683.1803, 4256831803
        const hasPhone = /(\(\d{3}\)\s?\d{3}[-.\s]?\d{4}|\d{3}[-.\s]?\d{3}[-.\s]?\d{4}|\d{10})/.test(conversationText);

        // Check if there are order items in the conversation
        const hasOrderItems = conversationText.includes('samosa') ||
            conversationText.includes('tikka') ||
            conversationText.includes('naan') ||
            conversationText.includes('curry') ||
            conversationText.includes('biryani');

        // ONLY submit when customer has provided BOTH name AND phone AND there are order items
        const shouldSubmit = hasName && hasPhone && hasOrderItems;

        // DEBUG: Always log detection status
        console.log('🔍 Order detection check:');
        console.log(`   - Conversation text: "${conversationText.substring(0, 200)}..."`);
        console.log(`   - Has name: ${hasName}`);
        console.log(`   - Has phone: ${hasPhone}`);
        console.log(`   - Has order items: ${hasOrderItems}`);
        console.log(`   - Should submit: ${shouldSubmit}`);

        if (shouldSubmit) {
            console.log('🎯 Order completion detected!');
            console.log(`   - Has name: ${hasName}`);
            console.log(`   - Has phone: ${hasPhone}`);
            console.log(`   - Has order items: ${hasOrderItems}`);
            console.log(`   - AI asking for name: ${isAskingForName}`);
            console.log(`   - AI asking for phone: ${isAskingForPhone}`);

            // Extract customer info from conversation
            // For name: Look for the customer's response AFTER the AI asks for their name
            let customerName = 'Unknown';
            const history = this.conversationHistory;
            for (let i = 0; i < history.length - 1; i++) {
                const msg = history[i];
                const nextMsg = history[i + 1];

                // Check if AI asked for name (multiple patterns)
                const aiText = msg.parts[0].text.toLowerCase();
                const isAskingForName = msg.role === 'model' && (
                    aiText.includes('may i have your name') ||
                    aiText.includes('your name') ||
                    aiText.includes('name for the order') ||
                    aiText.includes('can i get your name')
                );

                if (isAskingForName) {
                    // Next message should be the customer's name
                    if (nextMsg.role === 'user') {
                        // Extract the name from the user's response
                        let userResponse = nextMsg.parts[0].text.trim();

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
                        break;
                    }
                }
            }

            // Extract phone with support for (425) 683-1803, 425-683-1803, etc.
            const phoneMatch = conversationText.match(/(\(\d{3}\)\s?\d{3}[-.\s]?\d{4}|\d{3}[-.\s]?\d{3}[-.\s]?\d{4}|\d{10})/);

            // Extract order items from conversation
            const orderItems = [];
            const itemMatches = conversationText.matchAll(/(one|two|three|four|five|\d+)\s+([a-z\s]+(?:samosa|tikka|masala|naan|curry|biryani|rice))/gi);
            for (const match of itemMatches) {
                orderItems.push(match[0]);
            }

            // Build order data
            const orderData = {
                customer_name: customerName,
                // Keep phone formatting with parentheses/dashes for readability
                customer_phone: phoneMatch ? phoneMatch[1] : 'Unknown',
                items: orderItems.length > 0 ? orderItems.join(', ') : 'Order in progress',
                order_summary: `Items: ${orderItems.join(', ') || 'N/A'}. Latest response: ${aiResponse}`,
                timestamp: new Date().toISOString(),
                source: 'voice_call',
                session_id: this.streamSid,
                conversation_history: this.conversationHistory
            };

            console.log('📦 Order data prepared:', JSON.stringify(orderData, null, 2));

            // Submit to n8n
            const result = await submitOrderToN8n(orderData);

            if (result.success) {
                this.orderSubmitted = true;
                console.log('✅ Order successfully submitted and saved to database');

                // Send email notification to restaurant
                console.log('📧 Sending email notification to restaurant...');
                const emailResult = await emailService.sendOrderConfirmation(orderData);
                if (emailResult.success) {
                    console.log(`✅ Email sent to ${emailResult.recipient}`);
                } else {
                    console.error('❌ Email notification failed:', emailResult.error);
                }
            } else {
                console.error('❌ Order submission failed:', result.error);
            }
        }
    }


    async synthesizeAndSend(text) {
        try {
            this.ttsStartTime = Date.now(); // Track when TTS starts for greeting filter
            console.log(`🔊 Synthesizing: "${text.substring(0, 50)}..."`);

            // 🎯 Google Cloud TTS - Returns clean LINEAR16 PCM @ 8kHz
            const ttsClient = new textToSpeech.TextToSpeechClient();

            const request = {
                input: { text },
                voice: {
                    languageCode: GOOGLE_TTS_LANGUAGE,
                    name: GOOGLE_TTS_VOICE,
                },
                audioConfig: {
                    audioEncoding: 'LINEAR16',
                    sampleRateHertz: 8000,
                    speakingRate: 1.0,
                    pitch: 0.0,
                },
            };

            const [response] = await ttsClient.synthesizeSpeech(request);

            // Get clean PCM16 buffer (no ID3 tags, no MP3 encoding!)
            const pcm16Buffer = Buffer.isBuffer(response.audioContent)
                ? response.audioContent
                : Buffer.from(response.audioContent, 'base64');

            console.log(`✅ Google TTS: Clean LINEAR16 PCM @ 8kHz`);
            console.log(`   - Size: ${pcm16Buffer.length} bytes`);
            console.log(`   - No ID3 tags, no MP3 encoding`);
            console.log(`   - Ready for μ-law conversion`);

            // AUDIO DIAGNOSTICS
            const sampleRate = 8000;
            const channels = 1;
            const bitDepth = 16;
            const bytesPerSample = bitDepth / 8;
            const totalSamples = pcm16Buffer.length / bytesPerSample;
            const durationMs = (totalSamples / sampleRate) * 1000;

            console.log(`📦 PCM16 Audio Received:`);
            console.log(`   - Size: ${pcm16Buffer.length} bytes`);
            console.log(`   - Sample Rate: ${sampleRate} Hz`);
            console.log(`   - Channels: ${channels} (mono)`);
            console.log(`   - Bit Depth: ${bitDepth}-bit`);
            console.log(`   - Samples: ${totalSamples}`);
            console.log(`   - Duration: ${durationMs.toFixed(0)}ms`);

            // Convert PCM16 to μ-law using proven alawmulaw library
            const mulawBuffer = AudioConverter.pcm16ToMulaw(pcm16Buffer);

            // μ-LAW CONVERSION DIAGNOSTICS
            const expectedMulawSize = Math.floor(pcm16Buffer.length / 2);
            const frameSizeBytes = 160; // Twilio expects 160 bytes per 20ms frame
            const totalFrames = Math.ceil(mulawBuffer.length / frameSizeBytes);

            console.log(`🔄 μ-law Conversion (alawmulaw library):`);
            console.log(`   - Converted Size: ${mulawBuffer.length} bytes`);
            console.log(`   - Expected Size: ${expectedMulawSize} bytes`);
            console.log(`   - Match: ${mulawBuffer.length === expectedMulawSize ? '✅' : '❌'}`);
            console.log(`   - Frame Size: ${frameSizeBytes} bytes (20ms @ 8kHz)`);
            console.log(`   - Total Frames: ${totalFrames}`);
            console.log(`   - Last Frame Size: ${mulawBuffer.length % frameSizeBytes || frameSizeBytes} bytes`);

            // Enqueue the μ-law audio
            this.enqueueMulaw(mulawBuffer);

        } catch (error) {
            console.error(`❌ TTS error:`, error);
        }
    }

    // Queue-based audio player
    enqueueMulaw(mulawAudio) {
        const CHUNK_SIZE = 160;

        // Split into 160-byte frames
        for (let i = 0; i < mulawAudio.length; i += CHUNK_SIZE) {
            let frame = mulawAudio.slice(i, i + CHUNK_SIZE);

            // CRITICAL: Pad last frame to exactly 160 bytes with μ-law silence (0xFF)
            if (frame.length < CHUNK_SIZE) {
                const paddedFrame = Buffer.alloc(CHUNK_SIZE, 0xFF); // μ-law silence
                frame.copy(paddedFrame);
                frame = paddedFrame;
            }

            this.outboundQueue.push(frame);
        }

        if (!this.isPlaying) this.startPlayer();
    }

    startPlayer() {
        const FRAME_INTERVAL_MS = 20;
        this.isPlaying = true;
        this.currentStreamAbort = false;

        // HARD GATE: Block STT during TTS playback
        this.isSpeaking = true;
        console.log(`🔊 TTS PLAYBACK STARTED - STT GATED (isSpeaking=true)`);

        // Reset frame contract diagnostics
        this.frameSizes = [];
        this.sendIntervals = [];
        this.lastFrameSendTime = Date.now();

        console.log(`⏱️ Player started. Queue frames: ${this.outboundQueue.length}`);

        this.playTimer = setInterval(() => {
            if (this.currentStreamAbort) {
                console.log("🛑 Player aborted (barge-in). Clearing queue.");
                this.outboundQueue = [];
                this.currentStreamAbort = false;
            }

            if (this.outboundQueue.length === 0) {
                clearInterval(this.playTimer);
                this.playTimer = null;
                this.isPlaying = false;

                // FRAME CONTRACT DIAGNOSTICS
                if (this.frameSizes.length > 0) {
                    const avgFrameSize = this.frameSizes.reduce((a, b) => a + b, 0) / this.frameSizes.length;
                    const minFrameSize = Math.min(...this.frameSizes);
                    const maxFrameSize = Math.max(...this.frameSizes);
                    const avgInterval = this.sendIntervals.length > 0
                        ? this.sendIntervals.reduce((a, b) => a + b, 0) / this.sendIntervals.length
                        : 0;
                    const framesPerSecond = avgInterval > 0 ? 1000 / avgInterval : 0;

                    console.log(`📊 FRAME CONTRACT VALIDATION:`);
                    console.log(`   - Bytes/Frame: ${avgFrameSize.toFixed(1)} (expected: 160)`);
                    console.log(`   - Min Frame Size: ${minFrameSize} bytes`);
                    console.log(`   - Max Frame Size: ${maxFrameSize} bytes`);
                    console.log(`   - Avg Send Interval: ${avgInterval.toFixed(1)}ms (expected: 20ms)`);
                    console.log(`   - Frames/Second: ${framesPerSecond.toFixed(1)} (expected: 50)`);
                    console.log(`   - Total Frames Sent: ${this.frameSizes.length}`);
                    console.log(`   - Frame Size Variance: ${minFrameSize === maxFrameSize ? '✅ None' : '❌ Varies'}`);
                }

                // HARD GATE: Unblock STT with 500ms cooldown after TTS ends (increased from 250ms)
                this.isSpeaking = false;
                this.cooldownUntil = Date.now() + 500;
                console.log(`🔇 TTS PLAYBACK ENDED - STT COOLDOWN 500ms (isSpeaking=false, cooldownUntil=${this.cooldownUntil})`);
                console.log("✅ Player stopped (queue empty).");
                return;
            }

            const frame = this.outboundQueue.shift();

            // Track frame contract metrics
            const now = Date.now();
            this.frameSizes.push(frame.length);
            if (this.lastFrameSendTime > 0) {
                this.sendIntervals.push(now - this.lastFrameSendTime);
            }
            this.lastFrameSendTime = now;

            // STRICT payload
            this.connection.send(JSON.stringify({
                event: "media",
                streamSid: this.streamSid,
                media: { payload: frame.toString("base64") }
            }));
        }, FRAME_INTERVAL_MS);
    }

    stopPlaybackForBargeIn() {
        // Call this when user starts speaking (barge-in)
        if (this.isPlaying) {
            console.log('🛑 Stopping TTS playback for user barge-in');
            this.currentStreamAbort = true;
            this.isSpeaking = false;  // Immediately ungate STT
            this.cooldownUntil = 0;   // Clear cooldown
        }
    }

    processAudio(audioPayload) {
        try {
            const mulawBuffer = Buffer.from(audioPayload, 'base64');

            // Send μ-law directly to Deepgram (it's configured for mulaw encoding)
            if (this.deepgramConnection && this.deepgramConnection.getReadyState() === 1) {
                this.deepgramConnection.send(mulawBuffer);
            }

        } catch (error) {
            console.error(`❌ Audio processing error:`, error);
        }
    }

    async close() {
        console.log(`🛑 Closing session: ${this.streamSid}`);

        // Log call to analytics
        this.callEndTime = new Date().toISOString();
        const callDuration = (new Date(this.callEndTime) - new Date(this.callStartTime)) / 1000; // seconds

        analytics.logCall({
            callId: this.streamSid,
            startTime: this.callStartTime,
            endTime: this.callEndTime,
            duration: callDuration,
            transcript: this.conversationHistory,
            orderCompleted: this.orderSubmitted,
            orderData: this.orderSubmitted ? this.orderData : null,
            customerName: this.orderData.customer_name,
            customerPhone: this.orderData.customer_phone,
            failureReason: !this.orderSubmitted ? 'Order not completed' : null
        });

        if (this.deepgramConnection) {
            this.deepgramConnection.finish();
        }

        if (this.silenceTimer) {
            clearTimeout(this.silenceTimer);
        }

        sessions.delete(this.streamSid);
    }
}

// Routes
fastify.get('/', async (request, reply) => {
    return { status: 'ok', message: `${RESTAURANT_NAME} Voice Agent`, model: LLM_MODEL };
});

fastify.get('/health', async (request, reply) => {
    const results = await Promise.all([
        checkDeepgramHealth(),
        checkOpenAIHealth()
    ]);

    const allOk = results.every(r => r.status === 'ok');

    return {
        status: allOk ? 'healthy' : 'unhealthy',
        timestamp: new Date().toISOString(),
        services: results
    };
});

// Analytics endpoints
fastify.get('/analytics/summary', async (request, reply) => {
    const stats = analytics.getStats();
    return {
        status: 'ok',
        data: stats
    };
});

fastify.get('/analytics/calls', async (request, reply) => {
    const limit = parseInt(request.query.limit) || 10;
    const calls = analytics.getRecentCalls(limit);
    return {
        status: 'ok',
        count: calls.length,
        data: calls
    };
});

fastify.get('/analytics/metrics', async (request, reply) => {
    const kpis = analytics.getKPIs();
    return {
        status: 'ok',
        data: kpis
    };
});

fastify.post('/twiml', async (request, reply) => {
    const wsUrl = `wss://${request.headers.host}/media-stream`;
    console.log(`📞 Incoming call - WebSocket URL: ${wsUrl}`);

    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect>
        <Stream url="${wsUrl}" track="inbound_track" />
    </Connect>
</Response>`;

    console.log(`📤 TwiML Response: ${twimlResponse}`);
    reply.type('text/xml').send(twimlResponse);
});

fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('📞 Twilio connected');
        let session = null;

        connection.on('message', async (message) => {
            try {
                const msg = JSON.parse(message.toString());

                switch (msg.event) {
                    case 'start':
                        const streamSid = msg.start.streamSid;
                        session = new VoiceSession(streamSid, connection);
                        sessions.set(streamSid, session);

                        // Send initial greeting
                        setTimeout(async () => {
                            await session.synthesizeAndSend(INITIAL_GREETING);
                        }, 1000);
                        break;

                    case 'media':
                        if (session) {
                            session.processAudio(msg.media.payload);
                        }
                        break;

                    case 'stop':
                        if (session) {
                            await session.close();
                        }
                        break;
                }
            } catch (error) {
                console.error('❌ WebSocket message error:', error);
            }
        });

        connection.on('close', async () => {
            console.log('👋 Twilio disconnected');
            if (session) {
                await session.close();
            }
        });

        connection.on('error', (error) => {
            console.error('❌ WebSocket error:', error);
        });
    });
});

// Start server
(async () => {
    try {
        await fastify.listen({ port: PORT, host: '0.0.0.0' });
        console.log(`🚀 Server running on port ${PORT}`);
        await runStartupHealthChecks();
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
})();
