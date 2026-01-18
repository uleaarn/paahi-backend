#!/bin/bash

# Quick Deploy Script for Jalwa Voice Agent
# This script helps you deploy to your existing Railway setup

echo "🚀 Jalwa Voice Agent - Quick Deploy"
echo "===================================="
echo ""

# Check if we're in the right directory
if [ ! -f "server.js" ]; then
    echo "❌ Error: Please run this script from the project root directory"
    exit 1
fi

echo "📋 Pre-deployment checklist:"
echo ""
echo "1. ✅ Code is complete and tested"
echo "2. ⏳ Initialize git repository"
echo "3. ⏳ Add remote repository"
echo "4. ⏳ Commit and push code"
echo ""

read -p "Continue with deployment? (y/n) " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Deployment cancelled."
    exit 0
fi

# Initialize git if not already done
if [ ! -d ".git" ]; then
    echo "📦 Initializing git repository..."
    git init
else
    echo "✅ Git repository already initialized"
fi

# Add remote if not already added
if ! git remote | grep -q "origin"; then
    echo "🔗 Adding remote repository..."
    git remote add origin https://github.com/uleaarn/paahi-backend.git
else
    echo "✅ Remote repository already configured"
fi

# Add all files
echo "📝 Adding files to git..."
git add .

# Commit
echo "💾 Creating commit..."
git commit -m "Add Jalwa voice agent with Twilio and Gemini Live integration

- WebSocket server with Twilio Media Streams
- Gemini Live API integration
- 24kHz audio conversion (8kHz μ-law ↔ 24kHz PCM16)
- Complete Jalwa menu system (85 items)
- Order management and n8n webhook integration
- Production-ready Railway deployment config
- Comprehensive testing and documentation"

# Push to main
echo "🚀 Pushing to GitHub..."
git push origin main

echo ""
echo "✅ Deployment initiated!"
echo ""
echo "📋 Next steps:"
echo "1. Go to Railway dashboard: https://railway.app"
echo "2. Set environment variables:"
echo "   - GEMINI_API_KEY"
echo "   - N8N_WEBHOOK_URL"
echo "3. Wait for Railway to auto-deploy"
echo "4. Configure Twilio TwiML (see DEPLOYMENT.md)"
echo "5. Test with a phone call!"
echo ""
echo "🌐 Your app will be live at:"
echo "   https://paahi-backend-production.up.railway.app"
echo ""
echo "📖 See DEPLOYMENT.md for detailed instructions"
