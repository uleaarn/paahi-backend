import Fastify from 'fastify';
import FastifyWebSocket from '@fastify/websocket';
import FastifyFormBody from '@fastify/formbody';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createClient } from '@deepgram/sdk';
import { ElevenLabsClient, stream } from "elevenlabs";
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
        const BIAS = 0x84;
        const CLIP = 32635;
        const encodeTable = [
            0, 0, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3,
            4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4,
            5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
            5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
            6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
            6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
            6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
            6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
            7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
            7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
            7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
            7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
            7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
            7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
            7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
            7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7
        ];

        const mulawBuffer = Buffer.alloc(pcm16Buffer.length / 2);
        for (let i = 0; i < pcm16Buffer.length; i += 2) {
            let sample = pcm16Buffer.readInt16LE(i);
            const sign = (sample >> 8) & 0x80;
            if (sign) sample = -sample;
            if (sample > CLIP) sample = CLIP;
            sample += BIAS;
            const exponent = encodeTable[(sample >> 7) & 0xFF];
            const mantissa = (sample >> (exponent + 3)) & 0x0F;
            const mulaw = ~(sign | (exponent << 4) | mantissa);
            mulawBuffer[i / 2] = mulaw & 0xFF;
        }
        return mulawBuffer;
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

        console.log(`🎙️ New session: ${streamSid}`);
        this.initializeDeepgram();
    }

    initializeDeepgram() {
        try {
            this.deepgramConnection = deepgram.listen.live({
                model: 'nova-2',
                language: 'en-US',
                smart_format: true,
                encoding: 'linear16',
                sample_rate: 8000,
                channels: 1,
                interim_results: false,
                endpointing: 300,
                utterance_end_ms: 1000
            });

            this.deepgramConnection.on('open', () => {
                console.log(`🎧 Deepgram connected for ${this.streamSid}`);
            });

            this.deepgramConnection.on('Results', async (data) => {
                const transcript = data.channel?.alternatives?.[0]?.transcript;
                if (transcript && transcript.trim()) {
                    console.log(`📝 Transcript: "${transcript}"`);
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
            console.log(`🔊 Synthesizing: "${text.substring(0, 50)}..."`);

            // Generate audio with ElevenLabs
            const audioStream = await elevenlabs.generate({
                voice: "Rachel", // You can change this to other voices
                text: text,
                model_id: "eleven_turbo_v2_5",
                output_format: "pcm_16000"
            });

            // Collect audio chunks
            const audioChunks = [];
            for await (const chunk of audioStream) {
                audioChunks.push(chunk);
            }

            const pcm16Audio = Buffer.concat(audioChunks);

            // Convert PCM16 to mulaw for Twilio
            const mulawAudio = AudioConverter.pcm16ToMulaw(pcm16Audio);

            // Send to Twilio in chunks
            const CHUNK_SIZE = 640; // 20ms of mulaw audio at 8kHz
            for (let i = 0; i < mulawAudio.length; i += CHUNK_SIZE) {
                const chunk = mulawAudio.slice(i, i + CHUNK_SIZE);
                const payload = {
                    event: 'media',
                    streamSid: this.streamSid,
                    media: {
                        payload: chunk.toString('base64')
                    }
                };
                this.connection.send(JSON.stringify(payload));
            }

            console.log(`✅ Audio sent to caller`);

        } catch (error) {
            console.error(`❌ TTS error:`, error);
        }
    }

    processAudio(audioPayload) {
        try {
            const mulawBuffer = Buffer.from(audioPayload, 'base64');
            const pcm16Buffer = AudioConverter.mulawToPCM16(mulawBuffer);

            // Send to Deepgram
            if (this.deepgramConnection && this.deepgramConnection.getReadyState() === 1) {
                this.deepgramConnection.send(pcm16Buffer);
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

fastify.post('/twiml', async (request, reply) => {
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect>
        <Stream url="wss://${request.headers.host}/media-stream" />
    </Connect>
</Response>`;

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
fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`🚀 Server running on port ${PORT}`);
});
