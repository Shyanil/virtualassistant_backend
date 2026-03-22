require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const morgan = require('morgan');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Allow large audio base64 uploads
app.use(morgan('dev')); // Log all requests

// Supabase Init
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ─── Endpoints ──────────────────────────────────────────────

const path = require('path');

// Health Check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

/**
 * 🎙️ Transcribe Audio
 * Receives: { audioContent: 'base64...' }
 */
app.post('/api/transcribe', async (req, res) => {
  try {
    const { audioContent } = req.body;
    if (!audioContent) return res.status(400).json({ error: 'Missing audio content' });

    console.log('🎙️ [Voice] Transcribing audio...');
    const response = await axios.post(
      `https://speech.googleapis.com/v1/speech:recognize?key=${process.env.GOOGLE_SPEECH_API_KEY}`,
      {
        config: {
          // Remove hardcoded encoding/rate to allow auto-detection from webm header
          languageCode: 'en-US',
          enableAutomaticPunctuation: true,
        },
        audio: { content: audioContent },
      }
    );

    const transcript = response.data.results?.[0]?.alternatives?.[0]?.transcript;
    console.log('✅ [Voice] Transcript:', transcript || '[No speech detected]');
    res.json({ transcript });
  } catch (error) {
    console.error('❌ [Voice] Transcription Error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Transcription failed' });
  }
});

/**
 * 🤖 Model Selection Logic (Tiered Inference)
 */
function selectModel(text) {
  const estimatedTokens = Math.ceil(text.length / 4); // ~4 chars per token
  
  if (estimatedTokens < 500) {
    return "gemini-2.5-flash-lite"; // Fast + cheap for small text
  } else if (estimatedTokens < 5000) {
    return "gemini-2.5-flash";       // Balanced for medium text
  } else {
    return "gemini-2.5-pro";         // Powerful for large text
  }
}

/**
 * 🧠 Analyze Intent (Gemini)
 * Receives: { transcript: '...', userId: '...' }
 */
app.post('/api/analyze', async (req, res) => {
  try {
    const { transcript, userId } = req.body;
    if (!transcript) return res.status(400).json({ error: 'Missing transcript' });

    const model = selectModel(transcript);
    console.log(`🧠 [AI] Analyzing intent using ${model} for:`, transcript);
    
    const today = new Date().toISOString().split('T')[0];
    const prompt = `Today is ${today}. User said: "${transcript}". 
Extract intent. Return ONLY valid JSON:
{
  "action": "create_event" or "set_reminder" or "unknown",
  "title": "short title",
  "date": "YYYY-MM-DD",
  "time": "HH:MM",
  "notes": "context"
}`;

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 500 },
      }
    );

    const raw = response.data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    // Robust JSON extraction
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const cleaned = jsonMatch ? jsonMatch[0] : raw;
    
    let intent;
    try {
      intent = JSON.parse(cleaned);
    } catch (parseError) {
      console.warn('⚠️ [AI] JSON Parse failed:', parseError.message);
      intent = { action: 'unknown', notes: 'Failed to parse AI response' };
    }

    console.log('✅ [AI] Intent:', JSON.stringify(intent));

    // Auto-save to Supabase if we have a userId
    if (userId) {
      console.log('💾 [DB] Saving to Supabase for user:', userId);
      await supabase.from('voice_logs').insert({
        user_id: userId,
        transcript,
        action: intent.action,
        title: intent.title,
        date: intent.date,
        time: intent.time,
        notes: intent.notes,
        status: 'done',
      });
    }

    res.json(intent);
  } catch (error) {
    console.error('❌ [AI] Analysis Error:', error.response?.data?.error?.message || error.message);
    res.status(500).json({ error: 'Analysis failed' });
  }
});


app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 AI Backend running at http://0.0.0.0:${PORT}`);
});
