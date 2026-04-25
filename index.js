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
    // expo-av on iOS records m4a/mp4, expo-av on Android records 3gp/AAC
    let encoding = 'LINEAR16';
    let sampleRateHertz = 16000;

    if (mimeType === 'audio/amr-wb' || mimeType === 'audio/amr') {
      encoding = 'AMR_WB';
      sampleRateHertz = 16000;
    } else if (mimeType === 'audio/mp3' || mimeType === 'audio/mpeg') {
      encoding = 'MP3';
      sampleRateHertz = 16000;
    } else if (mimeType === 'audio/mp4' || mimeType === 'audio/m4a' || mimeType === 'audio/x-m4a') {
      // expo-av on iOS records in m4a (AAC inside mp4 container)
      // Google Speech-to-Text v1 doesn't support mp4 directly — use WEBM_OPUS or fall back to MP3
      // Best approach: use encoding=MP3 which accepts AAC as well in practice
      encoding = 'MP3';
      sampleRateHertz = 44100;
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
    console.log('✅ [Voice] Results:', JSON.stringify(response.data.results || []));
    const transcript = (response.data.results || [])
      .map(r => r.alternatives?.[0]?.transcript || '')
      .filter(Boolean)
      .join(' ')
      .trim();

    console.log('✅ [Voice] Final Transcript:', transcript || '[No speech detected]');
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
  const estimatedTokens = Math.ceil(text.length / 4);
  if (estimatedTokens < 5000) {
    return "gemini-2.0-flash";        // Fast + cheap for most requests
  } else {
    return "gemini-2.5-flash";        // More capable for long/complex requests
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
    console.log('🤖 [AI] Raw response from Gemini:', raw);
    
    let intent;
    try {
      intent = parseJsonObject(raw);
    } catch (parseError) {
      console.warn('⚠️ [AI] JSON Parse failed:', parseError.message);
      intent = { action: 'unknown', notes: `Failed to parse AI response: ${raw.substring(0, 100)}` };
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

      // ℹ️ WhatsApp confirmation is now sent ONLY after user confirms in the review screen
      //    via POST /api/whatsapp/confirm-meeting — not here during analysis.
    }

    res.json(intent);
  } catch (error) {
    console.error('❌ [AI] Analysis Error:', error.response?.data?.error?.message || error.message);
    res.status(500).json({ error: 'Analysis failed' });
  }
});

/**
 * 💬 Calendar-aware Chat (Gemini)
 * Receives: { message, userId, history, timeZone }
 */
