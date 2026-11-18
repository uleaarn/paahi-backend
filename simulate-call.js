#!/usr/bin/env node
/**
 * Text-mode call simulator. Talk to the exact same business routing, workflow
 * and conversation code the phone line uses, by typing instead of speaking.
 * No Twilio, Deepgram or Google TTS needed — only the LLM key
 * (OPENAI_API_KEY / LLM_BASE_URL / LLM_MODEL).
 *
 *   npm run simulate
 *   npm run simulate -- --business jalwa-montclair --caller-id 9735551234
 *   npm run simulate -- --languages en,hi,te     (try experimental languages)
 *   npm run simulate -- --respect-hours          (enforce opening hours)
 *
 * Orders are saved to a local in-process Postgres (logs/simulator/db) that runs the
 * real Supabase migrations and row-level security. Nothing is emailed or posted.
 */
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { BusinessRegistry } from './business-registry.js';
import { createConversation, actionsFactory } from './call-factory.js';
import { createDevDatabase } from './dev-database.js';
import { Notifier, syncBusiness } from './business-actions.js';

dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (!process.env.OPENAI_API_KEY) {
    console.error('Set OPENAI_API_KEY (and optionally LLM_BASE_URL, LLM_MODEL) in .env first.');
    process.exit(1);
}

const args = process.argv.slice(2);
const arg = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const businessId = arg('--business') || process.env.DEFAULT_BUSINESS_ID || 'jalwa-montclair';
const callerPhone = arg('--caller-id');
const languages = arg('--languages')?.split(',').map(s => s.trim()).filter(Boolean);
const respectHours = args.includes('--respect-hours');

const { db, raw } = await createDevDatabase({ dataDir: path.join(__dirname, 'logs', 'simulator', 'db') });
const registry = new BusinessRegistry({
    rootDir: path.join(__dirname, 'businesses'),
    // Simulator: no email or webhook secrets, so nothing leaves this machine.
    env: {},
    createSubmitter: actionsFactory({ db, notifier: new Notifier({ db }) }),
    overrides: languages ? { [businessId]: { languages: { enabled: languages, allow_experimental: true } } } : {},
});
const entry = registry.get(businessId);
if (!entry) {
    console.error(`Unknown business "${businessId}". Available: ${registry.list().map(b => b.id).join(', ')}`);
    process.exit(1);
}

await syncBusiness(db, entry.business);
const callId = `sim-${Date.now()}`;
const engine = createConversation({
    route: { business: entry.business, submitter: entry.submitter, location: entry.business.locations[0], routedBy: 'simulator' },
    callId,
    callerPhone,
    llm: new OpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: process.env.LLM_BASE_URL || 'https://api.deepseek.com' }),
    model: process.env.LLM_MODEL || 'deepseek-chat',
    allowOrdersWhenClosed: !respectHours,
});

console.log(`\n📞 Simulated call ${callId} to ${entry.business.name} — languages: ${entry.business.languages.enabled.join(', ')}` +
    `${respectHours ? '' : ' (opening hours ignored; pass --respect-hours to enforce)'}`);
console.log('Type what the caller says. Commands: /state  /quit\n');
console.log(`AGENT [${engine.language}]: ${engine.greeting()}`);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'YOU:   ' });
rl.prompt();
rl.on('line', async (line) => {
    const text = line.trim();
    if (!text) return rl.prompt();
    if (text === '/quit') return rl.close();
    if (text === '/state') {
        console.log(JSON.stringify(engine.callState(), null, 2));
        return rl.prompt();
    }
    rl.pause();
    const started = Date.now();
    const reply = await engine.handleUtterance(text);
    console.log(`AGENT [${reply.language}]: ${reply.say}   [${Date.now() - started}ms]`);
    if (reply.endCall) {
        console.log('\n📴 Call ended. Final call state:');
        console.log(JSON.stringify(engine.callState(), null, 2));
        const saved = (await raw.query('select id, order_type, customer_name, subtotal, language, created_at from public.orders where call_sid = $1', [callId])).rows;
        console.log(saved.length ? `🗄️ Saved in database: ${JSON.stringify(saved[0])}` : '🗄️ No order saved for this call.');
        return rl.close();
    }
    rl.resume();
    rl.prompt();
});
rl.on('close', () => process.exit(0));
