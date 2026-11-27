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
import { BusinessRegistry } from './business-registry.js';
import { createConversation, actionsFactory } from './call-factory.js';
import { Database, pgAdapter } from './database.js';
import { Notifier, syncBusiness, notificationChannels } from './business-actions.js';
import { LANGUAGES } from './languages.js';
import { TextToSpeech } from './tts.js';
import { isValidTwilioSignature, requestUrl, issueStreamToken, verifyStreamToken } from './twilio-security.js';
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
// nova-3 is required for Telugu and for multi-language calls; it is the default.
const DEEPGRAM_MODEL = process.env.DEEPGRAM_MODEL || 'nova-3';
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 10000;
// Used only when the dialed number isn't listed in any business.json (single-business deployments).
const DEFAULT_BUSINESS_ID = process.env.DEFAULT_BUSINESS_ID || null;
// Protects /analytics/* (call records contain customer details). Unset = endpoints disabled.
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN || null;
// Supabase Postgres, connected as the paahi_app role (see docs/DATABASE.md).
const DATABASE_URL = process.env.DATABASE_URL;
const DATABASE_CA_CERT = process.env.DATABASE_CA_CERT || null;
// Testing switch. Leave false in production.
const ALLOW_ORDERS_WHEN_CLOSED = process.env.ALLOW_ORDERS_WHEN_CLOSED === 'true';
// Twilio request checks (see twilio-security.js). The auth token signs Twilio's webhooks
// and this server's media-stream tokens. TWILIO_SIGNATURE_CHECK=off is for local testing only.
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || null;
const TWILIO_SIGNATURE_CHECK = process.env.TWILIO_SIGNATURE_CHECK !== 'off';
// Optional: the public address Twilio calls, e.g. https://paahi.example.com, when a proxy hides it.
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || null;
// A media stream that hasn't sent a valid 'start' by then is closed.
const STREAM_START_TIMEOUT_MS = 10000;

if (!OPENAI_API_KEY || !DEEPGRAM_API_KEY || !DATABASE_URL) {
    console.error('❌ Missing required configuration');
    console.error('Required: OPENAI_API_KEY, DEEPGRAM_API_KEY, DATABASE_URL');
    process.exit(1);
}
if (TWILIO_SIGNATURE_CHECK && !TWILIO_AUTH_TOKEN) {
    console.error('❌ Missing TWILIO_AUTH_TOKEN: needed to check that calls come from Twilio');
    console.error('Set it to the Twilio account auth token (or TWILIO_SIGNATURE_CHECK=off for local testing only)');
    process.exit(1);
}
if (!TWILIO_SIGNATURE_CHECK) {
    console.warn('⚠️ TWILIO_SIGNATURE_CHECK=off: anyone can place calls through this server. Never use this in production.');
}

// Orders, callback requests and call records live in Postgres; each transaction is scoped to one business.
const db = new Database(pgAdapter({ connectionString: DATABASE_URL, caCert: DATABASE_CA_CERT }));
const notifier = new Notifier({ db, emailService });

// Load every business (config, menus, languages, notification settings). Fail fast on bad config.
let registry;
try {
    registry = new BusinessRegistry({
        rootDir: path.join(__dirname, 'businesses'),
        defaultBusinessId: DEFAULT_BUSINESS_ID,
        createSubmitter: actionsFactory({ db, notifier, emailService }),
    });
} catch (error) {
    console.error(`❌ ${error.message}`);
    process.exit(1);
}
for (const w of registry.warnings) console.warn(`⚠️ ${w}`);
for (const b of registry.list()) {
    const { submitter } = registry.get(b.id);
    console.log(`🏢 ${b.id}: languages ${b.languages.enabled.join(', ')}; workflows ${Object.keys(b.workflows).join(', ')}; destinations ${JSON.stringify(submitter.describeDestinations())}`);
}
if (!DEFAULT_BUSINESS_ID) console.log('ℹ️ DEFAULT_BUSINESS_ID not set: calls to numbers not listed in a business.json will be declined.');

// Initialize AI clients
const openai = new OpenAI({
    apiKey: OPENAI_API_KEY,
    baseURL: LLM_BASE_URL
});
const deepgram = createClient(DEEPGRAM_API_KEY);
// Voice: Deepgram Aura (same key as listening) for English; Google only if configured.
const tts = new TextToSpeech({
    deepgramKey: DEEPGRAM_API_KEY,
    googleClient: process.env.GOOGLE_APPLICATION_CREDENTIALS ? new textToSpeech.TextToSpeechClient() : null,
});

