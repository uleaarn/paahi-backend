import Fastify from 'fastify';
import FastifyWebSocket from '@fastify/websocket';
import FastifyFormBody from '@fastify/formbody';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createClient } from '@deepgram/sdk';
import { ElevenLabsClient, stream } from "elevenlabs";
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mulaw from 'alawmulaw';
// Polyfill WebSocket for Deepgram SDK
globalThis.WebSocket = WebSocket;

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;

if (!GEMINI_API_KEY || !DEEPGRAM_API_KEY || !ELEVENLABS_API_KEY) {
    console.error('❌ Missing required API keys');
    console.error('Required: GEMINI_API_KEY, DEEPGRAM_API_KEY, ELEVENLABS_API_KEY');
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

// Initialize AI clients
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const deepgram = createClient(DEEPGRAM_API_KEY);
const elevenlabs = new ElevenLabsClient({ apiKey: ELEVENLABS_API_KEY });

// Store ElevenLabs voice ID globally
let ELEVENLABS_VOICE_ID = null;

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

async function checkElevenLabsHealth() {
    try {
        const response = await fetch('https://api.elevenlabs.io/v1/voices', {
            headers: {
                'xi-api-key': ELEVENLABS_API_KEY,
                'Content-Type': 'application/json'
            }
        });

        if (response.ok) {
            const voicesJson = await response.json();
            const firstVoice = voicesJson?.voices?.[0];
            if (firstVoice) {
                ELEVENLABS_VOICE_ID = firstVoice.voice_id;
                console.log(`✅ ElevenLabs API key is valid (voice: ${firstVoice.name}, ID: ${ELEVENLABS_VOICE_ID})`);
            } else {
                console.log("✅ ElevenLabs API key is valid (no voices available)");
            }
            return { status: 'ok', service: 'ElevenLabs' };
        } else {
            const text = await response.text();
            console.error(`❌ ElevenLabs API key invalid: ${response.status} ${response.statusText}`);
            console.error(`Response: ${text.substring(0, 200)}`);
            return { status: 'error', service: 'ElevenLabs', error: `${response.status}: ${text.substring(0, 200)}` };
        }
    } catch (error) {
        console.error(`❌ ElevenLabs health check failed:`, error.message);
        return { status: 'error', service: 'ElevenLabs', error: error.message };
    }
}

async function checkGeminiHealth() {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" });
        const result = await model.generateContent("test");
        console.log('✅ Gemini API key is valid');
        return { status: 'ok', service: 'Gemini' };
    } catch (error) {
        console.error(`❌ Gemini API key invalid:`, error.message);
        return { status: 'error', service: 'Gemini', error: error.message };
    }
}

