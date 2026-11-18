# Deployment

This project is ready for Railway, Render, Fly.io, or any Node.js host that supports WebSockets.

## Required Environment Variables

- `OPENAI_API_KEY`
- `LLM_BASE_URL`
- `LLM_MODEL`
- `DEEPGRAM_API_KEY`
- `GOOGLE_APPLICATION_CREDENTIALS_JSON`: optional. Only needed for Spanish, French, Hindi or Telugu, or as a backup English voice. English uses Deepgram.
- `DATABASE_URL`: Supabase Postgres as the `paahi_app` role (see `docs/DATABASE.md`). Optionally `DATABASE_CA_CERT`.

## Routing and Business Settings

- Business settings (name, hours, menu, languages, numbers) live in `businesses/<id>/business.json`. See `docs/BUSINESSES.md`.
- `DEFAULT_BUSINESS_ID`: send calls to numbers not listed in any business.json to this business (single-business deployments).

## Notifications

- `EMAIL_USER`, `EMAIL_PASS`: the sending account (Gmail app password).
- One recipient variable per business, named in its business.json (`email_to_env`). For Jalwa that is `EMAIL_TO`.
- Optional webhook per business (`webhook_url_env`). For Jalwa that is `N8N_WEBHOOK_URL`. Not needed for calls or orders.

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

## Local Production Test

```bash
npm start
```

Expose it for Twilio:

```bash
ngrok http 3000
```

Then configure Twilio to call:

```text
POST https://YOUR_NGROK_DOMAIN/twiml
```