// One failing provider call must never take down every live call. Some SDKs
// (google-gax) reject internal promises nobody awaits; log them and keep serving.
process.on('unhandledRejection', (reason) => {
    console.error('❌ Unhandled rejection (server kept running):', reason?.message || reason);
});

/** Speech-to-text settings for a business: one language, or nova-3 multi-language with hints. */
function sttOptionsFor(business) {
    const enabled = business.languages.enabled;
    const model = business.voice.stt_model || DEEPGRAM_MODEL;
    if (enabled.length > 1) {
        // Deepgram: code-switching needs nova-3 language=multi; docs recommend endpointing=100.
        return { model: 'nova-3', language: 'multi', language_hint: enabled, endpointing: 100 };
    }
    const code = enabled[0];
    return { model, language: code === 'en' ? 'en-US' : LANGUAGES[code].stt, endpointing: 300 };
}


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

// Session management
const sessions = new Map();

// Ignore obvious noise: empty, a single letter, or one repeated character.
function isNoise(text) {
    const t = text.trim();
    return t.length < 2 || /^[a-z]$/i.test(t) || /^(.)\1+$/i.test(t);
}

class VoiceSession {
    constructor(streamSid, connection, { route, callSid = null, callerPhone = null } = {}) {
        this.streamSid = streamSid;
        this.callSid = callSid;
        this.connection = connection;
        this.deepgramConnection = null;
        this.closed = false;

        // Speech-to-text: Deepgram sends a sentence in "final" pieces. We join
        // the pieces and only act once the caller has finished speaking.
        this.pendingSegments = [];
        this.pendingLanguages = {};
        this.utteranceQueue = [];
        this.isProcessing = false;

        // Outbound audio queue
        this.outboundQueue = [];
        this.isPlaying = false;
        this.playTimer = null;
        this.currentStreamAbort = false;
        this.replyGen = 0;            // bumps on interruption; stale audio chunks are dropped
        this.streamingReply = false;  // a reply's audio is still arriving
        this.audioCarry = Buffer.alloc(0); // partial 20 ms frame between streamed chunks
        this.isSpeaking = false;
        this.ttsStartTime = 0;
        this.hangupAfterPlayback = false;
        this.hangupTimer = null;

        // Frame contract validation (Twilio outbound diagnostics)
        this.frameSizes = [];
        this.sendIntervals = [];
        this.lastFrameSendTime = 0;

        // Analytics
        this.callStartTime = new Date().toISOString();
        this.firstAudioAt = null;
        this.lastUtteranceAt = null;

        // This call only ever sees the one business it was routed to.
        this.business = route.business;
        this.actions = route.submitter;
        this.locationId = route.location.id;
        this.routedBy = route.routedBy;
        this.engine = createConversation({
            route,
            callId: callSid || streamSid,
            callerPhone,
            llm: openai,
            model: LLM_MODEL,
            allowOrdersWhenClosed: ALLOW_ORDERS_WHEN_CLOSED,
            llmTimeoutMs: LLM_TIMEOUT_MS,
        });
        this.engine.event('call_received', {
            call_sid: callSid,
            business_id: this.business.id,
            location_id: route.location.id,
            routed_by: route.routedBy,
            has_caller_id: Boolean(callerPhone),
        });

        console.log(`🎙️ New session: ${streamSid} (call ${callSid || 'unknown'}, business ${this.business.id})`);
        this.initializeDeepgram();
    }

