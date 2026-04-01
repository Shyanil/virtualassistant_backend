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

// ─── WhatsApp Integration (MSG91) ──────────────────────────────
async function sendWhatsAppConfirmation(phoneNumber, data) {
  const authKey = process.env.MSG91_AUTH_KEY;
  const integratedNumber = process.env.MSG91_WHATSAPP_NUMBER;
  const templateName = process.env.MSG91_TEMPLATE_NAME || 'meeting_confirmation';
  const headerImage = process.env.MSG91_CONFIRMATION_IMAGE;

  if (!authKey || !integratedNumber) {
    console.warn('⚠️ [WhatsApp] MSG91 credentials missing, skipping...');
    return;
  }

  // Clean phone number (strip symbols, ensure country code)
  let cleanPhone = phoneNumber.replace(/\D/g, '');
  if (cleanPhone.length === 10) cleanPhone = '91' + cleanPhone;

  console.log(`📱 [WhatsApp] Sending confirmation to ${cleanPhone}...`);

  const payload = {
    integrated_number: integratedNumber,
    content_type: "template",
    payload: {
      messaging_product: "whatsapp",
      type: "template",
      template: {
        name: templateName,
        language: { code: "en", policy: "deterministic" },
        to_and_components: [{
          to: [cleanPhone],
          components: {
            header_1: { type: "image", value: headerImage },
            body_1: { type: "text", value: data.userName || 'Member' },
            body_2: { type: "text", value: data.person || 'Team' },
            body_3: { type: "text", value: data.date || 'TBD' },
            body_4: { type: "text", value: data.time || 'TBD' },
            body_5: { type: "text", value: data.link || 'Join Link in App' }
          }
        }]
      }
    }
  };

  try {
    await axios.post('https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/', payload, {
      headers: { 'authkey': authKey, 'Content-Type': 'application/json' }
    });
    console.log('✅ [WhatsApp] Confirmation sent successfully');
  } catch (err) {
    console.error('❌ [WhatsApp] MSG91 Error:', err.response?.data || err.message);
  }
}

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
    const { audioContent, mimeType } = req.body;
    if (!audioContent) return res.status(400).json({ error: 'Missing audio content' });

    // Map MIME type → Google Speech-to-Text encoding config.
    // iOS records WAV (LINEAR16), Android records AMR-WB — both supported natively.
    let encoding = 'LINEAR16';
    let sampleRateHertz = 16000;

    if (mimeType === 'audio/amr-wb' || mimeType === 'audio/amr') {
      encoding = 'AMR_WB';
      sampleRateHertz = 16000;
    } else if (mimeType === 'audio/mp3' || mimeType === 'audio/mpeg') {
      encoding = 'MP3';
      sampleRateHertz = 16000;
    } else {
      // Default: audio/wav → LINEAR16
      encoding = 'LINEAR16';
      sampleRateHertz = 16000;
    }

    console.log(`🎙️ [Voice] Transcribing (${mimeType || 'audio/wav'} → ${encoding}) with Google Speech-to-Text...`);

    const response = await axios.post(
      `https://speech.googleapis.com/v1/speech:recognize?key=${process.env.GOOGLE_SPEECH_API_KEY}`,
      {
        config: {
          encoding,
          sampleRateHertz,
          languageCode: 'en-US',
          enableAutomaticPunctuation: true,
          model: 'default',
          useEnhanced: true,
        },
        audio: {
          content: audioContent,
        },
      }
    );

    // Join all result chunks into a single transcript string.
    const transcript = (response.data.results || [])
      .map(r => r.alternatives?.[0]?.transcript || '')
      .filter(Boolean)
      .join(' ')
      .trim();

    console.log('✅ [Voice] Transcript:', transcript || '[No speech detected]');
    res.json({ transcript });
  } catch (error) {
    const errMsg = error.response?.data?.error?.message || error.message;
    console.error('❌ [Voice] Transcription Error:', errMsg);
    res.status(500).json({ error: `Transcription failed: ${errMsg}` });
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

function parseJsonObject(rawText) {
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  const cleaned = jsonMatch ? jsonMatch[0] : rawText;
  return JSON.parse(cleaned);
}

function toCalendarDateTime(date, time) {
  return `${date.replace(/-/g, '')}T${String(time || '00:00').replace(':', '')}00`;
}

function buildGoogleCalendarUrl(intent, timeZone) {
  if (!intent.date || !intent.time) return null;

  const durationMinutes = Number(intent.durationMinutes) > 0 ? Number(intent.durationMinutes) : 60;
  const [hours, minutes] = String(intent.time).split(':').map(Number);
  const startDate = new Date(`${intent.date}T${String(intent.time)}:00`);
  const endDate = new Date(startDate.getTime() + durationMinutes * 60 * 1000);
  const endDateString = endDate.toISOString().slice(0, 10);
  const endTimeString = endDate.toISOString().slice(11, 16);

  intent.endDate = intent.endDate || endDateString;
  intent.endTime = intent.endTime || endTimeString;

  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: intent.title || 'New meeting',
    details: intent.notes || intent.formattedText || 'Created from voice note',
    dates: `${toCalendarDateTime(intent.date, intent.time)}/${toCalendarDateTime(intent.endDate, intent.endTime)}`,
  });

  if (timeZone) {
    params.set('ctz', timeZone);
  }

  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/**
 * 🧠 Analyze Intent (Gemini)
 * Receives: { transcript: '...', userId: '...' }
 */
