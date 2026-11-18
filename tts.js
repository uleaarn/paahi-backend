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
 */
import mulaw from 'alawmulaw';
import { LANGUAGES } from './languages.js';

const DEEPGRAM_SPEAK_URL = 'https://api.deepgram.com/v1/speak';

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

    async deepgram(text, voice) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
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
            const audio = Buffer.from(await res.arrayBuffer());
            if (audio.length === 0) throw new Error('Deepgram TTS returned no audio');
            return audio;
        } catch (error) {
            throw error.name === 'AbortError' ? new Error('Deepgram TTS timed out') : error;
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
     * @returns {Promise<{ audio: Buffer, provider: string, voice: string, ms: number, fellBack: boolean }>}
     */
    async synthesize(text, { business, language }) {
        const errors = [];
        const voices = this.voicesFor(business, language).filter(v => this.available(v.provider));
        if (voices.length === 0) throw new Error(`no configured voice for language ${language}`);
        for (const [i, voice] of voices.entries()) {
            const started = Date.now();
            try {
                const audio = voice.provider === 'deepgram' ? await this.deepgram(text, voice) : await this.google(text, voice);
                return { audio, provider: voice.provider, voice: voice.voice, ms: Date.now() - started, fellBack: i > 0 };
            } catch (error) {
                errors.push(`${voice.provider}: ${error.message}`);
                this.log.error(`❌ TTS ${voice.provider} failed: ${error.message}`);
            }
        }
        throw new Error(errors.join(' | '));
    }
}
