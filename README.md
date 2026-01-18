# Jalwa Voice Agent 🎙️

Production-ready Twilio → Gemini Live voice agent for Jalwa: Modern Indian Dining restaurant.

## Features

- ✅ **Twilio Media Streams Integration**: WebSocket server for real-time voice calls
- ✅ **Gemini Live API**: Advanced conversational AI with natural voice
- ✅ **24kHz Audio Conversion**: Seamless 8kHz μ-law ↔ 24kHz PCM16 conversion
- ✅ **Complete Menu System**: 100+ items with categories, modifiers, and pricing
- ✅ **Order Management**: Intelligent order validation and tracking
- ✅ **n8n Webhook Integration**: Automated order submission
- ✅ **Railway Deployment Ready**: Production configuration included

## Project Structure

```
paahi-voice-agent/
├── server.js                    # Main WebSocket server
├── data/
│   └── menu.json               # Complete restaurant menu
├── prompts/
│   └── system-instructions.md  # Gemini AI system instructions
├── test-audio.js               # Audio conversion test suite
├── package.json                # Dependencies
├── .env.example                # Environment variables template
└── README.md                   # This file
```

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

Required variables:
- `GEMINI_API_KEY`: Get from [Google AI Studio](https://aistudio.google.com/app/apikey)
- `N8N_WEBHOOK_URL`: Your n8n webhook endpoint for order submission
- `PORT`: Server port (default: 3000)

### 3. Test Audio Conversion

```bash
npm test
```

This will verify:
- μ-law encoding/decoding
- Audio resampling (8kHz ↔ 24kHz)
- Full pipeline (Twilio → Gemini → Twilio)
- Menu data loading
- System instructions loading

### 4. Run the Server

```bash
npm start
```

For development with auto-reload:
```bash
npm run dev
```

## Twilio Configuration

### 1. Create a Twilio Phone Number

1. Go to [Twilio Console](https://console.twilio.com/)
2. Buy a phone number with Voice capabilities

### 2. Configure Media Streams

In your Twilio phone number settings:

**Voice & Fax → Configure:**
- When a call comes in: **Webhook**
- URL: `https://your-server.com/twiml`
- HTTP Method: `POST`

**TwiML Bin (create new):**
```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://your-server.com/media-stream" />
  </Connect>
</Response>
```

Replace `your-server.com` with your actual domain (Railway URL or ngrok for local testing).

## Local Development with ngrok

For local testing, use ngrok to expose your server:

```bash
# Install ngrok
brew install ngrok

# Start your server
npm run dev

# In another terminal, expose port 3000
ngrok http 3000
```

Use the ngrok HTTPS URL in your Twilio configuration.

## Railway Deployment

### 1. Create Railway Project

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Initialize project
railway init
```

### 2. Set Environment Variables

In Railway dashboard:
- Add `GEMINI_API_KEY`
- Add `N8N_WEBHOOK_URL`
- `PORT` is automatically set by Railway

### 3. Deploy

```bash
railway up
```

Your service will be available at: `https://your-project.railway.app`

## Audio Conversion Technical Details

### Twilio Format
- **Encoding**: μ-law (G.711)
- **Sample Rate**: 8kHz
- **Bit Depth**: 8-bit compressed
- **Channels**: Mono

### Gemini Format
- **Encoding**: PCM16 (Linear PCM)
- **Sample Rate**: 24kHz
- **Bit Depth**: 16-bit
- **Channels**: Mono

### Conversion Pipeline

**Twilio → Gemini:**
1. Receive base64-encoded μ-law from Twilio
2. Decode μ-law to PCM16 @ 8kHz
3. Resample PCM16 from 8kHz to 24kHz
4. Send to Gemini Live API

**Gemini → Twilio:**
1. Receive PCM16 @ 24kHz from Gemini
2. Resample PCM16 from 24kHz to 8kHz
3. Encode PCM16 to μ-law
4. Send base64-encoded μ-law to Twilio

## Menu System

The menu is structured with:
- **14 Categories**: Appetizers, Entrees, Breads, Rice, Desserts, Beverages
- **100+ Items**: Complete restaurant menu
- **Modifiers**: Spice levels, dietary restrictions, add-ons
- **Pricing**: Base prices + modifier costs
- **Dietary Tags**: Vegetarian, Vegan, Gluten-Free, Spicy, Popular

## Order Flow

1. **Customer calls** → Twilio receives call
2. **Twilio connects** → WebSocket to server
3. **Gemini greets** → AI starts conversation
4. **Customer orders** → AI processes menu requests
5. **Order validation** → Checks minimums, availability
6. **Order confirmation** → AI reads back order
7. **Submit to n8n** → Webhook receives order data
8. **Order processing** → Your n8n workflow handles fulfillment

## API Endpoints

- `GET /health` - Health check
- `WS /media-stream` - Twilio Media Streams WebSocket

## Troubleshooting

### Audio Issues
- Run `npm test` to verify audio conversion
- Check Twilio webhook logs
- Verify WebSocket connection in server logs

### Gemini Connection
- Verify `GEMINI_API_KEY` is correct
- Check API quota and billing
- Review server logs for connection errors

### Order Submission
- Verify `N8N_WEBHOOK_URL` is accessible
- Test webhook manually with curl
- Check n8n workflow activation

## Development

### Adding Menu Items

Edit `data/menu.json`:
```json
{
  "id": "new_item_001",
  "name": "New Dish",
  "description": "Description here",
  "base_price": 15.00,
  "sizes": [{ "name": "regular", "price": 15.00 }],
  "modifiers": ["extra_spicy", "mild"],
  "popular": false,
  "vegetarian": true,
  "vegan": false,
  "gluten_free": true
}
```

### Customizing AI Behavior

Edit `prompts/system-instructions.md` to change:
- Greeting style
- Recommendation strategy
- Order confirmation process
- Conversation flow

## License

MIT

## Support

For issues or questions:
- Check server logs: `railway logs`
- Review Twilio debugger
- Test audio conversion: `npm test`

---

Built with ❤️ for Jalwa: Modern Indian Dining