    initializeDeepgram() {
        try {
            const stt = sttOptionsFor(this.business);
            this.engine.event('stt_config', { model: stt.model, language: stt.language });
            this.deepgramConnection = deepgram.listen.live({
                ...stt,
                smart_format: true,
                encoding: 'mulaw',
                sample_rate: 8000,
                channels: 1,
                interim_results: true,  // Required for utterance_end_ms
                utterance_end_ms: 1000,
                vad_events: true,
            });

            this.deepgramConnection.on('open', () => {
                console.log(`🎧 Deepgram connected for ${this.streamSid}`);
            });

            this.deepgramConnection.on('Results', (data) => {
                const transcript = data.channel?.alternatives?.[0]?.transcript?.trim();

                // Barge-in: caller starts talking over us -> stop our audio now,
                // using interim results so we don't wait for the sentence to end.
                if (transcript && (this.isSpeaking || this.streamingReply) && !isNoise(transcript) &&
                    transcript.split(/\s+/).length >= 2 && Date.now() - this.ttsStartTime > 600) {
                    this.stopPlaybackForBargeIn();
                }

                if (!data.is_final) return;
                if (transcript) {
                    this.pendingSegments.push(transcript);
                    // With language=multi, Deepgram tags each word's language; count them.
                    for (const w of data.channel?.alternatives?.[0]?.words || []) {
                        const lang = String(w.language || '').split('-')[0];
                        if (lang) this.pendingLanguages[lang] = (this.pendingLanguages[lang] || 0) + 1;
                    }
                }
                if (data.speech_final) this.flushUtterance('speech_final');
            });

            // Fallback when endpointing misses the end of speech (noisy lines).
            this.deepgramConnection.on('UtteranceEnd', () => this.flushUtterance('utterance_end'));

            this.deepgramConnection.on('error', (error) => {
                console.error(`❌ Deepgram error:`, error);
                this.engine.event('stt_error', { error: String(error?.message || error) });
            });

            this.deepgramConnection.on('close', () => {
                console.log(`👋 Deepgram closed for ${this.streamSid}`);
            });

        } catch (error) {
            console.error(`❌ Failed to initialize Deepgram:`, error);
        }
    }

