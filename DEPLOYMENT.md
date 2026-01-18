# Deployment Guide for Railway

Your Jalwa Voice Agent is ready to deploy to your existing Railway setup!

## 🚀 Quick Deployment Steps

### 1. Push to GitHub

```bash
cd "/Users/admin/paahi voice agent"

# Initialize git (if not already done)
git init

# Add remote (your existing repo)
git remote add origin https://github.com/uleaarn/paahi-backend.git

# Add all files
git add .

# Commit
git commit -m "Add Jalwa voice agent with Twilio and Gemini integration"

# Push to main branch
git push origin main
```

### 2. Configure Railway Environment Variables

Go to your Railway project dashboard at: https://railway.app/project/paahi-backend-production

Add these environment variables:

**Required:**
- `GEMINI_API_KEY` - Your Gemini API key from https://aistudio.google.com/app/apikey
- `N8N_WEBHOOK_URL` - Your n8n webhook endpoint for order submission

**Optional:**
- `PORT` - Railway sets this automatically, but you can override if needed

### 3. Railway Will Auto-Deploy

Once you push to GitHub, Railway will automatically:
- ✅ Detect the changes
- ✅ Install dependencies (`npm install`)
- ✅ Start the server (`node server.js`)
- ✅ Make it available at: `https://paahi-backend-production.up.railway.app`

### 4. Configure Twilio

Once deployed, configure your Twilio phone number:

**WebSocket URL:**
```
wss://paahi-backend-production.up.railway.app/media-stream
```

**TwiML Configuration:**
```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://paahi-backend-production.up.railway.app/media-stream" />
  </Connect>
</Response>
```

**Steps:**
1. Go to [Twilio Console](https://console.twilio.com/)
2. Navigate to Phone Numbers → Manage → Active Numbers
3. Select your phone number
4. Under "Voice Configuration":
   - When a call comes in: **TwiML Bin**
   - Create new TwiML Bin with the XML above
5. Save

### 5. Test the System

**Health Check:**
```bash
curl https://paahi-backend-production.up.railway.app/health
```

Expected response:
```json
{"status":"ok","service":"Jalwa Voice Agent"}
```

**Test Call:**
1. Call your Twilio phone number
2. You should hear the AI greeting
3. Try ordering: "I'd like Chicken Tikka Masala"
4. Verify the conversation flow

---

## 📋 Pre-Deployment Checklist

- [ ] Create `.env` file locally with your API keys (for local testing)
- [ ] Test locally with `npm start`
- [ ] Push code to GitHub
- [ ] Set environment variables in Railway dashboard
- [ ] Wait for Railway auto-deployment
- [ ] Configure Twilio TwiML
- [ ] Test with a phone call

---

## 🔧 Local Testing (Optional)

Before deploying, you can test locally:

### 1. Create `.env` file

```bash
cp .env.example .env
```

Edit `.env` and add your keys:
```env
GEMINI_API_KEY=your_actual_gemini_api_key
N8N_WEBHOOK_URL=your_actual_n8n_webhook_url
PORT=3000
```

### 2. Start the server

```bash
npm start
```

### 3. Expose with ngrok

```bash
# Install ngrok if you haven't
brew install ngrok

# Expose port 3000
ngrok http 3000
```

Use the ngrok HTTPS URL for Twilio testing.

---

## 📊 Monitoring

### Railway Logs

View real-time logs:
```bash
railway logs
```

Or in the Railway dashboard: Project → Deployments → View Logs

### What to Monitor

- ✅ Server startup message
- ✅ Twilio connection events
- ✅ Gemini API connection
- ✅ Order submissions to n8n
- ❌ Any error messages

---

## 🐛 Troubleshooting

### Server won't start
- Check Railway logs for errors
- Verify `GEMINI_API_KEY` is set correctly
- Ensure `package.json` has correct dependencies

### Twilio connection fails
- Verify WebSocket URL is correct (wss://)
- Check Railway deployment is running
- Review Twilio debugger logs

### No audio or garbled audio
- Audio conversion is tested and working ✅
- Check Twilio Media Streams configuration
- Verify WebSocket connection in logs

### Orders not submitting
- Verify `N8N_WEBHOOK_URL` is correct
- Test webhook manually with curl
- Check n8n workflow is active

---

## 📞 Support

**Your Deployment:**
- Railway: https://paahi-backend-production.up.railway.app
- GitHub: https://github.com/uleaarn/paahi-backend
- Health Check: https://paahi-backend-production.up.railway.app/health

**Resources:**
- [Twilio Media Streams Docs](https://www.twilio.com/docs/voice/media-streams)
- [Gemini API Docs](https://ai.google.dev/docs)
- [Railway Docs](https://docs.railway.app/)

---

## ✅ Next Steps

1. **Push to GitHub** - Deploy your code
2. **Set Railway env vars** - Add API keys
3. **Configure Twilio** - Set up TwiML
4. **Test with a call** - Verify everything works
5. **Monitor logs** - Watch for any issues

Your voice agent is production-ready! 🎉
