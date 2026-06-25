# Deployment

This project is ready for Railway, Render, Fly.io, or any Node.js host that supports WebSockets.

## Required Environment Variables

- `OPENAI_API_KEY`
- `LLM_BASE_URL`
- `LLM_MODEL`
- `DEEPGRAM_API_KEY`
- `GOOGLE_APPLICATION_CREDENTIALS_JSON`

## Recommended Restaurant Variables

- `RESTAURANT_NAME`
- `RESTAURANT_LOCATION`
- `RESTAURANT_PHONE`
- `INITIAL_GREETING`

## Optional Integrations

- `N8N_WEBHOOK_URL` for completed order submission
- `EMAIL_USER`, `EMAIL_PASS`, `EMAIL_TO` for restaurant email alerts
- `ANALYTICS_LOG_DIR`, `ANALYTICS_RETENTION_DAYS` for local call logs

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
