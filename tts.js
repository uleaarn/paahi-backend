/**
 * Text-to-speech: turns a reply into 8 kHz μ-law audio, the format Twilio plays.
 *
 * Providers (chosen per language in languages.js, or per business in business.json):
 *   - deepgram: Deepgram Aura (same DEEPGRAM_API_KEY used for listening). Returns
 *     μ-law 8 kHz with no container, so the audio goes to Twilio unchanged.
 *   - google:   Google Cloud TTS (needs GOOGLE_APPLICATION_CREDENTIALS_JSON and billing).
 *     Returns 16-bit PCM, converted to μ-law here.
 *
 * If the chosen provider fails and another configured provider can speak the
 * same language, that one is tried before giving up.
 *
 * Speed: stream() hands audio to the caller piece by piece as Deepgram
 * produces it, so playback starts within a fraction of a second instead of
 * after the whole reply is generated. Short repeated lines (greetings,
 * goodbyes) are cached in memory and play instantly.
 */
import mulaw from 'alawmulaw';
import { LANGUAGES } from './languages.js';

const DEEPGRAM_SPEAK_URL = 'https://api.deepgram.com/v1/speak';
const CACHE_MAX_ENTRIES = 200;
const CACHE_MAX_TEXT = 300; // only cache short lines; long replies are rarely repeated

function pcm16ToMulaw(pcm16Buffer) {
    const aligned = Buffer.from(pcm16Buffer);
    const samples = new Int16Array(aligned.buffer, aligned.byteOffset, Math.floor(aligned.length / 2));
    return Buffer.from(mulaw.mulaw.encode(samples));
}

/** Strip a WAV header if one is present. */
function stripWav(buf) {
    if (buf.subarray(0, 4).toString('ascii') !== 'RIFF') return buf;
    const dataAt = buf.indexOf('data', 12, 'ascii');
    return dataAt > 0 ? buf.subarray(dataAt + 8) : buf;
}

export class TextToSpeech {
    /**
     * @param {object} o
     * @param {string|null} o.deepgramKey
     * @param {object|null} o.googleClient  @google-cloud/text-to-speech client, or null if not configured
     */
    constructor({ deepgramKey = null, googleClient = null, fetchImpl = globalThis.fetch, timeoutMs = 8000, logger = console }) {
        Object.assign(this, { deepgramKey, googleClient, fetch: fetchImpl, timeoutMs });
        this.log = logger;
        this.cache = new Map(); // key -> Buffer (insertion order = age)
    }

    cacheKey(voice, text) {
        return `${voice.provider}|${voice.voice}|${text}`;
    }

    remember(key, audio) {
        if (this.cache.has(key)) this.cache.delete(key);
        this.cache.set(key, audio);
        while (this.cache.size > CACHE_MAX_ENTRIES) this.cache.delete(this.cache.keys().next().value);
    }

    available(provider) {
        if (provider === 'deepgram') return Boolean(this.deepgramKey);
        if (provider === 'google') return Boolean(this.googleClient);
        return false;
    }

    /** Voice choices for a language, in order: the business override or default first, then any fallback. */
    voicesFor(business, language) {
        const lang = LANGUAGES[language];
        if (!lang) throw new Error(`unknown language ${language}`);
        const override = business?.languages?.voices?.[language];
        const primary = override?.voice
            ? { provider: override.provider || lang.tts.provider, voice: override.voice, languageCode: override.language_code || lang.tts.languageCode }
            : lang.tts;
        const fallbacks = (lang.ttsFallbacks || []).filter(v => v.provider !== primary.provider);
        return [primary, ...fallbacks];
    }

    /** Can this business speak every enabled language with the configured providers? */
    missingVoices(business) {
        return business.languages.enabled.filter(code => !this.voicesFor(business, code).some(v => this.available(v.provider)));
    }

