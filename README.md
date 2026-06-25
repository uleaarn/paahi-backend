# Paahi Restaurant Voice Agent

A production-oriented phone ordering agent for restaurants. It answers inbound Twilio calls, transcribes caller audio with Deepgram, uses a configurable OpenAI-compatible chat model to take orders against your menu, speaks back with Google Cloud Text-to-Speech, and can submit completed orders to n8n plus email the restaurant.

## What It Includes

- Twilio Media Streams WebSocket endpoint for live phone calls
- Deepgram real-time speech-to-text
- Configurable LLM provider through the OpenAI SDK (`LLM_BASE_URL`, `LLM_MODEL`)
- Google Cloud TTS returning clean 8 kHz LINEAR16 audio for Twilio playback
- Menu-aware ordering using `data/menu.json`
- Fuzzy menu matching in `menu-matcher.js`
- Optional n8n order webhook
- Optional Gmail/SMTP order notification through Nodemailer
- Local call analytics in `logs/`

## Project Structure

```text
.
├── server.js
├── data/menu.json
├── prompts/system-instructions.md
├── menu-matcher.js
├── email-service.js
├── analytics.js
├── test-audio.js
├── test-menu-matcher.js
├── test-email.js
├── test-analytics.js
├── .env.example
└── railway.json
```

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create your local environment file:

```bash
cp .env.example .env
```

3. Fill in the required values:

```env
OPENAI_API_KEY=your_llm_api_key_here
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-chat
DEEPGRAM_API_KEY=your_deepgram_api_key_here
GOOGLE_APPLICATION_CREDENTIALS_JSON={"type":"service_account","project_id":"..."}
RESTAURANT_NAME=Your Restaurant
RESTAURANT_LOCATION=123 Main St, Your City, ST
RESTAURANT_PHONE=(555) 123-4567
```

4. Add your real menu in `data/menu.json`.

5. Tune the call behavior in `prompts/system-instructions.md`.

## Run Locally

```bash
npm run dev
```

Health check:

```bash
curl http://localhost:3000/health
```

For local Twilio testing, expose the server with ngrok:

```bash
ngrok http 3000
```

Set your Twilio phone number voice webhook to:

```text
https://YOUR_NGROK_DOMAIN/twiml
```

The server returns TwiML that connects the call to:

```text
wss://YOUR_DOMAIN/media-stream
```

## Tests

```bash
npm test
npm run test:menu
npm run test:analytics
npm run test:email
```

`test:email` requires email env vars if you want it to send a real message.

## Order Flow

1. Caller phones your Twilio number.
2. Twilio requests `POST /twiml`.
3. Twilio opens `WS /media-stream`.
4. Caller audio streams to Deepgram.
5. Final transcripts go to the configured chat model with your menu and system prompt.
6. The response is synthesized with Google Cloud TTS.
7. Audio is converted to Twilio-compatible mu-law frames.
8. Completed orders can be sent to n8n and emailed to the restaurant.

## Deployment

Railway is already configured through `railway.json`.

Set these environment variables in Railway:

- `OPENAI_API_KEY`
- `LLM_BASE_URL`
- `LLM_MODEL`
- `DEEPGRAM_API_KEY`
- `GOOGLE_APPLICATION_CREDENTIALS_JSON`
- `RESTAURANT_NAME`
- `RESTAURANT_LOCATION`
- `RESTAURANT_PHONE`
- `N8N_WEBHOOK_URL` if you want order submission
- `EMAIL_USER`, `EMAIL_PASS`, `EMAIL_TO` if you want email notifications

After deployment, configure Twilio's inbound voice webhook to:

```text
https://YOUR_RAILWAY_DOMAIN/twiml
```

## Customize For Your Restaurant

- Replace `data/menu.json` with your menu, prices, hours, modifiers, and dietary flags.
- Update `prompts/system-instructions.md` with your service style, pickup/delivery rules, upsells, and escalation rules.
- Set `INITIAL_GREETING` if you want a custom first sentence.
- Set `GOOGLE_TTS_VOICE` to change the speaking voice.
