require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const morgan = require('morgan');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { google } = require('googleapis');

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

// Admin client for server-side operations bypassing RLS (e.g. gmail_accounts)
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
if (!supabaseServiceKey) {
  console.warn('⚠️ [Config] SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SERVICE_ROLE not found. supabaseAdmin will fall back to SUPABASE_ANON_KEY and RLS policies will block server-side inserts/updates.');
}
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  supabaseServiceKey || process.env.SUPABASE_ANON_KEY
);

const WHATSAPP_REMINDER_LEAD_MINUTES = 20;
const CALL_REMINDER_LEAD_MINUTES = 5;
const DEFAULT_TEST_USER_PHONE = process.env.DEFAULT_TEST_USER_PHONE || '918282831626';
const DEFAULT_TEST_ATTENDEE_PHONE = process.env.DEFAULT_TEST_ATTENDEE_PHONE || '919830753118';

function isSharedSecretValid(incomingSecret) {
  const expectedSecret = process.env.N8N_SHARED_SECRET;
  if (!expectedSecret || !incomingSecret) return false;

  const incoming = Buffer.from(String(incomingSecret));
  const expected = Buffer.from(String(expectedSecret));

  return incoming.length === expected.length && crypto.timingSafeEqual(incoming, expected);
}

function requireN8nSharedSecret(req, res, next) {
  if (!isSharedSecretValid(req.headers['x-shared-secret'])) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

function validateApiKeyOrN8nSecret(req, res, next) {
  const configuredKey = process.env.BACKEND_API_KEY;
  const apiKey = req.headers['x-api-key'];

  if (configuredKey && apiKey === configuredKey) return next();
  if (isSharedSecretValid(req.headers['x-shared-secret'])) return next();

  return res.status(401).json({ error: 'Unauthorized' });
}

function calculateReminderDate(meetingTime, leadMinutes) {
  const meetingDate = new Date(meetingTime);

  if (Number.isNaN(meetingDate.getTime())) {
    throw new Error('meeting_time must be a valid date/time');
  }

  return new Date(meetingDate.getTime() - leadMinutes * 60 * 1000);
}

function cleanPhoneNumber(phoneNumber) {
  if (!phoneNumber) return null;
  const cleanPhone = String(phoneNumber).replace(/\D/g, '');
  return cleanPhone || null;
}

async function sendWhatsAppReminderJobToN8n(payload) {
  const webhookUrl = process.env.N8N_WHATSAPP_WEBHOOK_URL;

  if (!webhookUrl) {
    throw new Error('N8N_WHATSAPP_WEBHOOK_URL is missing');
  }

  const response = await axios.post(webhookUrl, payload, {
    headers: {
      'Content-Type': 'application/json',
      'x-shared-secret': process.env.N8N_SHARED_SECRET || '',
    },
    timeout: 10000,
  });

  return response.data;
}

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
    return "gemini-2.5-flash";        // Fast + cheap for most requests
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

function formatDisplayDate(dateString) {
  if (!dateString) return 'TBD';
  const date = new Date(`${dateString}T00:00:00`);
  if (Number.isNaN(date.getTime())) return String(dateString);

  return date.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function formatDisplayTime(timeString) {
  if (!timeString) return 'TBD';
  const normalized = String(timeString).slice(0, 5);
  const match = normalized.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return String(timeString);

  const hour24 = Number(match[1]);
  const minute = match[2];
  const ampm = hour24 >= 12 ? 'PM' : 'AM';
  const hour = hour24 % 12 || 12;
  return `${hour}:${minute} ${ampm}`;
}

function extractAttendeeName(text) {
  if (!text) return null;

  const match = String(text).match(/\bwith\s+([A-Za-z][A-Za-z\s.'-]{1,60})/i);
  if (!match?.[1]) return null;

  return match[1]
    .replace(/\b(today|tomorrow|at|on|by|for)\b.*$/i, '')
    .trim() || null;
}

function getDateTimePartsInZone(date, timeZone = 'UTC') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));

  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`,
  };
}

function getTimeZoneOffsetMs(date, timeZone = 'UTC') {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const asUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second)
  );

  return asUtc - date.getTime();
}

function localDateTimeToUtc(dateString, timeString, timeZone = 'UTC') {
  if (!dateString || !timeString) {
    throw new Error('event_date and event_time are required');
  }

  const normalizedTime = String(timeString).slice(0, 5);
  const utcGuess = new Date(`${dateString}T${normalizedTime}:00.000Z`);

  if (Number.isNaN(utcGuess.getTime())) {
    throw new Error('event_date/event_time must be valid');
  }

  const offsetMs = getTimeZoneOffsetMs(utcGuess, timeZone);
  return new Date(utcGuess.getTime() - offsetMs);
}

async function saveVoiceLog({ userId, transcript, intent, source = 'analyze' }) {
  const effectiveUserId = userId || 'dev-expo-anonymous';

  const { data, error } = await supabase
    .from('voice_logs')
    .insert({
      user_id: effectiveUserId,
      transcript,
      action: intent.action,
      title: intent.title,
      date: intent.date,
      time: intent.time,
      notes: intent.notes || intent.formattedText || `[${source}]`,
      status: intent.action === 'unknown' ? 'pending' : 'done',
    })
    .select('id')
    .single();

  if (error) {
    throw error;
  }

  return {
    id: data?.id || null,
    userId: effectiveUserId,
    usedFallbackUserId: !userId,
  };
}

function buildReminderJobPayload({
  event,
  userPhone,
  attendeeName,
  attendeePhone,
  meetingDate,
  whatsappReminderDate,
}) {
  const recipientPhones = [userPhone, attendeePhone].filter(Boolean);

  return {
    event_id: event.id,
    event_title: event.event_title,
    meeting_time: meetingDate.toISOString(),
    event_date: event.event_date,
    event_time: String(event.event_time || '').slice(0, 5),
    timezone: event.timezone || 'Asia/Kolkata',
    user_phone: userPhone,
    attendee_name: attendeeName,
    attendee_phone: attendeePhone,
    recipient_phones: recipientPhones,
    customer_name: attendeeName,
    customer_phone: attendeePhone,
    whatsapp_reminder_at: whatsappReminderDate.toISOString(),
  };
}

async function saveExtractedEventFromIntent({ transcript, intent, userPhone, attendeePhone }) {
  if (!['create_event', 'set_reminder'].includes(intent.action) || !intent.title) {
    return { saved: false, id: null, skipped: true, error: null, n8nTriggered: false, n8nPayload: null };
  }

  const timezone = intent.timeZone || 'Asia/Kolkata';
  const eventDate = intent.date || null;
  const eventTime = intent.time || null;
  const attendeeName = extractAttendeeName(intent.title) || extractAttendeeName(transcript);
  let whatsappReminderDate = null;
  let callReminderDate = null;
  let whatsappStatus = 'pending';
  let callStatus = 'pending';
  let meetingDate = null;

  if (eventDate && eventTime) {
    meetingDate = localDateTimeToUtc(eventDate, eventTime, timezone);
    whatsappReminderDate = calculateReminderDate(meetingDate.toISOString(), WHATSAPP_REMINDER_LEAD_MINUTES);
    callReminderDate = calculateReminderDate(meetingDate.toISOString(), CALL_REMINDER_LEAD_MINUTES);
    whatsappStatus = whatsappReminderDate <= new Date() ? 'skipped' : 'pending';
    callStatus = callReminderDate <= new Date() ? 'skipped' : 'pending';
  }

  const { data, error } = await supabase
    .from('extracted_events')
    .insert({
      event_title: intent.title,
      event_date: eventDate,
      event_time: eventTime,
      timezone,
      user_phone: cleanPhoneNumber(userPhone),
      attendee_name: attendeeName,
      attendee_phone: cleanPhoneNumber(attendeePhone),
      confidence: null,
      status: eventDate && eventTime ? 'confirmed' : 'detected',
      context_sentence: transcript,
      whatsapp_reminder_at: whatsappReminderDate ? whatsappReminderDate.toISOString() : null,
      call_reminder_at: callReminderDate ? callReminderDate.toISOString() : null,
      whatsapp_reminder_status: whatsappStatus,
      call_reminder_status: callStatus,
    })
    .select('*')
    .single();

  if (error) {
    throw error;
  }

  let n8nTriggered = false;
  let n8nPayload = null;

  if (data && meetingDate && whatsappReminderDate && whatsappStatus === 'pending') {
    n8nPayload = buildReminderJobPayload({
      event: data,
      userPhone: cleanPhoneNumber(userPhone),
      attendeeName,
      attendeePhone: cleanPhoneNumber(attendeePhone),
      meetingDate,
      whatsappReminderDate,
    });

    try {
      await sendWhatsAppReminderJobToN8n(n8nPayload);
      n8nTriggered = true;
    } catch (n8nError) {
      const errorMessage = n8nError.response?.data || n8nError.message;
      await supabase
        .from('extracted_events')
        .update({
          whatsapp_reminder_status: 'failed',
          reminder_error: typeof errorMessage === 'string' ? errorMessage : JSON.stringify(errorMessage),
        })
        .eq('id', data.id);

      return {
        saved: true,
        id: data?.id || null,
        skipped: false,
        error: null,
        n8nTriggered: false,
        n8nPayload,
        n8nError: errorMessage,
      };
    }
  }

  return {
    saved: true,
    id: data?.id || null,
    skipped: false,
    error: null,
    n8nTriggered,
    n8nPayload,
    n8nError: null,
  };
}

/**
 * 🧠 Analyze Intent (Gemini)
 * Receives: { transcript: '...', userId: '...' }
 */
app.post('/api/analyze', validateApiKey, async (req, res) => {
  try {
    const { transcript, userId, timeZone } = req.body;
    if (!transcript) return res.status(400).json({ error: 'Missing transcript' });
    let userProfile = null;
    let dbResult = {
      saved: false,
      id: null,
      userId: userId || 'dev-expo-anonymous',
      usedFallbackUserId: !userId,
      error: null,
    };
    let extractedEventResult = {
      saved: false,
      id: null,
      skipped: false,
      error: null,
      n8nTriggered: false,
      n8nPayload: null,
      n8nError: null,
    };

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
  "location": "meeting location — default to 'Google Meet' if not specified by user",
  "attendees": ["name or email of attendee if mentioned"],
  "notes": "short context for the calendar description — include any details the user mentioned",
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

    // Fetch the user profile when authenticated. Logging below still runs in dev bypass.
    if (userId) {
      const { data: userData, error: profileError } = await supabase
        .from('users')
        .select('phone, full_name')
        .eq('firebase_uid', userId)
        .maybeSingle();

      if (profileError) {
        console.warn('⚠️ [DB] User profile fetch error:', profileError.message);
      } else {
        userProfile = userData;
      }
    }

    const userPhone = cleanPhoneNumber(req.body.user_phone || req.body.userPhone || userProfile?.phone || DEFAULT_TEST_USER_PHONE);
    const attendeePhone = cleanPhoneNumber(req.body.attendee_phone || req.body.attendeePhone || DEFAULT_TEST_ATTENDEE_PHONE);

    try {
      console.log(`💾 [DB] Saving voice log for user: ${userId || 'dev-expo-anonymous'}${userId ? '' : ' (fallback)'}`);
      const savedLog = await saveVoiceLog({ userId, transcript, intent, source: 'analyze' });
      dbResult = {
        saved: true,
        id: savedLog.id,
        userId: savedLog.userId,
        usedFallbackUserId: savedLog.usedFallbackUserId,
        error: null,
      };
      console.log('✅ [DB] Voice log saved:', dbResult);
      // ℹ️ WhatsApp confirmation is now sent ONLY after user confirms in the review screen
      //    via POST /api/whatsapp/confirm-meeting — not here during analysis.
    } catch (dbError) {
      dbResult.error = dbError.message;
      console.error('❌ [DB] Voice log save failed:', dbError);
    }

    try {
      console.log('💾 [DB] Saving extracted event from analyzed intent...');
      extractedEventResult = await saveExtractedEventFromIntent({
        transcript,
        intent,
        userPhone,
        attendeePhone,
      });
      if (extractedEventResult.skipped) {
        console.log('ℹ️ [DB] Extracted event save skipped for action:', intent.action);
      } else {
        console.log('✅ [DB] Extracted event saved:', extractedEventResult);
      }
    } catch (eventDbError) {
      extractedEventResult.error = eventDbError.message;
      console.error('❌ [DB] Extracted event save failed:', eventDbError);
    }

    res.json({
      ...intent,
      db_saved: dbResult.saved,
      db_log_id: dbResult.id,
      db_user_id: dbResult.userId,
      db_used_fallback_user_id: dbResult.usedFallbackUserId,
      db_error: dbResult.error,
      extracted_event_saved: extractedEventResult.saved,
      extracted_event_id: extractedEventResult.id,
      extracted_event_skipped: extractedEventResult.skipped,
      extracted_event_error: extractedEventResult.error,
      extracted_event_n8n_triggered: extractedEventResult.n8nTriggered,
      extracted_event_n8n_payload: extractedEventResult.n8nPayload,
      extracted_event_n8n_error: extractedEventResult.n8nError,
      user_phone: userPhone,
      attendee_phone: attendeePhone,
    });
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

    const prompt = `You are Adamslave, the user's high-end personal calendar assistant.
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
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
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

async function sendMeetingInvitationWA({ to, name, date, time, person, meeting_link, header_image }) {
  const authKey = process.env.MSG91_AUTH_KEY;
  const fromNumber = process.env.MSG91_WHATSAPP_NUMBER;
  const defaultImg = process.env.MSG91_CONFIRMATION_IMAGE;
  const headerImg = header_image || defaultImg || '';

  if (!authKey || !fromNumber) {
    throw new Error('MSG91 credentials not configured in .env');
  }

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
            header_1: { type: 'image', value: headerImg },
            body_meeting_link: { type: 'text', value: meeting_link, parameter_name: 'meeting_link' },
            body_person: { type: 'text', value: person, parameter_name: 'person' },
            body_time: { type: 'text', value: time, parameter_name: 'time' },
            body_name: { type: 'text', value: name, parameter_name: 'name' },
            body_date: { type: 'text', value: date, parameter_name: 'date' },
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

  return {
    msg91Response: response.data,
    msg91Payload: payload,
  };
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
    const { to, name, date, time, person, meeting_link, header_image } = req.body;

    if (!to || !Array.isArray(to) || to.length === 0) {
      return res.status(400).json({ error: 'Missing or invalid "to" field — must be a non-empty array of phone numbers.' });
    }
    if (!name || !date || !time || !person || !meeting_link) {
      return res.status(400).json({ error: 'Missing required fields: name, date, time, person, meeting_link' });
    }

    console.log(`📲 [WhatsApp] Sending meeting-invitation to ${to.join(', ')}...`);
    const result = await sendMeetingInvitationWA({ to, name, date, time, person, meeting_link, header_image });
    console.log('✅ [WhatsApp] meeting-invitation sent:', result.msg91Response);
    res.json({ success: true, msg91Response: result.msg91Response });

  } catch (err) {
    console.error('❌ [WhatsApp] meeting-invitation error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

/**
 * 📲 Send scheduled WhatsApp reminder via MSG91 invitation template.
 *
 * Auth:
 * - x-api-key for manual/backend testing
 * - x-shared-secret for n8n
 *
 * Body can be either:
 * { "event_id": "uuid" }
 *
 * or direct:
 * {
 *   "to": ["918282831626", "919830753118"],
 *   "name": "Member",
 *   "person": "JV",
 *   "date": "5 May 2026",
 *   "time": "9:30 PM",
 *   "meeting_link": "See calendar invite"
 * }
 */
app.post('/api/whatsapp/send-reminder', validateApiKeyOrN8nSecret, async (req, res) => {
  let eventId = req.body.event_id || null;

  try {
    let event = null;
    if (eventId) {
      const { data, error } = await supabase
        .from('extracted_events')
        .select('*')
        .eq('id', eventId)
        .single();

      if (error || !data) {
        return res.status(404).json({ success: false, error: 'Event not found' });
      }

      event = data;
    }

    const recipients = Array.isArray(req.body.to) && req.body.to.length > 0
      ? req.body.to
      : Array.isArray(req.body.recipient_phones) && req.body.recipient_phones.length > 0
        ? req.body.recipient_phones
        : [event?.user_phone, event?.attendee_phone].filter(Boolean);

    const to = recipients.map(cleanPhoneNumber).filter(Boolean);
    const name = req.body.name || 'Member';
    const person = req.body.person || req.body.attendee_name || event?.attendee_name || 'Team';
    const date = req.body.date || formatDisplayDate(event?.event_date);
    const time = req.body.time || formatDisplayTime(event?.event_time);
    const meetingLink = req.body.meeting_link || req.body.meetingLink || 'See calendar invite';
    const headerImage = req.body.header_image;

    if (!to.length) {
      return res.status(400).json({ success: false, error: 'At least one recipient phone is required' });
    }

    if (!name || !date || !time || !person || !meetingLink) {
      return res.status(400).json({ success: false, error: 'Missing required fields: name, date, time, person, meeting_link' });
    }

    console.log(`📲 [WhatsApp:reminder] Sending reminder to ${to.join(', ')} for event=${eventId || 'direct'}`);

    const result = await sendMeetingInvitationWA({
      to,
      name,
      date,
      time,
      person,
      meeting_link: meetingLink,
      header_image: headerImage,
    });

    if (eventId) {
      await supabase
        .from('extracted_events')
        .update({
          whatsapp_reminder_status: 'sent',
          whatsapp_sent_at: new Date().toISOString(),
          reminder_error: null,
        })
        .eq('id', eventId);
    }

    return res.json({
      success: true,
      event_id: eventId,
      to,
      msg91Response: result.msg91Response,
    });
  } catch (err) {
    const errorMessage = err.response?.data || err.message;
    console.error('❌ [WhatsApp:reminder] error:', errorMessage);

    if (eventId) {
      await supabase
        .from('extracted_events')
        .update({
          whatsapp_reminder_status: 'failed',
          reminder_error: typeof errorMessage === 'string' ? errorMessage : JSON.stringify(errorMessage),
        })
        .eq('id', eventId);
    }

    return res.status(500).json({
      success: false,
      error: errorMessage,
    });
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

/**
 * 🕒 Confirm an extracted event and enqueue the WhatsApp reminder in n8n
 *
 * PATCH /api/events/:id/confirm
 *
 * Body can override/fill these fields:
 * {
 *   "user_phone": "918282831626",
 *   "attendee_name": "Rahul",
 *   "attendee_phone": "+919999999999",
 *   "event_date": "2026-05-04",
 *   "event_time": "17:00",
 *   "timezone": "Asia/Kolkata",
 *   "event_title": "Sales Call"
 * }
 */
app.patch('/api/events/:id/confirm', validateApiKey, async (req, res) => {
  const eventId = req.params.id;

  try {
    const { data: existingEvent, error: fetchError } = await supabase
      .from('extracted_events')
      .select('*')
      .eq('id', eventId)
      .single();

    if (fetchError) {
      throw fetchError;
    }

    const attendeeName = req.body.attendee_name || req.body.customer_name || existingEvent.attendee_name || null;
    const attendeePhone = req.body.attendee_phone || req.body.customer_phone || existingEvent.attendee_phone || null;
    const userPhone = cleanPhoneNumber(req.body.user_phone || req.body.userPhone || existingEvent.user_phone || DEFAULT_TEST_USER_PHONE);
    const eventTitle = req.body.event_title || existingEvent.event_title || 'Meeting';
    const timezone = req.body.timezone || existingEvent.timezone || 'Asia/Kolkata';
    let eventDate = req.body.event_date || existingEvent.event_date || null;
    let eventTime = req.body.event_time || existingEvent.event_time || null;
    let meetingDate;

    if (req.body.meeting_time) {
      meetingDate = new Date(req.body.meeting_time);
      if (Number.isNaN(meetingDate.getTime())) {
        return res.status(400).json({ error: 'meeting_time must be a valid date/time' });
      }
      const parts = getDateTimePartsInZone(meetingDate, timezone);
      eventDate = parts.date;
      eventTime = parts.time;
    } else {
      if (!eventDate || !eventTime) {
        return res.status(400).json({
          error: 'event_date and event_time are required when meeting_time is not provided',
        });
      }
      meetingDate = localDateTimeToUtc(eventDate, eventTime, timezone);
      eventTime = String(eventTime).slice(0, 5);
    }

    if (!attendeePhone || !eventDate || !eventTime) {
      return res.status(400).json({
        error: 'attendee_phone, event_date, and event_time are required',
      });
    }

    const whatsappReminderDate = calculateReminderDate(meetingDate.toISOString(), WHATSAPP_REMINDER_LEAD_MINUTES);
    const callReminderDate = calculateReminderDate(meetingDate.toISOString(), CALL_REMINDER_LEAD_MINUTES);
    const now = new Date();
    const whatsappStatus = whatsappReminderDate <= now ? 'skipped' : 'pending';
    const callStatus = callReminderDate <= now ? 'skipped' : 'pending';

    const updatePayload = {
      status: 'confirmed',
      user_phone: userPhone,
      attendee_name: attendeeName,
      attendee_phone: cleanPhoneNumber(attendeePhone),
      event_title: eventTitle,
      event_date: eventDate,
      event_time: eventTime,
      timezone,
      whatsapp_reminder_at: whatsappReminderDate.toISOString(),
      call_reminder_at: callReminderDate.toISOString(),
      whatsapp_reminder_status: whatsappStatus,
      call_reminder_status: callStatus,
      reminder_error: null,
    };

    const { data: updatedEvent, error: updateError } = await supabase
      .from('extracted_events')
      .update(updatePayload)
      .eq('id', eventId)
      .select()
      .single();

    if (updateError) {
      throw updateError;
    }

    const n8nPayload = buildReminderJobPayload({
      event: updatedEvent,
      userPhone,
      attendeeName,
      attendeePhone: cleanPhoneNumber(attendeePhone),
      meetingDate,
      whatsappReminderDate,
    });

    let n8nResponse = null;

    if (whatsappStatus === 'pending') {
      try {
        n8nResponse = await sendWhatsAppReminderJobToN8n(n8nPayload);
      } catch (n8nError) {
        const errorMessage = n8nError.response?.data || n8nError.message;

        await supabase
          .from('extracted_events')
          .update({
            whatsapp_reminder_status: 'failed',
            reminder_error: typeof errorMessage === 'string' ? errorMessage : JSON.stringify(errorMessage),
          })
          .eq('id', eventId);

        return res.status(502).json({
          success: false,
          error: 'Failed to send WhatsApp reminder job to n8n',
          details: errorMessage,
          n8n_payload: n8nPayload,
        });
      }
    }

    return res.json({
      success: true,
      event: updatedEvent,
      n8n_triggered: whatsappStatus === 'pending',
      n8n_payload: n8nPayload,
      n8n_response: n8nResponse,
    });
  } catch (error) {
    console.error('❌ [Events] Confirm event error:', error);

    return res.status(500).json({
      error: error.message,
    });
  }
});

/**
 * 🕒 Check if a delayed n8n reminder execution is still valid.
 *
 * GET /api/events/:id/reminder-check?channel=whatsapp&reminder_at=2026-05-04T15:40:00.000Z
 */
app.get('/api/events/:id/reminder-check', requireN8nSharedSecret, async (req, res) => {
  try {
    const eventId = req.params.id;
    const channel = req.query.channel || 'whatsapp';
    const reminderAt = req.query.reminder_at;

    if (channel !== 'whatsapp') {
      return res.status(400).json({
        allowed: false,
        reason: 'unsupported_channel',
      });
    }

    if (!reminderAt) {
      return res.status(400).json({
        allowed: false,
        reason: 'missing_reminder_at',
      });
    }

    const requestedReminderDate = new Date(String(reminderAt));
    if (Number.isNaN(requestedReminderDate.getTime())) {
      return res.status(400).json({
        allowed: false,
        reason: 'invalid_reminder_at',
      });
    }

    const { data: event, error } = await supabase
      .from('extracted_events')
      .select('*')
      .eq('id', eventId)
      .single();

    if (error || !event) {
      return res.status(404).json({
        allowed: false,
        reason: 'event_not_found',
      });
    }

    const userPhone = cleanPhoneNumber(event.user_phone);
    const attendeePhone = cleanPhoneNumber(event.attendee_phone);
    const reminderDate = event.whatsapp_reminder_at ? new Date(event.whatsapp_reminder_at) : null;
    const reminderMatches = reminderDate
      && Math.abs(reminderDate.getTime() - requestedReminderDate.getTime()) < 1000;

    if (event.status === 'cancelled') {
      return res.json({ allowed: false, reason: 'event_cancelled' });
    }

    if (event.status !== 'confirmed') {
      return res.json({ allowed: false, reason: 'event_not_confirmed', status: event.status });
    }

    if (event.whatsapp_reminder_status !== 'pending') {
      return res.json({
        allowed: false,
        reason: event.whatsapp_reminder_status === 'sent' ? 'reminder_already_sent' : 'reminder_not_pending',
        whatsapp_reminder_status: event.whatsapp_reminder_status,
      });
    }

    if (!reminderMatches) {
      return res.json({
        allowed: false,
        reason: 'reminder_time_changed',
        current_reminder_at: event.whatsapp_reminder_at,
        requested_reminder_at: requestedReminderDate.toISOString(),
      });
    }

    if (!userPhone || !attendeePhone) {
      return res.json({
        allowed: false,
        reason: 'missing_recipient_phone',
        user_phone_present: Boolean(userPhone),
        attendee_phone_present: Boolean(attendeePhone),
      });
    }

    const meetingDate = localDateTimeToUtc(event.event_date, event.event_time, event.timezone || 'Asia/Kolkata');
    const payload = buildReminderJobPayload({
      event,
      userPhone,
      attendeeName: event.attendee_name,
      attendeePhone,
      meetingDate,
      whatsappReminderDate: reminderDate,
    });

    return res.json({
      allowed: true,
      reason: 'ok',
      event: payload,
    });
  } catch (error) {
    console.error('❌ [Reminders] Reminder check error:', error);

    return res.status(500).json({
      allowed: false,
      reason: 'server_error',
      error: error.message,
    });
  }
});

/**
 * 🕒 Receive WhatsApp reminder result from n8n
 *
 * n8n must send the shared secret in the x-shared-secret header.
 */
app.post('/api/reminders/whatsapp-result', requireN8nSharedSecret, async (req, res) => {
  try {
    const { event_id, status, sent_at, error_message } = req.body;

    if (!event_id || !status) {
      return res.status(400).json({
        error: 'event_id and status are required',
      });
    }

    const allowedStatuses = ['sent', 'failed', 'cancelled', 'skipped'];

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({
        error: 'Invalid WhatsApp reminder status',
      });
    }

    const updatePayload = {
      whatsapp_reminder_status: status,
    };

    if (status === 'sent') {
      updatePayload.whatsapp_sent_at = sent_at || new Date().toISOString();
      updatePayload.reminder_error = null;
    }

    if (status === 'failed') {
      updatePayload.reminder_error = error_message || 'WhatsApp sending failed';
    }

    const { data, error } = await supabase
      .from('extracted_events')
      .update(updatePayload)
      .eq('id', event_id)
      .select()
      .single();

    if (error) {
      throw error;
    }

    return res.json({
      success: true,
      event: data,
    });
  } catch (error) {
    console.error('❌ [Reminders] WhatsApp result update error:', error);

    return res.status(500).json({
      error: error.message,
    });
  }
});


/**
 * 📅 Create Google Calendar Event
 * Receives: { accessToken, title, description, date, time, durationMinutes, timeZone, location }
 */
app.post('/api/google/create-event', validateApiKey, async (req, res) => {
  try {
    const { accessToken, title, description, date, time, durationMinutes, timeZone, location } = req.body;
    
    if (!accessToken) return res.status(400).json({ error: 'Missing Google access token' });
    if (!title || !date || !time) return res.status(400).json({ error: 'Missing event details' });

    const startTime = new Date(`${date}T${time}:00`);
    const duration = Number(durationMinutes) || 60;
    const endTime = new Date(startTime.getTime() + duration * 60 * 1000);

    console.log(`📅 [Google] Creating event: "${title}" on ${date} ${time} with Meet link...`);

    const event = {
      summary: title,
      description: description || 'Created via Adamslave',
      location: location || undefined,
      start: {
        dateTime: startTime.toISOString(),
        timeZone: timeZone || 'UTC',
      },
      end: {
        dateTime: endTime.toISOString(),
        timeZone: timeZone || 'UTC',
      },
      conferenceData: {
        createRequest: {
          requestId: `adamslave-${Date.now()}`,
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      },
    };

    const response = await axios.post(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1',
      event,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    console.log('✅ [Google] Event created:', response.data.htmlLink);
    
    const meetLink = response.data.conferenceData?.entryPoints?.find(ep => ep.entryPointType === 'video')?.uri;

    res.json({
      success: true,
      eventLink: response.data.htmlLink,
      meetLink: meetLink || null,
      eventId: response.data.id
    });
  } catch (error) {
    console.error('❌ [Google] Calendar Error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to create calendar event', details: error.response?.data || error.message });
  }
});

// ─── Gmail Integration (googleapis) ─────────────────────────────────

function getGmailClient(accessToken) {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.gmail({ version: 'v1', auth });
}

function decodeBase64Url(data) {
  if (!data) return '';
  const str = data.replace(/-/g, '+').replace(/_/g, '/');
  const pad = str.length % 4;
  const padded = pad ? str + '='.repeat(4 - pad) : str;
  try {
    return Buffer.from(padded, 'base64').toString('utf-8');
  } catch {
    return '';
  }
}

function getHeader(headers, name) {
  const h = headers?.find(h => h.name?.toLowerCase() === name.toLowerCase());
  return h?.value || '';
}

function getMessageBody(payload) {
  if (!payload) return '';
  let body = '';
  if (payload.parts) {
    const plainPart = payload.parts.find(p => p.mimeType === 'text/plain');
    const htmlPart = payload.parts.find(p => p.mimeType === 'text/html');
    if (plainPart?.body?.data) {
      body = decodeBase64Url(plainPart.body.data);
    } else if (htmlPart?.body?.data) {
      body = decodeBase64Url(htmlPart.body.data);
    }
    if (!body) {
      for (const part of payload.parts) {
        if (part.parts) {
          const nested = getMessageBody(part);
          if (nested) { body = nested; break; }
        }
      }
    }
  } else if (payload.body?.data) {
    body = decodeBase64Url(payload.body.data);
  }
  if (body.includes('<') && body.includes('>')) {
    body = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  return body;
}

function getGmailAppReturnUrl(state, appReturnUrl) {
  if (appReturnUrl) return appReturnUrl;

  if (!state) return null;

  try {
    const parsedState = JSON.parse(state);
    return parsedState.appReturnUrl || null;
  } catch {
    return null;
  }
}

function isAllowedGmailReturnUrl(returnUrl) {
  try {
    const parsedUrl = new URL(returnUrl);
    return ['exp:', 'exps:', 'mobile:'].includes(parsedUrl.protocol);
  } catch {
    return false;
  }
}

/**
 * 🔗 OAuth Callback Proxy for Expo Go
 * GET /api/gmail/oauth-callback?code=...&state=...
 *
 * Google redirects here after user consents. We immediately redirect
 * back to the mobile app so it can exchange the code for a token.
 */
app.get('/api/gmail/oauth-callback', (req, res) => {
  const { code, state, error, app_return_url } = req.query;
  const appReturnUrl = getGmailAppReturnUrl(state, app_return_url);

  if (!appReturnUrl) {
    return res.status(400).send('Missing app return URL');
  }

  if (!isAllowedGmailReturnUrl(appReturnUrl)) {
    return res.status(400).send('Invalid app return URL');
  }

  try {
    const redirectUrl = new URL(appReturnUrl);
    if (code) redirectUrl.searchParams.set('code', code);
    if (state) redirectUrl.searchParams.set('state', state);
    if (error) redirectUrl.searchParams.set('error', error);
    res.redirect(redirectUrl.toString());
  } catch (e) {
    res.status(400).send('Invalid app return URL');
  }
});

/**
 * 🔄 Exchange OAuth Code for Tokens (secure — client_secret stays on server)
 * POST /api/gmail/exchange-code
 */
app.post('/api/gmail/exchange-code', async (req, res) => {
  try {
    const { code, redirectUri, codeVerifier } = req.body;
    if (!code || !redirectUri) {
      return res.status(400).json({ error: 'Missing code or redirectUri' });
    }

    const clientId = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      return res.status(500).json({ error: 'Server is missing Google OAuth credentials' });
    }

    const params = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });

    if (codeVerifier) {
      params.set('code_verifier', codeVerifier);
    }

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    const tokenData = await tokenRes.json();

    if (!tokenRes.ok || tokenData.error) {
      console.error('❌ [Gmail] Token exchange failed:', tokenData);
      return res.status(400).json({
        error: tokenData.error || 'Token exchange failed',
        description: tokenData.error_description || '',
      });
    }

    // Fetch user email
    let email = '';
    try {
      const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const userData = await userRes.json();
      email = userData.email || '';
    } catch (e) {
      console.warn('[Gmail] Could not fetch userinfo:', e.message);
    }

    res.json({
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || null,
      idToken: tokenData.id_token || null,
      email,
      expiresIn: tokenData.expires_in,
    });
  } catch (err) {
    console.error('❌ [Gmail] Exchange-code error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 🔗 Connect Gmail Account
 * POST /api/gmail/connect
 */
app.post('/api/gmail/connect', validateApiKey, async (req, res) => {
  try {
    const { userId, accessToken, refreshToken, email, expiresAt } = req.body;
    if (!userId || !accessToken || !email) {
      return res.status(400).json({ error: 'Missing userId, accessToken, or email' });
    }

    const { error } = await supabaseAdmin
      .from('gmail_accounts')
      .upsert({
        user_id: userId,
        gmail_email: email,
        access_token: accessToken,
        refresh_token: refreshToken || null,
        expires_at: expiresAt || null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });

    if (error) {
      console.error('❌ [Gmail] DB error:', error.message, error.details, error.hint);
      return res.status(500).json({ error: 'Failed to save Gmail account', details: error.message });
    }

    console.log(`✅ [Gmail] Connected: ${email} for user ${userId}`);
    res.json({ success: true, email });
  } catch (err) {
    console.error('❌ [Gmail] Connect error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 📥 Fetch Inbox — returns only emails that likely need a reply
 * GET /api/gmail/inbox?userId=...&days=7|15|30
 */

const AUTO_SENDER_PATTERNS = [
  'no-reply', 'noreply', 'donotreply', 'notifications', 'notification',
  'alerts', 'alert', 'digest', 'newsletter', 'marketing', 'mailer-daemon',
  'bounce', 'support', 'help', 'team', 'info', 'admin', 'billing',
  'updates', 'status', 'github', 'linkedin', 'twitter', 'facebook',
  'instagram', 'youtube', 'netflix', 'spotify', 'amazon', 'flipkart',
  'swiggy', 'zomato', 'uber', 'ola', 'paytm', 'phonepe', 'razorpay',
];

const AUTO_SUBJECT_PATTERNS = [
  'unsubscribe', 'digest', 'newsletter', 'your order', 'shipment',
  'invoice', 'receipt', 'password reset', 'verification', 'otp',
  'reset your', 'confirm your', 'welcome to', 'thanks for signing',
  'account alert', 'security alert', 'login attempt', 'delivery',
  'tracking', 'payment received', 'statement', 'summary', 'weekly',
  'monthly', 'daily digest', 'promotion', 'sale', 'offer', 'deal',
  'order confirmed', 'order shipped', 'subscription', 'reminder:',
];

function isAutoEmail(fromEmail, fromName, subject, labels) {
  const emailLower = (fromEmail || '').toLowerCase();
  const nameLower = (fromName || '').toLowerCase();
  const subjectLower = (subject || '').toLowerCase();

  for (const p of AUTO_SENDER_PATTERNS) {
    if (emailLower.includes(p) || nameLower.includes(p)) return true;
  }
  for (const p of AUTO_SUBJECT_PATTERNS) {
    if (subjectLower.includes(p)) return true;
  }
  if (Array.isArray(labels)) {
    if (labels.includes('CATEGORY_PROMOTIONS')) return true;
    if (labels.includes('CATEGORY_SOCIAL')) return true;
    if (labels.includes('CATEGORY_FORUMS')) return true;
  }
  return false;
}

app.get('/api/gmail/inbox', validateApiKey, async (req, res) => {
  try {
    const { userId, days } = req.query;
    if (!userId) return res.status(400).json({ error: 'Missing userId' });

    const { data: account, error: dbError } = await supabaseAdmin
      .from('gmail_accounts')
      .select('access_token, gmail_email')
      .eq('user_id', userId)
      .maybeSingle();

    if (dbError || !account) {
      return res.status(404).json({ error: 'Gmail account not connected' });
    }

    const dayCount = Math.min(Math.max(Number(days) || 7, 1), 30);
    const gmail = getGmailClient(account.access_token);
    const userEmail = account.gmail_email?.toLowerCase() || '';

    // Broader search with exclusions (not just primary)
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      q: `newer_than:${dayCount}d -category:promotions -category:social -category:forums`,
      maxResults: 60,
    });

    const messages = listRes.data.messages || [];
    if (messages.length === 0) {
      return res.json({ emails: [], account: account.gmail_email });
    }

    // Fetch metadata for all messages
    const candidates = await Promise.all(
      messages.map(async (msg) => {
        try {
          const detail = await gmail.users.messages.get({
            userId: 'me',
            id: msg.id,
            format: 'metadata',
            metadataHeaders: ['From', 'Subject', 'Date', 'To'],
          });

          const headers = detail.data.payload?.headers || [];
          const from = getHeader(headers, 'From');
          const to = getHeader(headers, 'To');
          const subject = getHeader(headers, 'Subject');
          const date = getHeader(headers, 'Date');
          const labels = detail.data.labelIds || [];

          const senderMatch = from.match(/^"?([^"]+)"?\s*<(.+)>$/);
          const senderName = senderMatch ? senderMatch[1].trim() : from.split('@')[0];
          const senderEmail = senderMatch ? senderMatch[2].trim() : from;

          return {
            id: msg.id,
            threadId: msg.threadId,
            subject: subject || '(no subject)',
            senderName: senderName || 'Unknown',
            senderEmail: senderEmail || '',
            date,
            snippet: detail.data.snippet || '',
            unread: labels.includes('UNREAD'),
            labels,
            to,
          };
        } catch (e) {
          console.warn(`⚠️ [Gmail] Failed to fetch message ${msg.id}:`, e.message);
          return null;
        }
      })
    );

    // Filter 1: Remove nulls and auto-generated emails
    let filtered = candidates.filter((e) => {
      if (!e) return false;
      if (isAutoEmail(e.senderEmail, e.senderName, e.subject, e.labels)) return false;
      return true;
    });

    // Filter 2: For each thread, if the LAST message is from the user, skip it
    const needsReply = [];
    await Promise.all(
      filtered.map(async (email) => {
        try {
          const thread = await gmail.users.threads.get({
            userId: 'me',
            id: email.threadId,
          });

          const threadMessages = thread.data.messages || [];
          if (threadMessages.length === 0) {
            needsReply.push(email);
            return;
          }

          const lastMsg = threadMessages[threadMessages.length - 1];
          const lastHeaders = lastMsg.payload?.headers || [];
          const lastFrom = getHeader(lastHeaders, 'From').toLowerCase();

          // If last message is from user, they already replied / sent it
          if (lastFrom.includes(userEmail)) return;

          needsReply.push({
            ...email,
            replyReason: 'Waiting for your reply',
          });
        } catch (e) {
          // Thread fetch failed — include conservatively
          needsReply.push(email);
        }
      })
    );

    // Sort by date desc
    needsReply.sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime());

    res.json({
      emails: needsReply.slice(0, 30),
      account: account.gmail_email,
    });
  } catch (err) {
    console.error('❌ [Gmail] Inbox error:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 📧 Fetch Message Detail
 * GET /api/gmail/message/:id?userId=...
 */
app.get('/api/gmail/message/:id', validateApiKey, async (req, res) => {
  try {
    const { userId } = req.query;
    const messageId = req.params.id;
    if (!userId) return res.status(400).json({ error: 'Missing userId' });

    const { data: account, error: dbError } = await supabaseAdmin
      .from('gmail_accounts')
      .select('access_token')
      .eq('user_id', userId)
      .maybeSingle();

    if (dbError || !account) {
      return res.status(404).json({ error: 'Gmail account not connected' });
    }

    const gmail = getGmailClient(account.access_token);

    const detail = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });

    const headers = detail.data.payload?.headers || [];
    const from = getHeader(headers, 'From');
    const to = getHeader(headers, 'To');
    const subject = getHeader(headers, 'Subject');
    const date = getHeader(headers, 'Date');
    const body = getMessageBody(detail.data.payload);

    let threadMessages = [];
    if (detail.data.threadId) {
      try {
        const thread = await gmail.users.threads.get({
          userId: 'me',
          id: detail.data.threadId,
        });
        threadMessages = (thread.data.messages || []).map(m => ({
          id: m.id,
          from: getHeader(m.payload?.headers, 'From'),
          date: getHeader(m.payload?.headers, 'Date'),
          body: getMessageBody(m.payload),
          snippet: m.snippet,
        }));
      } catch (e) {
        console.warn('⚠️ [Gmail] Thread fetch failed:', e.message);
      }
    }

    res.json({
      id: messageId,
      threadId: detail.data.threadId,
      subject: subject || '(no subject)',
      from,
      to,
      date,
      body: body || detail.data.snippet || '',
      snippet: detail.data.snippet,
      threadMessages: threadMessages.length > 0 ? threadMessages : [{
        id: messageId,
        from,
        date,
        body: body || detail.data.snippet || '',
        snippet: detail.data.snippet,
      }],
    });
  } catch (err) {
    console.error('❌ [Gmail] Message error:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 🤖 Generate AI Reply
 * POST /api/gmail/generate-reply
 */
app.post('/api/gmail/generate-reply', validateApiKey, async (req, res) => {
  try {
    const { emailBody, subject, senderName, tone, userName } = req.body;
    if (!emailBody) return res.status(400).json({ error: 'Missing emailBody' });

    const prompt = `You are a professional email assistant. Draft a concise, professional reply to this email.

Context:
- Subject: ${subject || 'N/A'}
- From: ${senderName || 'Sender'}
- Tone: ${tone || 'professional and friendly'}
- Your name: ${userName || 'Me'}

Original email:
"""
${emailBody}
"""

Instructions:
1. Write a reply that directly addresses the email content
2. Keep it concise (2-4 sentences unless complex)
3. Be warm but professional
4. Sign off with the user's first name: "${userName ? userName.split(' ')[0] : 'Best'}"
5. Do NOT include calendar invite links, meeting URLs, or video call links in the reply text. Those are shared separately.
6. Do NOT include subject line or formal signatures
7. Return ONLY the reply text, no explanations

Draft reply:`;

    const model = selectModel(emailBody);
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 500 },
      }
    );

    const reply = response.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || 'I could not generate a reply.';

    res.json({ reply });
  } catch (err) {
    console.error('❌ [Gmail] Generate reply error:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 📤 Send Email
 * POST /api/gmail/send
 */
app.post('/api/gmail/send', validateApiKey, async (req, res) => {
  try {
    const { userId, to, subject, body, threadId } = req.body;
    if (!userId || !to || !subject || !body) {
      return res.status(400).json({ error: 'Missing required fields: userId, to, subject, body' });
    }

    const { data: account, error: dbError } = await supabaseAdmin
      .from('gmail_accounts')
      .select('access_token')
      .eq('user_id', userId)
      .maybeSingle();

    if (dbError || !account) {
      return res.status(404).json({ error: 'Gmail account not connected' });
    }

    const gmail = getGmailClient(account.access_token);

    const messageParts = [
      `To: ${to}`,
      `Subject: ${subject}`,
      'Content-Type: text/plain; charset=utf-8',
      'MIME-Version: 1.0',
      '',
      body,
    ];
    const raw = Buffer.from(messageParts.join('\n')).toString('base64url');

    const sendRes = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw, threadId: threadId || undefined },
    });

    console.log(`✅ [Gmail] Sent message: ${sendRes.data.id}`);
    res.json({
      success: true,
      messageId: sendRes.data.id,
      threadId: sendRes.data.threadId,
    });
  } catch (err) {
    console.error('❌ [Gmail] Send error:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 AI Backend running at http://0.0.0.0:${PORT}`);
});