    flushUtterance(trigger) {
        if (this.pendingSegments.length === 0) return;
        const text = this.pendingSegments.join(' ').replace(/\s+/g, ' ').trim();
        const langCounts = this.pendingLanguages;
        this.pendingSegments = [];
        this.pendingLanguages = {};
        // Dominant language of this utterance (only when Deepgram reported one).
        const detectedLanguage = Object.entries(langCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
        if (isNoise(text)) {
            console.log(`🚫 FILTERED noise: "${text}"`);
            return;
        }
        console.log(`📝 CALLER (${trigger}): "${text}"`);
        this.lastUtteranceAt = Date.now();
        this.firstChunkLogged = false;
        this.engine.event('stt_final', { trigger, chars: text.length, detected_language: detectedLanguage });
        this.utteranceQueue.push({ text, detectedLanguage });
        this.drainQueue();
    }

    /**
     * Process utterances one at a time. Nothing the caller says is dropped:
     * if they speak while we're thinking, it's merged into the next turn.
     */
    async drainQueue() {
        if (this.isProcessing || this.closed) return;
        this.isProcessing = true;
        try {
            while (this.utteranceQueue.length > 0 && !this.closed) {
                const batch = this.utteranceQueue.splice(0);
                const text = batch.map(u => u.text).join(' ');
                const detectedLanguage = batch[batch.length - 1].detectedLanguage;
                const started = Date.now();
                const reply = await this.engine.handleUtterance(text, { detectedLanguage });
                this.engine.event('turn_complete', { ms_to_reply_text: Date.now() - started });
                console.log(`🤖 AGENT: "${reply.say}"`);

                this.replyIsReadback = Boolean(reply.readback);
                await this.synthesizeAndSend(reply.say);
                if (reply.endCall) this.hangupWhenDone();
            }
        } catch (error) {
            console.error('❌ Error handling utterance:', error);
        } finally {
            this.isProcessing = false;
        }
    }

    hangupWhenDone() {
        this.hangupAfterPlayback = true;
        if (!this.isPlaying) this.finishPlaybackForHangup();
        // Safety net in case Twilio never acknowledges the final audio.
        this.hangupTimer = setTimeout(() => this.hangup('timeout'), 20000);
    }

    finishPlaybackForHangup() {
        // Ask Twilio to tell us when the caller has actually heard the last audio.
        this.sendToTwilio({ event: 'mark', streamSid: this.streamSid, mark: { name: 'goodbye' } });
    }

    onMark(name) {
        if (name === 'goodbye' && this.hangupAfterPlayback) this.hangup('goodbye_played');
    }

    hangup(reason) {
        if (this.closed) return;
        console.log(`📴 Ending call (${reason})`);
        this.engine.event('call_ended_by_agent', { reason });
        // Closing the media stream ends <Connect>; with no further TwiML the call hangs up.
        try { this.connection.close(); } catch { /* already closed */ }
    }

    sendToTwilio(payload) {
        try {
            if (this.connection.readyState === 1) this.connection.send(JSON.stringify(payload));
        } catch (error) {
            console.error('❌ Twilio send error:', error.message);
        }
    }

    async synthesizeAndSend(text) {
        const gen = ++this.replyGen;
        this.replyAudioBytes = 0;      // how long this reply is (8 bytes = 1 ms)
        this.replyPlayStartedAt = null; // when its first frame went out
        this.ttsStartTime = Date.now();
        this.streamingReply = true;
        this.audioCarry = Buffer.alloc(0);
        console.log(`🔊 Speaking: "${text.substring(0, 60)}..."`);
        try {
            // Audio is played as it streams in (Deepgram Aura for English).
            const result = await tts.stream(text, { business: this.business, language: this.engine.language }, async (chunk) => {
                if (gen !== this.replyGen || this.closed) return; // caller interrupted: drop the rest
                if (!this.firstAudioAt) {
                    this.firstAudioAt = Date.now();
                    this.engine.event('first_audio');
                }
                if (this.lastUtteranceAt && !this.firstChunkLogged) {
                    this.firstChunkLogged = true;
                    this.engine.event('reply_audio_started', { ms_since_caller_stopped: Date.now() - this.lastUtteranceAt });
                }
                this.enqueueMulaw(chunk);
            });
            if (gen === this.replyGen) this.enqueueMulaw(Buffer.alloc(0), { final: true });
            this.ttsFailures = 0;
            this.engine.event('tts', { provider: result.provider, first_audio_ms: result.firstAudioMs, ms: result.ms, cached: result.cached, fell_back: result.fellBack });
            console.log(`✅ TTS (${result.provider}${result.cached ? ', cached' : ''}${result.fellBack ? ', fallback' : ''}): first audio ${result.firstAudioMs}ms, ${(result.bytes / 8).toFixed(0)}ms of audio in ${result.ms}ms`);
        } catch (error) {
            console.error(`❌ TTS error: ${error.message}`);
            this.engine.event('tts_error', { error: error.message });
            await this.onVoiceFailure();
        } finally {
            if (gen === this.replyGen) this.streamingReply = false;
        }
    }

    /**
     * The caller can't hear us. Don't leave them in silence: after two voice
     * failures in a row (every configured provider already tried each time),
     * record a staff callback and hang up.
     */
    async onVoiceFailure() {
        this.ttsFailures = (this.ttsFailures || 0) + 1;
        if (this.voiceGaveUp || this.ttsFailures < 2) return;
        this.voiceGaveUp = true;
        console.error('📴 Voice unavailable: requesting a staff callback and ending the call');
        try {
            await this.engine.failToCallback('voice_unavailable');
        } catch (e) {
            console.error('❌ Callback request failed:', e.message);
        }
        this.hangup('voice_unavailable');
    }

    // Queue-based audio player. Streamed chunks arrive in arbitrary sizes, so a
    // partial 20 ms frame is carried over to the next chunk instead of being
    // padded with silence (which would click). Only the very end is padded.
    enqueueMulaw(mulawAudio, { final = false } = {}) {
        const CHUNK_SIZE = 160;
        this.replyAudioBytes = (this.replyAudioBytes || 0) + mulawAudio.length;
        let data = this.audioCarry.length ? Buffer.concat([this.audioCarry, mulawAudio]) : mulawAudio;
        const whole = data.length - (data.length % CHUNK_SIZE);
        for (let i = 0; i < whole; i += CHUNK_SIZE) this.outboundQueue.push(data.subarray(i, i + CHUNK_SIZE));
        this.audioCarry = Buffer.from(data.subarray(whole));

        if (final && this.audioCarry.length) {
            const padded = Buffer.alloc(CHUNK_SIZE, 0xFF); // μ-law silence
            this.audioCarry.copy(padded);
            this.outboundQueue.push(padded);
            this.audioCarry = Buffer.alloc(0);
        }

        // Start once ~200 ms is buffered (or the reply is complete), so a slow
        // network moment doesn't cause a stutter right at the start.
        const START_FRAMES = 10;
        if (!this.isPlaying && (final || this.outboundQueue.length >= START_FRAMES)) this.startPlayer();
    }

    startPlayer() {
        const FRAME_INTERVAL_MS = 20;
        this.isPlaying = true;
        this.currentStreamAbort = false;
        this.isSpeaking = true;

        this.frameSizes = [];
        this.sendIntervals = [];
        this.lastFrameSendTime = Date.now();

        if (!this.replyPlayStartedAt) this.replyPlayStartedAt = Date.now();
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
                this.isSpeaking = false;

                if (this.frameSizes.length > 0) {
                    const avgInterval = this.sendIntervals.length > 0
                        ? this.sendIntervals.reduce((a, b) => a + b, 0) / this.sendIntervals.length
                        : 0;
                    const sizesOk = this.frameSizes.every(s => s === 160);
                    console.log(`📊 Sent ${this.frameSizes.length} frames, avg interval ${avgInterval.toFixed(1)}ms (expected 20), frame sizes ${sizesOk ? 'OK' : 'VARY'}`);
                }
                if (this.hangupAfterPlayback) this.finishPlaybackForHangup();
                return;
            }

            const frame = this.outboundQueue.shift();

            const now = Date.now();
            this.frameSizes.push(frame.length);
            if (this.lastFrameSendTime > 0) this.sendIntervals.push(now - this.lastFrameSendTime);
            this.lastFrameSendTime = now;

            this.sendToTwilio({
                event: "media",
                streamSid: this.streamSid,
                media: { payload: frame.toString("base64") }
            });
        }, FRAME_INTERVAL_MS);
    }

    stopPlaybackForBargeIn() {
        // Never cut off the goodbye; the call is ending anyway.
        if (!(this.isPlaying || this.streamingReply) || this.hangupAfterPlayback) return;
        console.log('🛑 Caller interrupted: stopping playback');
        if (this.replyIsReadback) {
            // A readback only counts if the caller heard nearly all of it (the total comes last).
            const totalMs = (this.replyAudioBytes || 0) / 8;
            const playedMs = this.replyPlayStartedAt ? Date.now() - this.replyPlayStartedAt : 0;
            if (this.streamingReply || !totalMs || playedMs < totalMs * 0.85) this.engine.readbackInterrupted();
            this.replyIsReadback = false;
        }
        this.replyGen += 1;          // drop audio of this reply that is still streaming in
        this.streamingReply = false;
        this.audioCarry = Buffer.alloc(0);
        if (this.isPlaying) this.currentStreamAbort = true;
        else this.outboundQueue = [];
        this.isSpeaking = false;
        // Also drop audio Twilio has already buffered.
        this.sendToTwilio({ event: 'clear', streamSid: this.streamSid });
        this.engine.event('barge_in');
    }

    processAudio(audioPayload) {
        try {
            const mulawBuffer = Buffer.from(audioPayload, 'base64');
            if (this.deepgramConnection && this.deepgramConnection.getReadyState() === 1) {
                this.deepgramConnection.send(mulawBuffer);
            }
        } catch (error) {
            console.error(`❌ Audio processing error:`, error);
        }
    }

    async close() {
        if (this.closed) return;
        this.closed = true;
        console.log(`🛑 Closing session: ${this.streamSid}`);

        if (this.playTimer) clearInterval(this.playTimer);
        if (this.hangupTimer) clearTimeout(this.hangupTimer);

        // Order still open when the caller hung up: tell staff before the record is closed.
        try {
            await this.engine.alertIfOrderUnfinished();
        } catch (e) {
            console.error('❌ Unfinished-order alert failed:', e.message);
        }
        for (const w of this.engine.workflows) w.onEnd?.();
        const state = this.engine.callState();
        const order = state.workflows.restaurant_ordering || null;
        const submitted = order?.status === 'submitted';
        const callEndTime = new Date().toISOString();
        this.engine.event('call_closed', { final_status: order?.status || null, handoff: Boolean(state.handoff) });

        analytics.logCall({
            callId: state.call_id,
            businessId: state.business_id,
            locationId: state.location_id,
            language: state.language,
            languageHistory: state.language_history,
            startTime: this.callStartTime,
            endTime: callEndTime,
            duration: (new Date(callEndTime) - new Date(this.callStartTime)) / 1000,
            transcript: this.engine.messages
                .filter(m => (m.role === 'user' || m.role === 'assistant') && m.content)
                .map(m => ({ role: m.role, text: m.content })),
            orderCompleted: submitted,
            orderData: order,
            customerName: order?.customer?.name || null,
            customerPhone: order?.customer?.phone || null,
            failureReason: submitted ? null : (state.handoff?.reason || (order?.items?.length ? 'abandoned_with_items' : 'no_order')),
            events: this.engine.events,
        });

        // Durable call record in the database (stages, language, outcome; no transcript).
        await this.actions.logCall({
            callSid: state.call_id,
            locationId: this.locationId,
            routedBy: this.routedBy,
            startedAt: this.callStartTime,
            endedAt: callEndTime,
            language: state.language,
            languageHistory: state.language_history,
            outcome: submitted ? 'order_placed' : (state.handoff ? 'handoff' : (order?.items?.length ? 'abandoned_with_items' : 'no_order')),
            handoffReason: state.handoff?.reason || null,
            events: this.engine.events,
        });

        if (this.deepgramConnection) {
            try { this.deepgramConnection.finish(); } catch { /* ignore */ }
        }
        sessions.delete(this.streamSid);
    }
}

