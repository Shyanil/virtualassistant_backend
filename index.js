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
app.use(express.json({ limit: '50mb' }));
app.use(morgan('dev'));

// ─── API Key Auth Middleware ─────────────────────────────────
const validateApiKey = (req, res, next) => {
  const configuredKey = process.env.BACKEND_API_KEY;
  // Only enforce if the key is configured (skip check in dev when key not set)
  if (!configuredKey) return next();
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== configuredKey) {
    return res.status(401).json({ error: 'Unauthorized: Invalid or missing API key.' });
  }
  next();
};

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
app.post('/api/transcribe', validateApiKey, async (req, res) => {
  try {
    const { audioContent } = req.body;
    if (!audioContent) return res.status(400).json({ error: 'Missing audio content' });

    console.log('🎙️ [Voice] Transcribing audio with Gemini 1.5 Flash...');
    
    // Using Gemini 1.5 Flash for transcription — it is extremely robust with audio formats
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [{ 
          parts: [
            { text: "Transcribe this audio file exactly as spoken. Just return the transcription text, nothing else. If you hear nothing, return an empty string." },
            { inlineData: { mimeType: "audio/wav", data: audioContent } }
          ] 
        }],
        generationConfig: {
          temperature: 0.1,
          topP: 0.95,
          topK: 64,
          maxOutputTokens: 1024,
        }
      }
    );

    const transcript = response.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    
    console.log('✅ [Voice] Transcript:', transcript || '[No speech detected]');
    res.json({ transcript });
  } catch (error) {
    console.error('❌ [Voice] Transcription Error:', error.response?.data?.error?.message || error.message);
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
app.post('/api/analyze', validateApiKey, async (req, res) => {
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

    // Execute Actions (e.g. Google Calendar)
    const { googleAccessToken } = req.body;
    let actionResult = null;

    if (intent.action === 'create_event' && intent.date && intent.time && googleAccessToken) {
      console.log('📅 [Action] Scheduling Google Meet event...');
      try {
        const startTime = new Date(`${intent.date}T${intent.time}:00`);
        const endTime = new Date(startTime.getTime() + 60 * 60 * 1000); // Default 1 hour duration
        
        const eventBody = {
          summary: intent.title,
          description: intent.notes || 'Created by AI Assistant',
          start: { dateTime: startTime.toISOString(), timeZone: 'UTC' },
          end: { dateTime: endTime.toISOString(), timeZone: 'UTC' },
          conferenceData: {
            createRequest: { requestId: `meet-${Date.now()}`, conferenceSolutionKey: { type: "hangoutsMeet" } } // Auto create Meet link
          }
        };

        const calRes = await axios.post(
          'https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1',
          eventBody,
          { headers: { Authorization: `Bearer ${googleAccessToken}` } }
        );

        console.log('✅ [Action] Event Created:', calRes.data.htmlLink);
        actionResult = 'Event Scheduled Successfully';
        intent.meetLink = calRes.data.hangoutLink;
      } catch (calError) {
        console.error('❌ [Action] Google Calendar Error:', calError.response?.data || calError.message);
        actionResult = 'Failed to Schedule Event';
      }
    }

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
        status: actionResult === 'Failed to Schedule Event' ? 'error' : 'done',
      });
    }

    res.json(intent);
  } catch (error) {
    console.error('❌ [AI] Analysis Error:', error.response?.data?.error?.message || error.message);
    res.status(500).json({ error: 'Analysis failed' });
  }
});


const multer = require('multer');
const upload = multer({ 
  storage: multer.memoryStorage(), 
  limits: { fileSize: 50 * 1024 * 1024 } // 50 MB limit
});

/**
 * 📄 Analyze Document (Gemini 2.5 Pro Vision)
 * Receives: multipart/form-data with 'document' file and 'userId'
 */
app.post('/api/analyze-document', validateApiKey, upload.single('document'), async (req, res) => {
  try {
    const file = req.file;
    const { userId } = req.body;

    if (!file) return res.status(400).json({ error: 'No document uploaded' });

    console.log(`📄 [Document] Analyzing ${file.originalname} (${file.mimetype}) ...`);
    const mimeType = file.mimetype;
    const base64Data = file.buffer.toString('base64');

    const prompt = `Analyze this document carefully.

First, extract any important dates, deadlines, meetings, events, or appointments mentioned.

Then return your response as VALID JSON in exactly this format (no markdown, no extra text):
{
  "summary": "2-3 sentence plain-text summary of the document",
  "events": [
    {
      "title": "Short event title",
      "date": "YYYY-MM-DD",
      "time": "HH:MM or null if not found",
      "description": "Brief description of this event or deadline"
    }
  ]
}

If no specific dates are found, return an empty events array. Only return valid JSON.`;

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [{ 
          parts: [
            { text: prompt },
            { inlineData: { mimeType: mimeType, data: base64Data } }
          ] 
        }],
        generationConfig: { temperature: 0.1 },
      }
    );

    const raw = response.data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';

    // Robust JSON extraction — strip markdown fences if present
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const cleaned = jsonMatch ? jsonMatch[0] : '{}';

    let parsed = { summary: 'Could not parse document.', events: [] };
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.warn('⚠️ [Document] JSON parse failed, returning raw text');
      parsed.summary = raw.substring(0, 500);
    }

    console.log(`✅ [Document] Analysis Complete — ${parsed.events?.length || 0} events found`);


    // Auto-save to Supabase if we have a userId
    if (userId) {
      console.log('💾 [DB] Saving Document Log to Supabase for user:', userId);
      await supabase.from('voice_logs').insert({
        user_id: userId,
        transcript: 'Uploaded Document: ' + file.originalname,
        action: 'document_analysis',
        title: 'Document Analysis',
        notes: parsed.summary,
        status: 'done',
      });
    }

    res.json({ summary: parsed.summary, events: parsed.events || [] });

  } catch (error) {
    console.error('❌ [Document] Analysis Error:', error.response?.data?.error?.message || error.message);
    res.status(500).json({ error: 'Document analysis failed' });
  }
});


app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 AI Backend running at http://0.0.0.0:${PORT}`);
});
