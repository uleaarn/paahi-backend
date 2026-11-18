/**
 * Business registry: loads every business under businesses/<id>/business.json,
 * validates it, and routes an incoming call (by the number dialed) to exactly
 * one business.
 *
 * Isolation: each business gets its own data (menu), its own order store
 * folder and its own notification settings. A call session only ever receives
 * the one business object it was routed to.
 *
 * Secrets are never stored in business.json. Fields ending in "_env" name an
 * environment variable that holds the value.
 */
import fs from 'fs';
import path from 'path';
import { LANGUAGES, isKnownLanguage, hasPhrases } from './languages.js';
import { WORKFLOWS } from './workflows/index.js';
import { normalizePhone } from './order-state.js';

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;

/** Normalize to E.164 for US numbers; leave other +numbers as digits with a +. */
export function toE164(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    const us = normalizePhone(s);
    if (us && (!s.startsWith('+') || s.startsWith('+1'))) return `+1${us}`;
    const digits = s.replace(/\D/g, '');
    return s.startsWith('+') && digits.length >= 8 ? `+${digits}` : null;
}

function validateBusiness(raw, dirName) {
    const errors = [];
    const err = msg => errors.push(`${dirName}: ${msg}`);

    if (!ID_PATTERN.test(raw.id || '')) err('id must be lowercase letters, digits and dashes');
    if (raw.id !== dirName) err(`id "${raw.id}" must match its folder name`);
    if (!raw.name) err('name is required');
    if (!raw.timezone) err('timezone is required (e.g. America/New_York)');
    else {
        try { new Intl.DateTimeFormat('en-US', { timeZone: raw.timezone }); } catch { err(`unknown timezone ${raw.timezone}`); }
    }
    if (!Array.isArray(raw.locations) || raw.locations.length === 0) err('at least one location is required');
    for (const loc of raw.locations || []) {
        if (!loc.id) err('every location needs an id');
        if (!loc.hours || typeof loc.hours !== 'object') err(`location ${loc.id}: hours are required`);
    }

    const langs = raw.languages || {};
    const enabled = langs.enabled || [];
    if (enabled.length === 0) err('languages.enabled must list at least one language');
    for (const code of enabled) {
        if (!isKnownLanguage(code) || !hasPhrases(code)) { err(`language "${code}" is not implemented`); continue; }
        if (LANGUAGES[code].status === 'experimental' && !langs.allow_experimental) {
            err(`language "${code}" is experimental; set languages.allow_experimental=true to enable it for testing`);
        }
    }
    if (!enabled.includes(langs.default)) err('languages.default must be one of languages.enabled');

    const workflows = raw.workflows || {};
    const enabledWorkflows = Object.entries(workflows).filter(([, cfg]) => cfg?.enabled);
    if (enabledWorkflows.length === 0) err('enable at least one workflow');
    for (const [wfId] of enabledWorkflows) {
        if (!WORKFLOWS[wfId]) err(`workflow "${wfId}" is not implemented`);
    }

    for (const entry of raw.phone_numbers || []) {
        const number = typeof entry === 'string' ? entry : entry.number;
        if (!toE164(number)) err(`invalid phone number ${number}`);
        const locId = typeof entry === 'string' ? null : entry.location_id;
        if (locId && !(raw.locations || []).some(l => l.id === locId)) err(`phone number ${number} points to unknown location ${locId}`);
    }
    return errors;
}

export class BusinessRegistry {
    /**
     * @param {object} o
     * @param {string} o.rootDir   folder containing one sub-folder per business
     * @param {object} [o.env]     environment for *_env lookups (defaults to process.env)
     * @param {(business) => object} o.createSubmitter  builds the business's own order submitter
     * @param {string|null} [o.defaultBusinessId] used when the dialed number isn't configured
     * @param {object} [o.overrides] { [businessId]: { languages: {...} } } — for the simulator and tests only
     */
    constructor({ rootDir, env = process.env, createSubmitter, defaultBusinessId = null, overrides = {}, logger = console }) {
        this.overrides = overrides;
        this.rootDir = rootDir;
        this.env = env;
        this.log = logger;
        this.businesses = new Map();
        this.numberIndex = new Map(); // E.164 -> { businessId, locationId }
        this.warnings = [];
        this.load(createSubmitter);
        this.defaultBusinessId = defaultBusinessId || null;
        if (this.defaultBusinessId && !this.businesses.has(this.defaultBusinessId)) {
            throw new Error(`DEFAULT_BUSINESS_ID "${this.defaultBusinessId}" does not match any business folder`);
        }
    }