// Routes
fastify.get('/', async (request, reply) => {
    return { status: 'ok', service: 'Paahi voice agent', businesses: registry.list().length };
});

fastify.get('/health', async (request, reply) => {
    const results = await Promise.all([
        checkDeepgramHealth(),
        checkOpenAIHealth(),
        db.ping().then(() => ({ status: 'ok', service: 'Database' }), e => ({ status: 'error', service: 'Database', error: e.message })),
    ]);

    const allOk = results.every(r => r.status === 'ok');

    return {
        status: allOk ? 'healthy' : 'unhealthy',
        timestamp: new Date().toISOString(),
        services: results
    };
});

// Analytics endpoints: call records include customer names and numbers, so they
// require ADMIN_API_TOKEN, and can be filtered to one business with ?business_id=.
fastify.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/analytics')) return;
    const token = (request.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!ADMIN_API_TOKEN) return reply.code(404).send({ error: 'not_found' });
    if (token !== ADMIN_API_TOKEN) return reply.code(401).send({ error: 'unauthorized' });
});

fastify.get('/analytics/summary', async (request, reply) => {
    const stats = analytics.getStats();
    return {
        status: 'ok',
        data: stats
    };
});

fastify.get('/analytics/calls', async (request, reply) => {
    const limit = parseInt(request.query.limit) || 10;
    const businessId = request.query.business_id || null;
    const calls = businessId
        ? analytics.getRecentCalls(1000).filter(c => c.businessId === businessId).slice(0, limit)
        : analytics.getRecentCalls(limit);
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

function xmlEscape(value) {
    return String(value).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

fastify.post('/twiml', async (request, reply) => {
    // Only Twilio may start a call: check the signature before doing anything else.
    if (TWILIO_SIGNATURE_CHECK) {
        const url = requestUrl(request, PUBLIC_BASE_URL);
        const valid = isValidTwilioSignature({
            authToken: TWILIO_AUTH_TOKEN,
            signature: request.headers['x-twilio-signature'],
            url,
            params: request.body || {},
        });
        if (!valid) {
            console.warn(`🚫 /twiml rejected: missing or invalid Twilio signature (checked against ${url})`);
            return reply.code(403).type('text/plain').send('Forbidden');
        }
    }

    const wsUrl = `wss://${request.headers.host}/media-stream`;
    const from = request.body?.From || '';
    const to = request.body?.To || '';
    const callSid = request.body?.CallSid || '';

    // Route by the number that was dialed: one number -> one business.
    const route = registry.resolve(to);
    if (!route) {
        console.warn(`📞 Call to unconfigured number ${to}; declining`);
        reply.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say>Sorry, this number is not set up yet. Goodbye.</Say>
    <Hangup/>
</Response>`);
        return;
    }
    console.log(`📞 Incoming call for ${route.business.id} (${route.routedBy}) - WebSocket URL: ${wsUrl}`);

    // Pass business and caller ID to the media stream, with a token that ties them to this call.
    const streamToken = TWILIO_SIGNATURE_CHECK
        ? issueStreamToken(TWILIO_AUTH_TOKEN, {
            callSid, businessId: route.business.id, locationId: route.location.id, routedBy: route.routedBy, from,
        })
        : '';
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect>
        <Stream url="${xmlEscape(wsUrl)}" track="inbound_track">
            <Parameter name="business_id" value="${xmlEscape(route.business.id)}" />
            <Parameter name="location_id" value="${xmlEscape(route.location.id)}" />
            <Parameter name="routed_by" value="${xmlEscape(route.routedBy)}" />
            <Parameter name="from" value="${xmlEscape(from)}" />
            <Parameter name="stream_token" value="${xmlEscape(streamToken)}" />
        </Stream>
    </Connect>
</Response>`;

    console.log(`📤 TwiML Response: ${twimlResponse.replace(/(name="stream_token" value=")[^"]*/, '$1…')}`);
    reply.type('text/xml').send(twimlResponse);
});

fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('📞 Twilio connected');
        let session = null;
        let started = false;
        // Close streams that never identify themselves, so idle sockets can't pile up.
        const startTimer = setTimeout(() => {
            if (!started) {
                console.warn('🚫 Media stream sent no valid start; closing');
                connection.close();
            }
        }, STREAM_START_TIMEOUT_MS);

        connection.on('message', async (message) => {
            try {
                const msg = JSON.parse(message.toString());

                switch (msg.event) {
                    case 'start':
                        if (started) return; // one call per stream
                        const streamSid = msg.start.streamSid;
                        const params = msg.start.customParameters || {};
                        // The stream must carry the token /twiml issued for this call SID and these parameters.
                        if (TWILIO_SIGNATURE_CHECK) {
                            const check = verifyStreamToken(TWILIO_AUTH_TOKEN, params.stream_token, {
                                callSid: msg.start.callSid,
                                businessId: params.business_id,
                                locationId: params.location_id,
                                routedBy: params.routed_by,
                                from: params.from,
                            });
                            if (!check.ok) {
                                console.warn(`🚫 Media stream rejected (${check.reason}); closing`);
                                connection.close();
                                return;
                            }
                        }
                        started = true;
                        clearTimeout(startTimer);
                        const entry = registry.get(params.business_id);
                        if (!entry) {
                            console.warn(`❌ Media stream for unknown business "${params.business_id}"; closing`);
                            connection.close();
                            return;
                        }
                        const location = entry.business.locations.find(l => l.id === params.location_id) || entry.business.locations[0];
                        session = new VoiceSession(streamSid, connection, {
                            route: { business: entry.business, submitter: entry.submitter, location, routedBy: params.routed_by || null },
                            callSid: msg.start.callSid,
                            callerPhone: params.from || null,
                        });
                        sessions.set(streamSid, session);

                        // Greet right away; the stream is ready once 'start' arrives.
                        await session.synthesizeAndSend(session.engine.greeting());
                        break;

                    case 'mark':
                        if (session) session.onMark(msg.mark?.name);
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
            clearTimeout(startTimer);
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
        // Database must be reachable, migrated, and unable to bypass row-level security.
        const { role } = await db.checkTenantSafety();
        console.log(`🗄️ Database connected as ${role} (row-level security enforced)${DATABASE_CA_CERT ? '' : '; TLS certificate not verified (set DATABASE_CA_CERT)'}`);
        for (const b of registry.list()) {
            // Every enabled language needs a working voice (e.g. Hindi/Telugu need Google credentials today).
            const missing = tts.missingVoices(b);
            if (missing.length) throw new Error(`${b.id}: no configured voice for ${missing.join(', ')}`);
            await syncBusiness(db, b);
            // An order nobody hears about is worse than no order: require a way to tell staff.
            if (b.workflows.restaurant_ordering && notificationChannels(b, emailService).length === 0) {
                throw new Error(`${b.id} takes orders but has no working notification channel (email or webhook)`);
            }
        }
        notifier.start(() => registry.list());

        // Pre-generate each business's greeting so the first words of every call play instantly.
        for (const b of registry.list()) {
            const entry = registry.get(b.id);
            const greeting = createConversation({
                route: { business: b, submitter: entry.submitter, location: b.locations[0], routedBy: 'warmup' },
                callId: 'warmup', llm: openai, model: LLM_MODEL,
            }).greeting();
            tts.stream(greeting, { business: b, language: b.languages.default }, async () => {})
                .then(r => console.log(`🔥 Greeting ready for ${b.id} (${r.provider}, ${r.ms}ms)`))
                .catch(e => console.error(`⚠️ Greeting warm-up failed for ${b.id}: ${e.message}`));
        }
        for (const b of registry.list()) notifier.deliverDue(b).catch(e => console.error(`❌ Startup delivery (${b.id}):`, e.message));

        await fastify.listen({ port: PORT, host: '0.0.0.0' });
        console.log(`🚀 Server running on port ${PORT}`);
        await runStartupHealthChecks();
    } catch (err) {
        console.error(`❌ Startup failed: ${err.message}`);
        process.exit(1);
    }
})();