// Run health checks on startup
async function runStartupHealthChecks() {
    console.log('\n🔍 Running API health checks...');
    const results = await Promise.all([
        checkDeepgramHealth(),
        checkElevenLabsHealth(),
        checkGeminiHealth()
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
        // Convert Buffer to Int16Array for the library
        const int16Array = new Int16Array(pcm16Buffer.buffer, pcm16Buffer.byteOffset, pcm16Buffer.length / 2);
        const mulawUint8 = mulaw.mulaw.encode(int16Array);
        return Buffer.from(mulawUint8);
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

        // Frame contract validation (Twilio outbound diagnostics)
        this.frameSizes = [];
        this.sendIntervals = [];
        this.lastFrameSendTime = 0;

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

                    // Process the transcript with Gemini
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

        // HARD GATE: Block ALL transcripts during TTS playback + cooldown
        if (this.isSpeaking || now < this.cooldownUntil) {
            console.log(`🚫 STT GATED: isSpeaking=${this.isSpeaking}, cooldown=${now < this.cooldownUntil}, transcript="${transcript}"`);
            return;
        }

        // Filter short greetings that arrive within 2s of TTS start (likely echo/noise)
        const timeSinceTTS = now - this.ttsStartTime;
        const isShortGreeting = /^(hello|hi|hey)[\?]?$/i.test(transcript.trim());
        if (isShortGreeting && timeSinceTTS < 2000) {
            console.log(`🚫 FILTERED SHORT GREETING: "${transcript}" (${timeSinceTTS}ms since TTS start)`);
            return;
        }

        console.log(`✅ STT ACCEPTED: "${transcript}" (isSpeaking=${this.isSpeaking}, cooldownUntil=${this.cooldownUntil}, now=${now})`);
        console.log(`📝 FINAL: "${transcript}"`);

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

            // Get response from Gemini
            const response = await this.getGeminiResponse();

            if (response) {
                console.log(`🤖 Gemini: "${response}"`);

                // Add assistant response to history
                this.conversationHistory.push({
                    role: 'model',
                    parts: [{ text: response }]
                });

                // Convert response to speech and send to caller
                await this.synthesizeAndSend(response);
            }

        } catch (error) {
            console.error(`❌ Error processing transcript:`, error);
        } finally {
            this.isProcessing = false;
        }
    }

    async getGeminiResponse() {
        try {
            const currentTime = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
            const fullInstructions = `Current Server Time: ${currentTime}\n\n${systemInstructions}`;

            const model = genAI.getGenerativeModel({
                model: "gemini-2.0-flash-exp",
                systemInstruction: fullInstructions
            });

            const chat = model.startChat({
                history: this.conversationHistory.slice(0, -1), // Exclude the last message
                generationConfig: {
                    temperature: 0.9,
                    topP: 0.95,
                    topK: 40,
                    maxOutputTokens: 200,
                }
            });

            const result = await chat.sendMessage(this.conversationHistory[this.conversationHistory.length - 1].parts[0].text);
            return result.response.text();

        } catch (error) {
            console.error(`❌ Gemini error:`, error);
            return "I apologize, I'm having trouble processing that. Could you please repeat?";
        }
    }

    async synthesizeAndSend(text) {
        try {
            this.ttsStartTime = Date.now(); // Track when TTS starts for greeting filter
            console.log(`🔊 Synthesizing: "${text.substring(0, 50)}..."`);
            if (!ELEVENLABS_VOICE_ID) {
                console.error('❌ No ElevenLabs voice ID available');
                return;
            }

            // Get PCM16 at 8kHz from ElevenLabs
            const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`, {
                method: 'POST',
                headers: {
                    'xi-api-key': ELEVENLABS_API_KEY,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    text: text,
                    model_id: "eleven_turbo_v2_5",
                    voice_settings: {
                        stability: 0.5,
                        similarity_boost: 0.75
                    },
                    output_format: "pcm_8000" // Get PCM16 at 8kHz, we'll convert to μ-law
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error(`❌ ElevenLabs API error: ${response.status} - ${errorText}`);
                return;
            }

            const pcm16Buffer = Buffer.from(await response.arrayBuffer());

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
            console.log(`   - Bytes/Sample: ${bytesPerSample}`);

            // Convert PCM16 to μ-law for Twilio
            const mulawBuffer = AudioConverter.pcm16ToMulaw(pcm16Buffer);

            // μ-LAW DIAGNOSTICS
            const expectedMulawSize = Math.floor(pcm16Buffer.length / 2);
            const frameSizeBytes = 160; // Twilio expects 160 bytes per 20ms frame
            const totalFrames = Math.ceil(mulawBuffer.length / frameSizeBytes);

            console.log(`🔄 μ-law Conversion:`);
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

                // HARD GATE: Unblock STT with 250ms cooldown after TTS ends
                this.isSpeaking = false;
                this.cooldownUntil = Date.now() + 250;
                console.log(`🔇 TTS PLAYBACK ENDED - STT COOLDOWN 250ms (isSpeaking=false, cooldownUntil=${this.cooldownUntil})`);
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
        // Call this when user starts speaking
        if (this.isPlaying) {
            this.currentStreamAbort = true;
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
    return { status: 'ok', message: 'Jalwa Voice Agent - Hybrid Pipeline' };
});

fastify.get('/health', async (request, reply) => {
    const results = await Promise.all([
        checkDeepgramHealth(),
        checkElevenLabsHealth(),
        checkGeminiHealth()
    ]);

    const allOk = results.every(r => r.status === 'ok');

    return {
        status: allOk ? 'healthy' : 'unhealthy',
        timestamp: new Date().toISOString(),
        services: results
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
                            await session.synthesizeAndSend("Hello! Thank you for calling Jalwa Modern Indian Dining. How can I help you today?");
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
