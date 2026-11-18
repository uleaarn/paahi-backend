/**
 * Builds the per-call conversation for one routed business. Shared by the
 * phone server, the text simulator and the tests, so they all run the same
 * code path.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ConversationEngine } from './conversation-engine.js';
import { BusinessActions } from './business-actions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CORE_INSTRUCTIONS = fs.readFileSync(path.join(__dirname, 'prompts', 'core-instructions.md'), 'utf-8');

/**
 * @param {object} route   result of BusinessRegistry.resolve(): { business, submitter, location, routedBy }
 */
export function createConversation({ route, callId, callerPhone = null, llm, model, clock, allowOrdersWhenClosed = false, llmTimeoutMs, logger }) {
    const { business, submitter, location, routedBy } = route;
    const workflows = Object.values(business.workflows).map(({ module, prepared }) =>
        module.createSession({ prepared, callId, clock, submitter, business, location }));
    return new ConversationEngine({
        llm, model, business, location, workflows, submitter,
        instructions: CORE_INSTRUCTIONS,
        callId, callerPhone, routedBy, allowOrdersWhenClosed, clock, llmTimeoutMs, logger,
    });
}

/** Each business gets its own actions object: database writes scoped to that business only. */
export function actionsFactory({ db, notifier, emailService = null, logger }) {
    return business => new BusinessActions({ business, db, notifier, emailService, logger });
}
