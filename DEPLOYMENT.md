# Deployment

This project is ready for Railway, Render, Fly.io, or any Node.js host that supports WebSockets.

## Required Environment Variables

- `OPENAI_API_KEY`
- `LLM_BASE_URL`
- `LLM_MODEL`
- `DEEPGRAM_API_KEY`
- `GOOGLE_APPLICATION_CREDENTIALS_JSON`: optional. Only needed for Spanish, French, Hindi or Telugu, or as a backup English voice. English uses Deepgram.
- `DATABASE_URL`: Supabase Postgres as the `paahi_app` role (see `docs/DATABASE.md`). Optionally `DATABASE_CA_CERT`.
- `TWILIO_AUTH_TOKEN`: the Twilio account auth token. The server won't start without it. It checks the signature on every `/twiml` request and signs the token each media stream must carry. Use the token of the account that owns the phone numbers.
- `PUBLIC_BASE_URL`: optional. Only if Twilio calls an address the app can't see (for example a custom domain behind a proxy that rewrites the Host header).

## Routing and Business Settings

- Business settings (name, hours, menu, languages, numbers) live in `businesses/<id>/business.json`. See `docs/BUSINESSES.md`.
- `DEFAULT_BUSINESS_ID`: send calls to numbers not listed in any business.json to this business (single-business deployments).

## Notifications

- `RESEND_API_KEY` (recommended): staff emails go through Resend's HTTPS API. Railway's Hobby plan blocks outgoing SMTP, so Gmail sending times out there. Optional `RESEND_FROM` (an address on a domain verified in Resend); without one, mail comes from `onboarding@resend.dev` and Resend only delivers to the account owner's address, so `EMAIL_TO` must be that address until a domain is verified.
- `EMAIL_USER`, `EMAIL_PASS`: Gmail sending account (app password). Used only when `RESEND_API_KEY` isn't set, on hosts that allow SMTP.
- One recipient variable per business, named in its business.json (`email_to_env`). For Jalwa that is `EMAIL_TO`.
- Optional webhook per business (`webhook_url_env`). Jalwa doesn't use one.

## Other

- `ADMIN_API_TOKEN` protects `/analytics/*`. Unset means those endpoints are off.
- `DEEPGRAM_MODEL` (default `nova-3`), `LLM_TIMEOUT_MS`.
- `ANALYTICS_LOG_DIR`, `ANALYTICS_RETENTION_DAYS` for local call and order logs. On Railway, attach a volume, or these logs are lost on redeploy.

## Railway

1. Create a Railway service from this repository.
2. Set the environment variables above.
3. Railway will run `npm start`.
4. Open `/health` on your public domain to verify the app is running.

## Twilio

Configure your Twilio phone number's inbound voice webhook:

```text
POST https://YOUR_PUBLIC_DOMAIN/twiml
```

The app returns TwiML that connects Twilio Media Streams to:

```text
wss://YOUR_PUBLIC_DOMAIN/media-stream
```

Requests without a valid Twilio signature get `403`, and a media stream without the token from `/twiml` is closed. The webhook URL in Twilio must match the public address exactly (scheme, host, path), because Twilio signs that URL. If calls start failing with `/twiml rejected` in the logs, compare the address in that log line with the webhook URL in the Twilio console.

## Local Production Test

```bash
npm start
```

Set `TWILIO_AUTH_TOKEN` as in production. Signatures work through ngrok because it forwards the public host.

Expose it for Twilio:

```bash
ngrok http 3000
```

Then configure Twilio to call:

```text
POST https://YOUR_NGROK_DOMAIN/twiml
```
