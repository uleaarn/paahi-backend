/**
 * Checks that calls really come from Twilio.
 *
 * 1. POST /twiml: Twilio signs every webhook with the account's auth token
 *    (X-Twilio-Signature: base64 HMAC-SHA1 of the full URL plus the sorted form
 *    fields). A request without a valid signature gets 403 and no TwiML.
 * 2. WS /media-stream: /twiml hands the stream a short-lived token, signed by
 *    this server, that binds the call SID to the business, location, routing and
 *    caller number it was given. The stream is accepted only if the token matches
 *    the call Twilio says it is carrying, so nobody can open a stream (and spend
 *    speech and model minutes) or swap the business or caller ID.
 */
import crypto from 'crypto';

// How long a stream token stays valid. Twilio opens the stream within a second or two.
export const STREAM_TOKEN_TTL_MS = 2 * 60 * 1000;

/** The signature Twilio would send for this URL and these POST fields. */
export function twilioSignature(authToken, url, params = {}) {
    const data = Object.keys(params).sort().reduce((acc, key) => acc + key + (params[key] ?? ''), url);
    return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

function safeEqual(a, b) {
    const x = Buffer.from(String(a || ''));
    const y = Buffer.from(String(b || ''));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** True when the X-Twilio-Signature header matches the request. */
export function isValidTwilioSignature({ authToken, signature, url, params }) {
    if (!authToken || !signature || !url) return false;
    return safeEqual(signature, twilioSignature(authToken, url, params));
}

/**
 * The URL Twilio called. Behind a proxy (Railway, ngrok) the app sees plain HTTP,
 * so the scheme comes from X-Forwarded-Proto (https by default) unless
 * PUBLIC_BASE_URL pins it, e.g. https://paahi.example.com.
 */
export function requestUrl(request, publicBaseUrl = null) {
    if (publicBaseUrl) return publicBaseUrl.replace(/\/+$/, '') + request.url;
    const proto = String(request.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
    const host = request.headers['x-forwarded-host'] || request.headers.host;
    return `${proto}://${host}${request.url}`;
}

function streamPayload({ callSid, businessId, locationId, routedBy, from, expires }) {
    return ['paahi-stream-v1', callSid, businessId, locationId, routedBy, from, expires].map(v => String(v ?? '')).join('|');
}

function streamMac(secret, fields) {
    return crypto.createHmac('sha256', secret).update(streamPayload(fields)).digest('base64url');
}

/** A token for one call's media stream: "<expires>.<mac>". */
export function issueStreamToken(secret, { callSid, businessId, locationId, routedBy, from }, now = Date.now()) {
    const expires = now + STREAM_TOKEN_TTL_MS;
    return `${expires}.${streamMac(secret, { callSid, businessId, locationId, routedBy, from, expires })}`;
}

/** Checks a stream token against the call SID Twilio reports and the stream's parameters. */
export function verifyStreamToken(secret, token, { callSid, businessId, locationId, routedBy, from }, now = Date.now()) {
    if (!secret || !token || !callSid) return { ok: false, reason: 'missing' };
    const [expiresText, mac] = String(token).split('.');
    const expires = Number(expiresText);
    if (!Number.isFinite(expires) || !mac) return { ok: false, reason: 'malformed' };
    if (now > expires) return { ok: false, reason: 'expired' };
    const expected = streamMac(secret, { callSid, businessId, locationId, routedBy, from, expires });
    return safeEqual(mac, expected) ? { ok: true } : { ok: false, reason: 'bad_signature' };
}