app.post('/api/chat', validateApiKey, async (req, res) => {
  try {
    const { message, userId, history = [], timeZone } = req.body;
    if (!message) return res.status(400).json({ error: 'Missing message' });

    const requestedTimeZone = timeZone || 'UTC';
    const formatDateInZone = (date) => {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: requestedTimeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(date);
      const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
      return `${values.year}-${values.month}-${values.day}`;
    };

    const now = new Date();
    const rangeEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // Next 7 days
    const today = formatDateInZone(now);
    const end = formatDateInZone(rangeEnd);

    let contextEvents = [];
    if (userId) {
      const { data, error } = await supabase
        .from('voice_logs')
        .select('title, date, time, notes, transcript, action, status')
        .eq('user_id', userId)
        .not('date', 'is', null)
        .gte('date', today)
        .lte('date', end)
        .order('date', { ascending: true })
        .order('time', { ascending: true })
        .limit(20);

      if (error) {
        console.warn('⚠️ [Chat] Supabase context query failed:', error.message);
      } else {
        contextEvents = data || [];
      }
    }

    const scheduleText = contextEvents.length
      ? contextEvents.map((event, index) => {
          const when = [event.date, event.time].filter(Boolean).join(' ');
          return `${index + 1}. ${event.title || event.action || 'Untitled'} (${when || 'time unknown'}) - ${event.notes || event.transcript || 'No notes'}`;
        }).join('\n')
      : 'No upcoming events found in the next 7 days.';

    const recentHistory = Array.isArray(history)
      ? history.slice(-8).map(item => `${item.role === 'assistant' ? 'Assistant' : 'User'}: ${item.content}`).join('\n')
      : '';

    const prompt = `You are Adamsalve, the user's high-end personal calendar assistant.
Today is ${today}. User timezone: ${requestedTimeZone}.

USER SCHEDULE FOR THE NEXT 7 DAYS:
${scheduleText}

CONVERSATION HISTORY:
${recentHistory || 'First interaction.'}

USER REQUEST: "${message}"

INSTRUCTIONS:
1. Be professional, concierge-like, and helpful.
2. Focus ONLY on the user's calendar and schedule.
3. If they ask about "upcoming" things, summarize the next few events from the schedule provided above.
4. If they ask about something not in their calendar (like general knowledge or images), politely pivot back to how you can help with their schedule.
5. Keep responses concise but "top-notch" in quality.`;

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 800 },
      }
    );

    const reply = response.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || 'I could not generate a response.';

    res.json({
      reply,
      contextEvents: contextEvents.map(event => ({
        title: event.title,
        date: event.date,
        time: event.time,
        notes: event.notes,
      })),
    });
  } catch (error) {
    console.error('❌ [Chat] Error:', error.response?.data?.error?.message || error.message);
    res.status(500).json({ error: 'Chat failed' });
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
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
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


// ─── WhatsApp Helper: Send MSG91 Confirmation Template ──────────────
/**
 * Internal helper — calls the meeting_confirmation_notification MSG91 template.
 * Used by both the raw template endpoint and the centralized confirm endpoint.
 */
async function sendMeetingConfirmationWA({ to, name, date, time, person, meeting_link, header_image }) {
  const authKey    = process.env.MSG91_AUTH_KEY;
  const fromNumber = process.env.MSG91_WHATSAPP_NUMBER;
  const defaultImg = process.env.MSG91_CONFIRMATION_IMAGE;
  const headerImg  = header_image || defaultImg || '';

  const payload = {
    integrated_number: fromNumber,
    content_type: 'template',
    payload: {
      messaging_product: 'whatsapp',
      type: 'template',
      template: {
        name: 'meeting_confirmation_notification',
        language: { code: 'en', policy: 'deterministic' },
        namespace: 'cdb14b0d_8c1d_4c3c_afe5_e00265b36206',
        to_and_components: [{
          to,
          components: {
            header_1:          { type: 'image', value: headerImg },
            body_name:         { type: 'text', value: name,         parameter_name: 'name' },
            body_person:       { type: 'text', value: person,       parameter_name: 'person' },
            body_date:         { type: 'text', value: date,         parameter_name: 'date' },
            body_time:         { type: 'text', value: time,         parameter_name: 'time' },
            body_meeting_link: { type: 'text', value: meeting_link, parameter_name: 'meeting_link' },
          }
        }]
      }
    }
  };

  const response = await axios.post(
    'https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/',
    payload,
    { headers: { authkey: authKey, 'Content-Type': 'application/json' } }
  );
  return response.data;
}


// ─── WhatsApp Template: Meeting Confirmation (raw endpoint) ──────────
/**
 * 📲 Send Meeting Confirmation (meeting_confirmation_notification)
 *
 * Body (JSON):
 * {
 *   "to": ["91XXXXXXXXXX"],         // required — array of E.164 phone numbers (no +)
 *   "name": "John Doe",             // required
 *   "date": "5th April 2026",       // required
 *   "time": "10:00 AM",             // required
 *   "person": "Dr. Smith",          // required
 *   "meeting_link": "https://...",  // required
 *   "header_image": "https://..."   // optional — overrides MSG91_CONFIRMATION_IMAGE
 * }
 */
app.post('/api/whatsapp/meeting-confirmation', validateApiKey, async (req, res) => {
  try {
    const authKey    = process.env.MSG91_AUTH_KEY;
    const fromNumber = process.env.MSG91_WHATSAPP_NUMBER;
    if (!authKey || !fromNumber) {
      return res.status(500).json({ error: 'MSG91 credentials not configured in .env' });
    }

    const { to, name, date, time, person, meeting_link, header_image } = req.body;
    if (!to || !Array.isArray(to) || to.length === 0) {
      return res.status(400).json({ error: 'Missing or invalid "to" field — must be a non-empty array of phone numbers.' });
    }
    if (!name || !date || !time || !person || !meeting_link) {
      return res.status(400).json({ error: 'Missing required fields: name, date, time, person, meeting_link' });
    }

    console.log(`📲 [WhatsApp] Sending meeting-confirmation to ${to.join(', ')}...`);
    const result = await sendMeetingConfirmationWA({ to, name, date, time, person, meeting_link, header_image });
    console.log('✅ [WhatsApp] meeting-confirmation sent:', result);
    res.json({ success: true, msg91Response: result });

  } catch (err) {
    console.error('❌ [WhatsApp] meeting-confirmation error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});


// ─── WhatsApp Template: Meeting Invitation ───────────────────────────
/**
 * 📲 Send Meeting Invitation (meeting_invitation_notification)
 *
 * Body (JSON):
 * {
 *   "to": ["91XXXXXXXXXX"],
 *   "name": "John Doe",
 *   "date": "5th April 2026",
 *   "time": "10:00 AM",
 *   "person": "Dr. Smith",
 *   "meeting_link": "https://...",
 *   "header_image": "https://..."   // optional
 * }
 */
app.post('/api/whatsapp/meeting-invitation', validateApiKey, async (req, res) => {
  try {
    const authKey     = process.env.MSG91_AUTH_KEY;
    const fromNumber  = process.env.MSG91_WHATSAPP_NUMBER;
    const defaultImg  = process.env.MSG91_CONFIRMATION_IMAGE;

    if (!authKey || !fromNumber) {
      return res.status(500).json({ error: 'MSG91 credentials not configured in .env' });
    }

    const { to, name, date, time, person, meeting_link, header_image } = req.body;

    if (!to || !Array.isArray(to) || to.length === 0) {
      return res.status(400).json({ error: 'Missing or invalid "to" field — must be a non-empty array of phone numbers.' });
    }
    if (!name || !date || !time || !person || !meeting_link) {
      return res.status(400).json({ error: 'Missing required fields: name, date, time, person, meeting_link' });
    }

    const headerImg = header_image || defaultImg || '';

    const payload = {
      integrated_number: fromNumber,
      content_type: 'template',
      payload: {
        messaging_product: 'whatsapp',
        type: 'template',
        template: {
          name: 'meeting_invitation_notification',
          language: { code: 'en', policy: 'deterministic' },
          namespace: 'cdb14b0d_8c1d_4c3c_afe5_e00265b36206',
          to_and_components: [{
            to,
            components: {
              header_1:          { type: 'image', value: headerImg },
              body_date:         { type: 'text', value: date,         parameter_name: 'date' },
              body_meeting_link: { type: 'text', value: meeting_link, parameter_name: 'meeting_link' },
              body_person:       { type: 'text', value: person,       parameter_name: 'person' },
              body_name:         { type: 'text', value: name,         parameter_name: 'name' },
              body_time:         { type: 'text', value: time,         parameter_name: 'time' },
            }
          }]
        }
      }
    };

    console.log(`📲 [WhatsApp] Sending meeting-invitation to ${to.join(', ')}...`);

    const response = await axios.post(
      'https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/',
      payload,
      { headers: { authkey: authKey, 'Content-Type': 'application/json' } }
    );

    console.log('✅ [WhatsApp] meeting-invitation sent:', response.data);
    res.json({ success: true, msg91Response: response.data });

  } catch (err) {
    console.error('❌ [WhatsApp] meeting-invitation error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});


// ─── Confirm Meeting & Notify (Centralized Post-Confirmation Send) ─────
/**
 * 📲 POST /api/whatsapp/confirm-meeting
 *
 * Called by the app AFTER the user taps "Sync to Calendar" in the review screen.
 * Works for all input sources: voice, write-note, document upload.
 *
 * Body (JSON):
 * {
 *   "userId":       "firebase_uid",           // required — used to look up phone from Supabase
 *   "title":        "Meeting with Rahul",      // required
 *   "date":         "2026-04-07",              // required — YYYY-MM-DD
 *   "time":         "11:00",                   // required — HH:MM (24h)
 *   "person":       "Rahul",                   // optional — defaults to "Team"
 *   "meeting_link": "https://cal.google.com/…",// optional — calendar deeplink
 *   "source":       "voice" | "note" | "document" | "calendar" // optional — for logging
 * }
 *
 * Response:
 * {
 *   "sent": true/false,
 *   "reason": "ok" | "no_phone" | "already_sent" | "msg91_error" | "db_error"
 * }
 */
app.post('/api/whatsapp/confirm-meeting', validateApiKey, async (req, res) => {
  const { userId, title, date, time, person, meeting_link, source } = req.body;
  const logCtx = `[WhatsApp:confirm] source=${source || 'unknown'} userId=${userId}`;

  if (!userId || !title || !date || !time) {
    return res.status(400).json({
      sent: false,
      reason: 'missing_fields',
      error: 'Required: userId, title, date, time'
    });
  }

  try {
    // 1️⃣ Fetch user phone + name from Supabase
    const { data: userData, error: profileErr } = await supabase
      .from('users')
      .select('phone, full_name')
      .eq('firebase_uid', userId)
      .maybeSingle();

    if (profileErr) {
      console.error(`❌ ${logCtx} Supabase error:`, profileErr.message);
      return res.json({ sent: false, reason: 'db_error' });
    }

    if (!userData?.phone) {
      console.warn(`⚠️ ${logCtx} No phone number found — skipping WhatsApp`);
      return res.json({ sent: false, reason: 'no_phone' });
    }

    // 2️⃣ Duplicate check — look for recent voice_log with same title+date+time already sent
    const { data: existingLog } = await supabase
      .from('voice_logs')
      .select('id, whatsapp_sent')
      .eq('user_id', userId)
      .eq('title', title)
      .eq('date', date)
      .eq('time', time)
      .eq('whatsapp_sent', true)
      .maybeSingle();

    if (existingLog) {
      console.warn(`⚠️ ${logCtx} Duplicate: WhatsApp already sent for "${title}" on ${date} ${time}`);
      return res.json({ sent: false, reason: 'already_sent' });
    }

    // 3️⃣ Format fields for the WhatsApp template
    let cleanPhone = userData.phone.replace(/\D/g, '');
    if (cleanPhone.length === 10) cleanPhone = '91' + cleanPhone;

    // Format date: "2026-04-07" → "7th April 2026"
    const dateObj = new Date(date + 'T00:00:00');
    const day     = dateObj.getDate();
    const suffix  = ['th','st','nd','rd'][(day % 10 > 3 || Math.floor(day / 10) === 1) ? 0 : day % 10] || 'th';
    const months  = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const prettyDate = `${day}${suffix} ${months[dateObj.getMonth()]} ${dateObj.getFullYear()}`;

    // Format time: "11:00" → "11:00 AM"
    let prettyTime = time;
    if (/^\d{1,2}:\d{2}$/.test(time)) {
      const [h, m] = time.split(':').map(Number);
      const ampm   = h >= 12 ? 'PM' : 'AM';
      const hour   = h % 12 || 12;
      prettyTime   = `${hour}:${String(m).padStart(2, '0')} ${ampm}`;
    }

    const waName        = userData.full_name || 'Member';
    const waPerson      = person || 'Team';
    const waMeetingLink = meeting_link || 'See calendar invite';

    console.log(`📲 ${logCtx} Sending confirmation to +${cleanPhone} for "${title}" on ${prettyDate} ${prettyTime}`);

    // 4️⃣ Send WhatsApp
    let msg91Result;
    try {
      msg91Result = await sendMeetingConfirmationWA({
        to:           [cleanPhone],
        name:         waName,
        date:         prettyDate,
        time:         prettyTime,
        person:       waPerson,
        meeting_link: waMeetingLink,
      });
      console.log(`✅ ${logCtx} MSG91 success:`, msg91Result);
    } catch (msg91Err) {
      console.error(`❌ ${logCtx} MSG91 error:`, msg91Err.response?.data || msg91Err.message);
      return res.json({ sent: false, reason: 'msg91_error', error: msg91Err.response?.data || msg91Err.message });
    }

    // 5️⃣ Mark as sent in voice_logs (upsert — graceful if column doesn't exist)
    try {
      await supabase.from('voice_logs').insert({
        user_id:         userId,
        transcript:      `[${source || 'app'}] Confirmed: ${title}`,
        action:          'create_event',
        title,
        date,
        time,
        notes:           `WhatsApp confirmation sent to ${cleanPhone}`,
        status:          'done',
        whatsapp_sent:   true,
      });
    } catch (dbWriteErr) {
      // Non-fatal: log but don't fail the response
      console.warn(`⚠️ ${logCtx} Could not write whatsapp_sent flag:`, dbWriteErr.message);
    }

    return res.json({ sent: true, reason: 'ok', phone: `+${cleanPhone}` });

  } catch (err) {
    console.error(`❌ ${logCtx} Unexpected error:`, err.message);
    return res.status(500).json({ sent: false, reason: 'server_error', error: err.message });
  }
});


// ─────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 AI Backend running at http://0.0.0.0:${PORT}`);
});