    secret(name) {
        if (!name) return null;
        const value = this.env[name];
        return value && !/^your_|_here$|example\.com/.test(value) ? value : null;
    }

    load(createSubmitter) {
        if (!fs.existsSync(this.rootDir)) throw new Error(`Business folder not found: ${this.rootDir}`);
        const errors = [];
        const dirs = fs.readdirSync(this.rootDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();

        for (const dirName of dirs) {
            const businessDir = path.join(this.rootDir, dirName);
            const file = path.join(businessDir, 'business.json');
            if (!fs.existsSync(file)) continue;
            let raw;
            try {
                raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
            } catch (e) {
                errors.push(`${dirName}: business.json is not valid JSON (${e.message})`);
                continue;
            }
            const ov = this.overrides[raw.id];
            if (ov?.languages) raw.languages = { ...raw.languages, ...ov.languages };
            const problems = validateBusiness(raw, dirName);
            if (problems.length) { errors.push(...problems); continue; }

            // Prepare each enabled workflow with this business's own data.
            const workflows = {};
            for (const [wfId, cfg] of Object.entries(raw.workflows)) {
                if (!cfg?.enabled) continue;
                const result = WORKFLOWS[wfId].prepare(cfg, { businessDir, business: raw });
                if (result.errors.length) { errors.push(...result.errors.map(e => `${dirName}/${wfId}: ${e}`)); continue; }
                workflows[wfId] = { module: WORKFLOWS[wfId], prepared: result.prepared };
                this.warnings.push(...(result.warnings || []).map(w => `${dirName}/${wfId}: ${w}`));
            }

            const business = Object.freeze({
                id: raw.id,
                name: raw.name,
                shortName: raw.short_name || raw.name,
                type: raw.business_type || null,
                timezone: raw.timezone,
                agentName: raw.agent_name || 'Paahi',
                locations: raw.locations,
                languages: {
                    default: raw.languages.default,
                    enabled: [...raw.languages.enabled],
                    greetings: raw.languages.greetings || {},
                    voices: raw.languages.voices || {},
                },
                faqs: Array.isArray(raw.faqs) ? raw.faqs : [],
                workflows,
                escalation: {
                    callbackEnabled: raw.escalation?.callback_enabled !== false,
                    transferPhone: toE164(this.secret(raw.escalation?.transfer_phone_env)),
                },
                notifications: {
                    emailTo: this.secret(raw.notifications?.email_to_env),
                    webhookUrl: this.secret(raw.notifications?.webhook_url_env),
                },
                voice: raw.voice || {},
            });
            this.businesses.set(business.id, { business, submitter: null });

            for (const entry of raw.phone_numbers || []) {
                const number = toE164(typeof entry === 'string' ? entry : entry.number);
                const locationId = (typeof entry === 'string' ? null : entry.location_id) || raw.locations[0].id;
                if (this.numberIndex.has(number)) {
                    errors.push(`${dirName}: phone number ${number} is already used by ${this.numberIndex.get(number).businessId}`);
                    continue;
                }
                this.numberIndex.set(number, { businessId: business.id, locationId });
            }
        }

        if (errors.length) throw new Error(`Business configuration errors:\n  - ${errors.join('\n  - ')}`);
        if (this.businesses.size === 0) throw new Error(`No businesses found in ${this.rootDir}`);

        for (const entry of this.businesses.values()) {
            entry.submitter = createSubmitter(entry.business);
        }
    }

    list() {
        return [...this.businesses.values()].map(e => e.business);
    }

    get(businessId) {
        return this.businesses.get(businessId) || null;
    }

    /**
     * Route a call by the number that was dialed.
     * @returns {{ business, submitter, location, routedBy } | null}
     */
    resolve(dialedNumber) {
        const number = toE164(dialedNumber);
        const hit = number ? this.numberIndex.get(number) : null;
        if (hit) return this.entry(hit.businessId, hit.locationId, 'dialed_number');
        if (this.defaultBusinessId) return this.entry(this.defaultBusinessId, null, 'default_business');
        return null;
    }

    entry(businessId, locationId, routedBy) {
        const e = this.businesses.get(businessId);
        if (!e) return null;
        const location = e.business.locations.find(l => l.id === locationId) || e.business.locations[0];
        return { business: e.business, submitter: e.submitter, location, routedBy };
    }
}