app.post('/api/analyze', validateApiKey, async (req, res) => {
  try {
    const { transcript, userId, timeZone } = req.body;
    if (!transcript) return res.status(400).json({ error: 'Missing transcript' });

    const model = selectModel(transcript);
    console.log(`🧠 [AI] Analyzing intent using ${model} for:`, transcript);
    
    const today = new Date().toISOString().split('T')[0];
    const prompt = `Today is ${today}. User timezone is ${timeZone || 'UTC'}.
User said: "${transcript}".
Convert this into a clean calendar-ready structure.
Return ONLY valid JSON:
{
  "action": "create_event" or "set_reminder" or "unknown",
  "title": "short title",
  "date": "YYYY-MM-DD",
  "time": "HH:MM",
  "durationMinutes": 60,
  "notes": "short context for the calendar description",
  "formattedText": "clean, easy-to-understand summary with key details"
}`;

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 500 },
      }
    );

    const raw = response.data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    let intent;
    try {
      intent = parseJsonObject(raw);
    } catch (parseError) {
      console.warn('⚠️ [AI] JSON Parse failed:', parseError.message);
      intent = { action: 'unknown', notes: 'Failed to parse AI response' };
    }

    intent.formattedText = intent.formattedText || intent.notes || transcript;
    intent.durationMinutes = Number(intent.durationMinutes) > 0 ? Number(intent.durationMinutes) : 60;
    intent.timeZone = timeZone || 'UTC';
    intent.calendarUrl = buildGoogleCalendarUrl(intent, intent.timeZone);

    console.log('✅ [AI] Intent:', JSON.stringify(intent));

    // Auto-save to Supabase if we have a userId
    if (userId) {
      console.log('💾 [DB] Saving to Supabase for user:', userId);
      
      // Fetch user profile for WhatsApp number (Graceful handling if user not in users table yet)
      const { data: userData, error: profileError } = await supabase
        .from('users')
        .select('phone, full_name')
        .eq('firebase_uid', userId)
        .maybeSingle();

      if (profileError) {
        console.warn('⚠️ [DB] User profile fetch error:', profileError.message);
      }

      await supabase.from('voice_logs').insert({
        user_id: userId,
        transcript,
        action: intent.action,
        title: intent.title,
        date: intent.date,
        time: intent.time,
        notes: intent.notes,
        status: intent.action === 'unknown' ? 'pending' : 'done',
      });

      // Trigger WhatsApp if it's a meeting
      if (intent.action === 'create_event' && userData?.phone) {
        sendWhatsAppConfirmation(userData.phone, {
          userName: userData.full_name,
          person: intent.title?.split(' with ')?.[1] || 'Assistant',
          date: intent.date,
          time: intent.time,
          link: intent.calendarUrl
        });
      }
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
