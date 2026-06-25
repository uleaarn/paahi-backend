#!/bin/bash
set -e

echo "Restaurant Voice Agent - Deployment Checklist"
echo "============================================="
echo ""

if [ ! -f "server.js" ]; then
    echo "Error: run this script from the project root."
    exit 1
fi

echo "1. Run tests"
echo "   npm test"
echo "   npm run test:menu"
echo ""
echo "2. Commit and push to your own repository"
echo "   git add ."
echo "   git commit -m \"Build restaurant voice agent\""
echo "   git push origin main"
echo ""
echo "3. Set hosting environment variables"
echo "   OPENAI_API_KEY"
echo "   LLM_BASE_URL"
echo "   LLM_MODEL"
echo "   DEEPGRAM_API_KEY"
echo "   GOOGLE_APPLICATION_CREDENTIALS_JSON"
echo "   RESTAURANT_NAME"
echo "   RESTAURANT_LOCATION"
echo "   RESTAURANT_PHONE"
echo ""
echo "4. Configure Twilio inbound voice webhook"
echo "   POST https://YOUR_PUBLIC_DOMAIN/twiml"
echo ""
echo "See DEPLOYMENT.md for details."
