# Virtual Assistant Backend

Node.js Express backend that handles AI processing for the Virtual Assistant mobile app.
It proxies requests to Google Cloud Speech-to-Text and Gemini 2.5 models, and securely logs actions to Supabase.

## Setup
1. `npm install`
2. Create a `.env` file with the necessary API keys (Google, Gemini, Supabase).
3. `npm start` (or `node index.js`)