    /** Stream Deepgram Aura audio; onChunk(Buffer) is called as pieces arrive. */
    async deepgramStream(text, voice, onChunk) {
        const controller = new AbortController();
        // The timeout covers the wait for the first audio; once audio flows, it keeps flowing.
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        let total = 0;
        try {
            const url = `${DEEPGRAM_SPEAK_URL}?model=${encodeURIComponent(voice.voice)}&encoding=mulaw&sample_rate=8000&container=none`;
            const res = await this.fetch(url, {
                method: 'POST',
                headers: { Authorization: `Token ${this.deepgramKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ text }),
                signal: controller.signal,
            });
            if (!res.ok) {
                const detail = await res.text().catch(() => '');
                throw new Error(`Deepgram TTS HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
            }
            if (res.body && typeof res.body[Symbol.asyncIterator] === 'function') {
                for await (const piece of res.body) {
                    clearTimeout(timer);
                    const buf = Buffer.from(piece);
                    if (buf.length) { total += buf.length; await onChunk(buf); }
                }
            } else {
                const buf = Buffer.from(await res.arrayBuffer());
                if (buf.length) { total += buf.length; await onChunk(buf); }
            }
            if (total === 0) throw new Error('Deepgram TTS returned no audio');
            return total;
        } catch (error) {
            const e = error.name === 'AbortError' ? new Error('Deepgram TTS timed out') : error;
            e.audioSent = total > 0;
            throw e;
        } finally {
            clearTimeout(timer);
        }
    }

    async google(text, voice) {
        const [response] = await this.googleClient.synthesizeSpeech({
            input: { text },
            voice: { languageCode: voice.languageCode, name: voice.voice },
            // pitch omitted: Chirp3-HD voices don't accept it.
            audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 8000, speakingRate: 1.0 },
        });
        const pcm = Buffer.isBuffer(response.audioContent) ? response.audioContent : Buffer.from(response.audioContent, 'base64');
        return pcm16ToMulaw(stripWav(pcm));
    }

    /**
     * Speak `text`, handing μ-law audio to onChunk as soon as it exists.
     * Falls back to the next provider only if nothing has been played yet.
     * @returns {Promise<{ provider, voice, firstAudioMs, ms, bytes, fellBack, cached }>}
     */
    /** Respell words the voice says wrong (business.json "pronunciations"), whole words only. */
    applyPronunciations(text, business) {
        let out = text;
        for (const [word, spoken] of Object.entries(business?.pronunciations || {})) {
            const re = new RegExp(`(?<![\\p{L}])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}])`, 'giu');
            out = out.replace(re, spoken);
        }
        return out;
    }

    async stream(text, { business, language }, onChunk) {
        text = this.applyPronunciations(text, business);
        const errors = [];
        const voices = this.voicesFor(business, language).filter(v => this.available(v.provider));
        if (voices.length === 0) throw new Error(`no configured voice for language ${language}`);
        for (const [i, voice] of voices.entries()) {
            const started = Date.now();
            const key = this.cacheKey(voice, text);
            const cached = this.cache.get(key);
            if (cached) {
                await onChunk(cached);
                return { provider: voice.provider, voice: voice.voice, firstAudioMs: 0, ms: 0, bytes: cached.length, fellBack: i > 0, cached: true };
            }
            let firstAudioMs = null;
            const pieces = [];
            const deliver = async (buf) => {
                if (firstAudioMs === null) firstAudioMs = Date.now() - started;
                if (text.length <= CACHE_MAX_TEXT) pieces.push(buf);
                await onChunk(buf);
            };
            try {
                if (voice.provider === 'deepgram') await this.deepgramStream(text, voice, deliver);
                else await deliver(await this.google(text, voice));
                const bytes = pieces.reduce((n, b) => n + b.length, 0);
                if (text.length <= CACHE_MAX_TEXT && bytes) this.remember(key, Buffer.concat(pieces));
                return { provider: voice.provider, voice: voice.voice, firstAudioMs, ms: Date.now() - started, bytes, fellBack: i > 0, cached: false };
            } catch (error) {
                errors.push(`${voice.provider}: ${error.message}`);
                this.log.error(`❌ TTS ${voice.provider} failed: ${error.message}`);
                // Part of the reply was already played; don't start it over in another voice.
                if (error.audioSent || firstAudioMs !== null) throw new Error(errors.join(' | '));
            }
        }
        throw new Error(errors.join(' | '));
    }

    /** Whole reply as one buffer (used by tests and tools). */
    async synthesize(text, opts) {
        const parts = [];
        const r = await this.stream(text, opts, async b => { parts.push(b); });
        return { ...r, audio: Buffer.concat(parts) };
    }
}
