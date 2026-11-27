/**
 * Twilio request checks: webhook signatures and media-stream tokens. No network.
 *   npm run test:security
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    twilioSignature, isValidTwilioSignature, requestUrl,
    issueStreamToken, verifyStreamToken, STREAM_TOKEN_TTL_MS,
} from './twilio-security.js';

const AUTH_TOKEN = '12345';
const URL = 'https://mycompany.com/myapp.php?foo=1&bar=2';
const PARAMS = { CallSid: 'CA1234567890ABCDE', Caller: '+12349013030', Digits: '1234', From: '+12349013030', To: '+18005551212' };
// Produced by the official twilio package (getExpectedTwilioSignature) for the inputs above.
const TWILIO_SIGNATURE = '0/KCTR6DLpKmkAf8muzZqo1nDgQ=';

test('signature matches what Twilio sends', () => {
    assert.equal(twilioSignature(AUTH_TOKEN, URL, PARAMS), TWILIO_SIGNATURE);
    assert.equal(isValidTwilioSignature({ authToken: AUTH_TOKEN, signature: TWILIO_SIGNATURE, url: URL, params: PARAMS }), true);
});

test('field order does not matter', () => {
    const shuffled = Object.fromEntries(Object.entries(PARAMS).reverse());
    assert.equal(twilioSignature(AUTH_TOKEN, URL, shuffled), TWILIO_SIGNATURE);
});

test('a changed field, URL, token or missing header is rejected', () => {
    const ok = { authToken: AUTH_TOKEN, signature: TWILIO_SIGNATURE, url: URL, params: PARAMS };
    assert.equal(isValidTwilioSignature({ ...ok, params: { ...PARAMS, From: '+19999999999' } }), false);
    assert.equal(isValidTwilioSignature({ ...ok, params: { ...PARAMS, Extra: 'x' } }), false);
    assert.equal(isValidTwilioSignature({ ...ok, url: 'https://evil.example.com/myapp.php?foo=1&bar=2' }), false);
    assert.equal(isValidTwilioSignature({ ...ok, authToken: 'wrong' }), false);
    assert.equal(isValidTwilioSignature({ ...ok, signature: undefined }), false);
    assert.equal(isValidTwilioSignature({ ...ok, signature: 'short' }), false);
    assert.equal(isValidTwilioSignature({ ...ok, authToken: null }), false);
});

test('request URL is rebuilt the way Twilio called it', () => {
    const req = (headers, url = '/twiml') => ({ url, headers });
    assert.equal(requestUrl(req({ host: 'paahi.up.railway.app' })), 'https://paahi.up.railway.app/twiml');
    assert.equal(requestUrl(req({ host: 'internal:3000', 'x-forwarded-host': 'abc.ngrok.app', 'x-forwarded-proto': 'https' })), 'https://abc.ngrok.app/twiml');
    assert.equal(requestUrl(req({ host: 'localhost:3000', 'x-forwarded-proto': 'http' }), null), 'http://localhost:3000/twiml');
    assert.equal(requestUrl(req({ host: 'internal' }, '/twiml?x=1'), 'https://paahi.example.com/'), 'https://paahi.example.com/twiml?x=1');
});

const CALL = { callSid: 'CA00000000000000000000000000000001', businessId: 'jalwa-montclair', locationId: 'main', routedBy: 'number', from: '+19735550100' };

test('a stream token is accepted for the call it was issued for', () => {
    const token = issueStreamToken(AUTH_TOKEN, CALL);
    assert.deepEqual(verifyStreamToken(AUTH_TOKEN, token, CALL), { ok: true });
});

test('a stream token cannot be reused for another call or other parameters', () => {
    const token = issueStreamToken(AUTH_TOKEN, CALL);
    for (const change of [{ callSid: 'CA99' }, { businessId: 'other-business' }, { locationId: 'other' }, { routedBy: 'default' }, { from: '+12125550199' }]) {
        assert.deepEqual(verifyStreamToken(AUTH_TOKEN, token, { ...CALL, ...change }), { ok: false, reason: 'bad_signature' }, JSON.stringify(change));
    }
    assert.equal(verifyStreamToken('other-secret', token, CALL).ok, false);
});

test('a stream token expires', () => {
    const now = 1_800_000_000_000;
    const token = issueStreamToken(AUTH_TOKEN, CALL, now);
    assert.equal(verifyStreamToken(AUTH_TOKEN, token, CALL, now + STREAM_TOKEN_TTL_MS - 1).ok, true);
    assert.deepEqual(verifyStreamToken(AUTH_TOKEN, token, CALL, now + STREAM_TOKEN_TTL_MS + 1), { ok: false, reason: 'expired' });
});

test('a later expiry cannot be forged', () => {
    const token = issueStreamToken(AUTH_TOKEN, CALL);
    const [, mac] = token.split('.');
    const forged = `${Date.now() + 10 * STREAM_TOKEN_TTL_MS}.${mac}`;
    assert.deepEqual(verifyStreamToken(AUTH_TOKEN, forged, CALL), { ok: false, reason: 'bad_signature' });
});

test('missing or malformed tokens are rejected', () => {
    assert.deepEqual(verifyStreamToken(AUTH_TOKEN, undefined, CALL), { ok: false, reason: 'missing' });
    assert.deepEqual(verifyStreamToken(AUTH_TOKEN, 'abc', CALL), { ok: false, reason: 'malformed' });
    assert.deepEqual(verifyStreamToken(AUTH_TOKEN, issueStreamToken(AUTH_TOKEN, CALL), { ...CALL, callSid: '' }), { ok: false, reason: 'missing' });
});
