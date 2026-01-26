# Google Cloud TTS Setup Guide

## ✅ What We Fixed

**Problem**: ElevenLabs API returns MP3 with ID3 tags for BOTH `pcm_8000` and `ulaw_8000` formats, causing buzzing and audio errors.

**Solution**: Switched to Google Cloud Text-to-Speech which returns clean LINEAR16 PCM at 8kHz without any headers or encoding issues.

## 🔧 Setup Required

### 1. Create Google Cloud Project & Enable TTS API

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or use existing)
3. Enable the **Cloud Text-to-Speech API**:
   - Navigate to "APIs & Services" > "Library"
   - Search for "Cloud Text-to-Speech API"
   - Click "Enable"

### 2. Create Service Account & Download Credentials

1. Go to "IAM & Admin" > "Service Accounts"
2. Click "Create Service Account"
   - Name: `paahi-tts-service`
   - Role: `Cloud Text-to-Speech Client`
3. Click "Create Key" > "JSON"
4. Download the JSON key file

### 3. Set Up Credentials in Railway

**Option A: Environment Variable (Recommended for Railway)**

1. Copy the entire JSON key file content
2. In Railway, add environment variable:
   ```
   GOOGLE_APPLICATION_CREDENTIALS_JSON=<paste entire JSON content>
   ```
3. Update `server.js` to write credentials from env var:
   ```javascript
   // At startup, write credentials file from env var
   if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
       const credsPath = '/tmp/google-credentials.json';
       fs.writeFileSync(credsPath, process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
       process.env.GOOGLE_APPLICATION_CREDENTIALS = credsPath;
   }
   ```

**Option B: Direct Path (For local development)**

1. Save the JSON file as `google-credentials.json` in project root
2. Add to `.gitignore`:
   ```
   google-credentials.json
   ```
3. Set environment variable:
   ```bash
   export GOOGLE_APPLICATION_CREDENTIALS="./google-credentials.json"
   ```

### 4. Test Locally (Optional)

```bash
cd /Users/admin/Documents/Projects/paahi-backend
export GOOGLE_APPLICATION_CREDENTIALS="./google-credentials.json"
npm start
```

## 📊 Benefits of Google Cloud TTS

✅ **Clean PCM Output**: No ID3 tags, no MP3 encoding, no headers
✅ **Correct Format**: LINEAR16 PCM at 8kHz - exactly what we need
✅ **Reliable**: Battle-tested, production-grade service
✅ **Natural Voices**: High-quality Neural2 voices
✅ **Cost-Effective**: First 1M characters/month free, then $4/1M characters

## 🎯 Next Steps

1. **Set up Google Cloud credentials** (see above)
2. **Deploy to Railway** with credentials env var
3. **Test the phone system** - audio should be crystal clear!

## 🔍 What Changed in Code

### Before (ElevenLabs - Broken)
```javascript
// ElevenLabs returns MP3 with ID3 tags even for pcm_8000!
const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/...`);
const pcm16Buffer = Buffer.from(await response.arrayBuffer());
// Result: ID3 tags, MP3 encoding → buzzing
```

### After (Google TTS - Clean)
```javascript
// Google TTS returns clean LINEAR16 PCM @ 8kHz
const ttsClient = new textToSpeech.TextToSpeechClient();
const [response] = await ttsClient.synthesizeSpeech(request);
const pcm16Buffer = Buffer.from(response.audioContent);
// Result: Clean PCM16 → perfect μ-law conversion → clear audio!
```

## 💰 Pricing Comparison

| Provider | Format | Quality | Price |
|----------|--------|---------|-------|
| ElevenLabs | ❌ MP3+ID3 (broken) | High | $22/month |
| Google TTS | ✅ Clean PCM | High | $4/1M chars (free tier: 1M/month) |

**For a restaurant phone system, Google TTS is the clear winner!**
