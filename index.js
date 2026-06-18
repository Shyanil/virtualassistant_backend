require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const morgan = require('morgan');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { google } = require('googleapis');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(morgan('dev'));

// ─── API Key Auth Middleware ─────────────────────────────────
const validateApiKey = (req, res, next) => {
  const configuredKey = process.env.BACKEND_API_KEY;
  // Fail closed: if the key isn't configured, reject rather than letting every
  // request through. (The API key is a coarse gate — real per-user auth is
  // handled by verifyFirebaseToken on the AI endpoints.)
  if (!configuredKey) {
    console.error('❌ [Config] BACKEND_API_KEY is not set — rejecting request (fail closed).');
    return res.status(500).json({ error: 'Server misconfigured: API key not set.' });
  }
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

// ─── Auth & abuse protection for the AI endpoints (#4) ───────────────
// Render runs behind a proxy; trust the first hop so rate limiting reads the
// real client IP rather than the proxy's.
app.set('trust proxy', 1);

// Keyless Firebase ID-token verification: verify the token's signature against
// Google's PUBLIC certificates and check issuer/audience against the project ID.
// No service account key/secret is needed — only the public FIREBASE_PROJECT_ID.
// If it isn't set, token checks are skipped (logged) so existing deploys keep
// working until you add it — at which point enforcement turns on automatically.
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID || null;
const FIREBASE_TOKEN_ISSUER = FIREBASE_PROJECT_ID ? `https://securetoken.google.com/${FIREBASE_PROJECT_ID}` : null;
const FIREBASE_CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

if (FIREBASE_PROJECT_ID) {
  console.log(`✅ [Auth] Keyless Firebase token verification is ON for project "${FIREBASE_PROJECT_ID}".`);
} else {
  console.warn('⚠️ [Auth] FIREBASE_PROJECT_ID not set — Firebase token verification is DISABLED. Set it to enforce per-user auth.');
}

// Google's token-signing certs rotate; cache them and honour the Cache-Control max-age.
let googleCerts = null;
let googleCertsExpiry = 0;
async function getGoogleSigningCerts() {
  if (googleCerts && Date.now() < googleCertsExpiry) return googleCerts;
  const res = await axios.get(FIREBASE_CERTS_URL);
  googleCerts = res.data; // { "<kid>": "-----BEGIN CERTIFICATE-----..." }
  const maxAge = Number((res.headers['cache-control'] || '').match(/max-age=(\d+)/)?.[1]) || 3600;
  googleCertsExpiry = Date.now() + maxAge * 1000;
  return googleCerts;
}

// Verifies `Authorization: Bearer <Firebase ID token>` and attaches req.firebaseUser
// ({ uid, ... }, where uid === users.firebase_uid). Enforce-if-configured: when
// FIREBASE_PROJECT_ID isn't set, requests pass through so deploying never bricks
// the app.
async function verifyFirebaseToken(req, res, next) {
  if (!FIREBASE_PROJECT_ID) return next();
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized: missing session token. Please sign in again.' });
  }
  try {
    const decoded = jwt.decode(token, { complete: true });
    const kid = decoded?.header?.kid;
    if (!kid) throw new Error('token has no key id');
    const certs = await getGoogleSigningCerts();
    const cert = certs[kid];
    if (!cert) throw new Error('no matching Google signing certificate');
    const payload = jwt.verify(token, cert, {
      algorithms: ['RS256'],
      audience: FIREBASE_PROJECT_ID,
      issuer: FIREBASE_TOKEN_ISSUER,
    });
    if (!payload.sub) throw new Error('token has no subject');
    req.firebaseUser = { ...payload, uid: payload.user_id || payload.sub };
    next();
  } catch (err) {
    console.warn('⚠️ [Auth] Token verification failed:', err.message);
    return res.status(401).json({ error: 'Unauthorized: invalid or expired session. Please sign in again.' });
  }
}

// Per-user (fallback per-IP) rate limit for the cost-heavy AI endpoints, so an
// extracted API key + a loop can't run up the Google STT / Gemini bill.
const aiRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,                 // generous: ~6–7 sustained requests/min per user
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.firebaseUser?.uid || ipKeyGenerator(req.ip),
  message: { error: 'Too many requests. Please wait a few minutes and try again.' },
});

// Gate the expensive AI endpoints behind token auth + rate limiting. Registered
// before the route handlers so it runs first for these paths.
app.use(
  ['/api/transcribe', '/api/analyze', '/api/analyze-document', '/api/chat', '/api/meetings'],
  verifyFirebaseToken,
  aiRateLimiter,
);

const WHATSAPP_REMINDER_LEAD_MINUTES = 20;
const CALL_REMINDER_LEAD_MINUTES = 5;

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

// Returns the calendar date (YYYY-MM-DD) for `date` as seen in `timeZone`.
// Falls back to the UTC date if the timezone is missing/invalid.
function formatDateInTimeZone(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    return date.toISOString().split('T')[0];
  }
}

function formatFollowUpLogNotes(result) {
  const parts = [];
  if (result.followUp) parts.push(`Message: ${result.followUp}`);
  if (Array.isArray(result.actionItems) && result.actionItems.length) {
    parts.push(`Signals:\n${result.actionItems.map(item => `- ${item}`).join('\n')}`);
  }
  if (result.summary) parts.push(`Context: ${result.summary}`);
  return parts.join('\n\n') || 'Follow-up captured.';
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

async function getGoogleAccessToken(userId) {
  try {
    const { data: account, error } = await supabaseAdmin
      .from('gmail_accounts')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (error || !account) return null;

    const now = new Date();
    const expiresAt = account.expires_at ? new Date(account.expires_at) : null;

    // If still valid (with 5-minute buffer), return current access token
    if (expiresAt && (expiresAt.getTime() - now.getTime() > 5 * 60 * 1000)) {
      return account.access_token;
    }

    // Otherwise, refresh it if refresh token is present
    if (account.refresh_token) {
      console.log(`🔄 [Google OAuth] Refreshing access token for user ${userId}...`);
      const response = await axios.post('https://oauth2.googleapis.com/token', {
        client_id: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        refresh_token: account.refresh_token,
        grant_type: 'refresh_token',
      });

      const newAccessToken = response.data.access_token;
      const expiresIn = response.data.expires_in || 3600;
      const newExpiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

      await supabaseAdmin
        .from('gmail_accounts')
        .update({
          access_token: newAccessToken,
          expires_at: newExpiresAt,
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', userId);

      console.log(`✅ [Google OAuth] Access token refreshed successfully.`);
      return newAccessToken;
    }

    return account.access_token;
  } catch (err) {
    console.error('❌ [Google OAuth] Refresh token error:', err.response?.data || err.message);
    return null;
  }
}

async function autoCreateGoogleCalendarEvent({ accessToken, title, description, date, time, timezone, location }) {
  const startTime = new Date(`${date}T${time}:00`);
  const endTime = new Date(startTime.getTime() + 60 * 60 * 1000); // 1 hour default

  const eventPayload = {
    summary: title,
    description: description || 'Created automatically by Adamslave Assistant',
    location: location || 'Google Meet',
    start: {
      dateTime: startTime.toISOString(),
      timeZone: timezone || 'Asia/Kolkata',
    },
    end: {
      dateTime: endTime.toISOString(),
      timeZone: timezone || 'Asia/Kolkata',
    },
    conferenceData: {
      createRequest: {
        requestId: `adamslave-auto-${Date.now()}`,
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    },
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: 60 } // Popup reminder 1 hour before meeting, as requested!
      ]
    }
  };

  try {
    const response = await axios.post(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1',
      eventPayload,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const meetLink = response.data.conferenceData?.entryPoints?.find(ep => ep.entryPointType === 'video')?.uri;
    return {
      success: true,
      eventLink: response.data.htmlLink,
      meetLink: meetLink || null,
      eventId: response.data.id
    };
  } catch (err) {
    console.error('❌ [AutoCalendar] API call failed:', err.response?.data || err.message);
    return null;
  }
}

async function saveExtractedEventFromIntent({ transcript, intent, userPhone, attendeePhone, userId, userName }) {
  if (!['create_event', 'set_reminder'].includes(intent.action) || !intent.title) {
    return { saved: false, id: null, skipped: true, error: null, n8nTriggered: false, n8nPayload: null };
  }

  const timezone = intent.timeZone || 'Asia/Kolkata';
  const eventDate = intent.date || null;
  const eventTime = intent.time || null;
  let whatsappReminderDate = null;
  let callReminderDate = null;
  let whatsappStatus = 'pending';
  let callStatus = 'pending';
  let meetingDate = null;

  if (eventDate && eventTime) {
    meetingDate = localDateTimeToUtc(eventDate, eventTime, timezone);
    whatsappReminderDate = calculateReminderDate(meetingDate.toISOString(), 30); // T-30 mins
    callReminderDate = calculateReminderDate(meetingDate.toISOString(), 15); // T-15 mins
    whatsappStatus = whatsappReminderDate <= new Date() ? 'skipped' : 'pending';
    callStatus = callReminderDate <= new Date() ? 'skipped' : 'pending';
  }

  // 1. Extract and build attendees list
  let names = [];
  if (Array.isArray(intent.attendees) && intent.attendees.length > 0) {
    names = intent.attendees;
  } else {
    const singleName = extractAttendeeName(intent.title) || extractAttendeeName(transcript);
    if (singleName) {
      names = [singleName];
    }
  }

  const cleanUserPhone = cleanPhoneNumber(userPhone);
  const attendeesList = [];

  for (let i = 0; i < names.length; i++) {
    const name = names[i].trim();
    let phone = null;
    let phoneSource = 'unknown';

    // A. Check contact book if userId is provided
    if (userId && userId !== 'dev-expo-anonymous') {
      try {
        const { data: contact } = await supabase
          .from('contacts')
          .select('phone')
          .eq('user_id', userId)
          .eq('name', name)
          .maybeSingle();

        if (contact?.phone) {
          phone = cleanPhoneNumber(contact.phone);
          phoneSource = 'contact_book';
        }
      } catch (err) {
        console.warn(`⚠️ [Contact Book] Query failed for ${name}:`, err.message);
      }
    }

    // B. Fallback to passed attendeePhone for the first invitee if still empty
    if (!phone && i === 0 && attendeePhone) {
      phone = cleanPhoneNumber(attendeePhone);
      phoneSource = 'detected';
    }

    attendeesList.push({
      name,
      phone: phone || null,
      confirmation_status: 'pending',
      confirmation_sent_at: null,
      reminder_status: 'pending',
      reminder_sent_at: null,
      phone_source: phoneSource
    });
  }

  // 1.5 Automatically Create Google Calendar Event & Generate Meet Link if Authenticated
  let generatedMeetLink = null;
  if (userId && userId !== 'dev-expo-anonymous' && eventDate && eventTime) {
    const googleToken = await getGoogleAccessToken(userId);
    if (googleToken) {
      console.log(`📅 [AutoCalendar] Automatically syncing to Google Calendar for user: ${userId}...`);
      const calRes = await autoCreateGoogleCalendarEvent({
        accessToken: googleToken,
        title: intent.title,
        description: intent.notes || transcript || 'Created automatically by Adamslave Assistant',
        date: eventDate,
        time: eventTime,
        timezone: timezone,
        location: intent.location || 'Google Meet',
      });
      if (calRes && calRes.success) {
        generatedMeetLink = calRes.meetLink || calRes.eventLink;
        console.log(`✅ [AutoCalendar] Event synced! Meet Link: ${generatedMeetLink}`);
      }
    }
  }

  // 2. Insert extracted event with the attendees array and new meeting_link
  const { data: eventData, error: insertError } = await supabase
    .from('extracted_events')
    .insert({
      event_title: intent.title,
      event_date: eventDate,
      event_time: eventTime,
      timezone,
      user_phone: cleanUserPhone,
      user_name: userName || null,
      attendees: attendeesList,
      meeting_link: generatedMeetLink,
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

  if (insertError) {
    throw insertError;
  }

  // Notifications are intentionally NOT sent here.
  // The frontend triggers them only after the user reviews and taps "Confirm & Notify".
  // Host WA → /api/whatsapp/confirm-meeting
  // Invitee WA → /api/events/:id/invitee-phone
  const finalEvent = eventData;

  // 4. Trigger n8n for reminders if pending
  let n8nTriggered = false;
  let n8nPayload = null;

  if (finalEvent && meetingDate && whatsappReminderDate && whatsappStatus === 'pending') {
    n8nPayload = buildReminderJobPayload({
      event: finalEvent,
      userPhone: cleanUserPhone,
      attendeeName: attendeesList[0]?.name || 'Guest',
      attendeePhone: attendeesList[0]?.phone || null,
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
        .eq('id', finalEvent.id);

      return {
        saved: true,
        id: finalEvent.id,
        skipped: false,
        error: null,
        n8nTriggered: false,
        n8nPayload,
        n8nError: errorMessage,
        meeting_link: finalEvent.meeting_link,
      };
    }
  }

  return {
    saved: true,
    id: finalEvent.id,
    skipped: false,
    error: null,
    n8nTriggered,
    n8nPayload,
    n8nError: null,
    meeting_link: finalEvent.meeting_link,
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
    
    // Resolve "today" in the USER's timezone, not the server's UTC clock, so
    // relative dates ("tomorrow", "tonight", "in 2 hours") land on the right day.
    const requestedTimeZone = timeZone || 'UTC';
    const now = new Date();
    const today = formatDateInTimeZone(now, requestedTimeZone);
    let localNowLabel = today;
    try {
      localNowLabel = new Intl.DateTimeFormat('en-US', {
        timeZone: requestedTimeZone,
        weekday: 'long',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      }).format(now);
    } catch { /* keep the date-only label */ }

    const prompt = `Today is ${today} (${localNowLabel}). User timezone is ${requestedTimeZone}.
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

    // Always use the real user phone (from the request or their profile) — never
    // a hardcoded test number. A null phone is safe: the meeting still saves and
    // shows (via voice_logs); it just won't trigger a WhatsApp reminder.
    const userPhone = cleanPhoneNumber(req.body.user_phone || req.body.userPhone || userProfile?.phone || null);
    const attendeePhone = cleanPhoneNumber(req.body.attendee_phone || req.body.attendeePhone || null);

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
        userId,
        userName: userProfile?.full_name || 'Member',
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
      extracted_event_meeting_link: extractedEventResult.meeting_link || null,
      meeting_link: extractedEventResult.meeting_link || null,
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

    // Personalize the assistant with the user's real first name for the prompt.
    let userName = 'the user';
    if (userId) {
      const { data: profile } = await supabaseAdmin
        .from('users')
        .select('name, full_name')
        .eq('firebase_uid', userId)
        .maybeSingle();
      const fullName = (profile?.name || profile?.full_name || '').trim();
      if (fullName) userName = fullName.split(/\s+/)[0];
    }

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

    // Pending follow-ups / tasks — the user also treats these as "meetings",
    // so the assistant must be able to answer about them.
    let followUps = [];
    if (userId) {
      const { data, error } = await supabaseAdmin
        .from('follow_ups')
        .select('title, summary, action_items, tasks, follow_up_text, reminder_status, reminder_at, created_at')
        .eq('user_id', userId)
        .eq('status', 'open')
        .order('created_at', { ascending: false })
        .limit(10);

      if (error) {
        console.warn('⚠️ [Chat] Follow-up query failed:', error.message);
      } else {
        followUps = data || [];
      }
    }

    const scheduleText = contextEvents.length
      ? contextEvents.map((event, index) => {
          const when = [event.date, event.time].filter(Boolean).join(' ');
          return `${index + 1}. ${event.title || event.action || 'Untitled'} (${when || 'time unknown'}) - ${event.notes || event.transcript || 'No notes'}`;
        }).join('\n')
      : 'No upcoming events found in the next 7 days.';

    const followUpsText = followUps.length
      ? followUps.map((fu, index) => {
          const tasks = Array.isArray(fu.tasks) ? fu.tasks : [];
          const pending = tasks.filter(t => t && !t.done).map(t => t.text);
          const items = pending.length
            ? pending.join('; ')
            : (Array.isArray(fu.action_items) && fu.action_items.length
                ? fu.action_items.join('; ')
                : 'No open tasks');
          const reminder = fu.reminder_status === 'scheduled' && fu.reminder_at
            ? ` [reminder set for ${fu.reminder_at}]`
            : '';
          return `${index + 1}. ${fu.title || 'Meeting Follow-up'}${reminder} — ${items}`;
        }).join('\n')
      : 'No pending follow-ups.';

    const recentHistory = Array.isArray(history)
      ? history.slice(-8).map(item => `${item.role === 'assistant' ? 'Assistant' : 'User'}: ${item.content}`).join('\n')
      : '';

    const prompt = `You are a personal meeting assistant for ${userName}.

You ONLY have access to ${userName}'s calendar data that has been provided to you in this conversation. You must ONLY answer questions based on that data — do not assume, invent, or guess any meeting, event, or free time that is not explicitly present in the provided context.

You help ${userName} with:
- Upcoming meetings and events
- Free time slots in their schedule
- Pending follow-ups and tasks
- Meeting details like time, date, person, location, or notes

If ${userName} asks anything outside of their calendar and meeting data (general knowledge, unrelated questions, jokes, anything else), respond with exactly:
"I can only help you with your meetings, calendar, and follow-ups. Please ask me something related to your schedule."

If ${userName} asks to schedule, delete, or modify a meeting, respond with exactly:
"To schedule or manage meetings, please use the Home tab — you can add via voice, note, or document upload."

Never answer from general knowledge. Never go outside the data provided to you. You are strictly a calendar and meeting assistant for ${userName} only.

────────────────────────────
Today is ${today}. ${userName}'s timezone: ${requestedTimeZone}.

UPCOMING MEETINGS & EVENTS (next 7 days):
${scheduleText}

PENDING FOLLOW-UPS & TASKS:
${followUpsText}

CONVERSATION HISTORY:
${recentHistory || 'First interaction.'}

CURRENT QUESTION FROM ${userName}: "${message}"`;

    // Model call with fallback: try the fast/cheap model first, escalate to the
    // stronger model only if the answer comes back empty or low-confidence.
    const PRIMARY_MODEL = 'gemini-2.5-flash';
    const FALLBACK_MODEL = 'gemini-2.5-pro';

    const callGemini = async (model, p) => {
      try {
        const resp = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
          {
            contents: [{ parts: [{ text: p }] }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 800 },
          },
          { timeout: 60000 }
        );
        const text = resp.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
        return { text };
      } catch (err) {
        console.warn(`⚠️ [Chat] ${model} call failed:`, err.response?.data?.error?.message || err.message);
        return { text: '' };
      }
    };

    let result = await callGemini(PRIMARY_MODEL, prompt);

    const isWeak = !result.text ||
                   result.text.length < 80 ||
                   result.text.toLowerCase().includes("i'm not sure") ||
                   result.text.toLowerCase().includes("i don't know") ||
                   result.text.toLowerCase().includes("i cannot");

    if (isWeak) {
      const fallback = await callGemini(FALLBACK_MODEL, prompt);
      if (fallback.text) result = fallback;
    }

    // Hardcoded safety net: if both models return nothing, never leave the user
    // with a blank reply — serve a helpful, on-brand message instead of relying
    // on the AI to always respond.
    const HARDCODED_EMPTY_REPLY = `I couldn't pull that together just now. Try asking me something like "What's on my calendar today?", "When am I free this week?", or "What follow-ups do I have?"`;
    const reply = result.text || HARDCODED_EMPTY_REPLY;

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
    // Graceful hardcoded fallback so the chat box always shows something useful
    // instead of a raw error.
    res.json({
      reply: `I'm having trouble reaching your assistant right now. Your schedule is safe — please try again in a moment.`,
      contextEvents: [],
    });
  }
});


const multer = require('multer');
const upload = multer({ 
  storage: multer.memoryStorage(), 
  limits: { fileSize: 50 * 1024 * 1024 } // 50 MB limit
});

// Shared instruction block for every follow-up recap (voice, audio, text, document).
// Teaches Gemini to count the people the follow-up is actually being sent to and to
// write a singular vs. group message accordingly.
const RECAP_JSON_INSTRUCTIONS = `Return ONLY valid JSON in exactly this shape:
{
  "attendeeCount": <integer — how many people this follow-up will be sent to, i.e. the OTHER participants besides the speaker/author. Use 1 for a one-on-one, 2 or more for a group. Never use 0.>,
  "summary": "2-4 sentence plain-English meeting summary",
  "actionItems": ["one action item per string; include the owner if mentioned"],
  "followUp": "a short, ready-to-send follow-up message to the other attendee(s)"
}

Rules for "followUp":
- If attendeeCount is 1, write a personal one-to-one message. Greet the single person ("Hi <name>," or "Hi," if the name is unknown) and thank them in the singular — say "Thank you", and NEVER "Thank you everyone".
- If attendeeCount is 2 or more, address the group ("Hi everyone,") and you may use "Thank you everyone".
- Keep it concise, warm, and professional.`;

function normalizeRecapResult(parsed, raw) {
  const count = Number(parsed.attendeeCount ?? parsed.attendee_count);
  return {
    attendeeCount: Number.isFinite(count) && count > 0 ? Math.round(count) : 1,
    summary: String(parsed.summary || '').trim() || 'Meeting processed successfully.',
    actionItems: Array.isArray(parsed.actionItems)
      ? parsed.actionItems.map(item => String(item).trim()).filter(Boolean)
      : [],
    followUp: String(parsed.followUp || parsed.follow_up || '').trim(),
    raw,
  };
}

/**
 * Persists a follow-up into the dedicated public.follow_ups table.
 * source: 'voice' | 'audio' | 'text' | 'document'
 * Never throws — logging a follow-up must not fail the request.
 */
async function saveFollowUp({ userId, source, result, transcript, title = 'Meeting Follow-up' }) {
  if (!userId) return { saved: false };
  try {
    const actionItems = Array.isArray(result.actionItems) ? result.actionItems : [];
    // `tasks` is the checklist the to-do screen renders: one { text, done } per
    // action item, individually checkable. `action_items` is kept as the plain
    // string list for the share message and backward compatibility.
    const tasks = actionItems.map((item) => ({ text: String(item), done: false }));

    const { data, error } = await supabaseAdmin
      .from('follow_ups')
      .insert({
        user_id: userId,
        source,
        title,
        summary: result.summary || null,
        action_items: actionItems,
        tasks,
        follow_up_text: result.followUp || null,
        attendee_count: result.attendeeCount || null,
        transcript: transcript || null,
        status: 'open',
      })
      .select('id')
      .single();

    if (error) throw error;
    return { saved: true, id: data?.id || null };
  } catch (err) {
    console.error('❌ [FollowUp] save failed:', err.message);
    return { saved: false, error: err.message };
  }
}

async function summarizeMeetingTranscriptWithGemini(transcript) {
  const prompt = `You are a meeting recap assistant.

Turn this meeting transcript/recap into a clean, structured meeting note:

"""${transcript}"""

${RECAP_JSON_INSTRUCTIONS}`;

  const response = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 1200,
        responseMimeType: 'application/json',
      },
    },
    { timeout: 60000 }
  );

  const raw = response.data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  let parsed;
  try {
    parsed = parseJsonObject(raw);
  } catch (parseError) {
    console.warn('⚠️ [MeetingText] JSON parse failed:', parseError.message);
    parsed = {
      summary: raw.substring(0, 1200) || 'Could not parse the meeting summary.',
      actionItems: [],
      followUp: '',
    };
  }

  return normalizeRecapResult(parsed, raw);
}

/**
 * 📝 Meeting Text Summary
 * Receives: { transcript, userId }
 */
app.post('/api/meetings/summarize-text', validateApiKey, async (req, res) => {
  try {
    const { transcript, userId } = req.body;
    if (!transcript?.trim()) return res.status(400).json({ error: 'Missing transcript' });
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: 'Gemini API key is not configured' });
    }

    console.log(`📝 [MeetingText] Summarizing transcript (${transcript.length} chars)...`);
    const result = await summarizeMeetingTranscriptWithGemini(transcript);

    const saved = await saveFollowUp({ userId, source: 'text', result, transcript });

    console.log(`✅ [MeetingText] Summary complete — ${result.actionItems.length} action items`);
    res.json({ ...result, followUpId: saved?.id || null });
  } catch (error) {
    const errMsg = error.response?.data?.error?.message || error.message;
    console.error('❌ [MeetingText] Error:', errMsg);
    res.status(500).json({ error: `Meeting text summary failed: ${errMsg}` });
  }
});

/**
 * 🎧 Meeting Media Summary (Gemini audio/video understanding)
 * Receives: multipart/form-data with 'media' audio/video file and optional 'userId'
 */
app.post('/api/meetings/summarize-media', validateApiKey, upload.single('media'), async (req, res) => {
  try {
    const file = req.file;
    const { userId } = req.body;

    if (!file) return res.status(400).json({ error: 'No meeting audio uploaded' });
    // Audio only — we do not accept video (e.g. mp4). Recap is built from spoken audio (mp3/m4a/wav).
    if (!file.mimetype?.startsWith('audio/')) {
      return res.status(400).json({ error: 'Please upload an audio file (mp3, m4a, or wav).' });
    }
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: 'Gemini API key is not configured' });
    }

    console.log(`🎧 [MeetingMedia] Summarizing ${file.originalname} (${file.mimetype}, ${file.size} bytes)...`);

    const prompt = `You are a meeting transcription and recap assistant.

Analyze the attached meeting audio. First transcribe the spoken meeting content (use speaker labels if confidently detectable, so you can tell how many people spoke). Then produce a concise recap.

Return ONLY valid JSON in exactly this shape:
{
  "transcript": "plain text transcript of the spoken meeting, speaker labels if confidently detectable",
  "attendeeCount": <integer — how many people this follow-up will be sent to, i.e. the OTHER participants besides the speaker. Use 1 for a one-on-one, 2 or more for a group. Never use 0.>,
  "summary": "2-4 sentence plain-English meeting summary",
  "actionItems": ["one action item per string; include the owner if mentioned"],
  "followUp": "a short, ready-to-send follow-up message to the other attendee(s)"
}

Rules for "followUp":
- If attendeeCount is 1, write a personal one-to-one message. Greet the single person ("Hi <name>," or "Hi," if unknown) and thank them in the singular — say "Thank you", and NEVER "Thank you everyone".
- If attendeeCount is 2 or more, address the group ("Hi everyone,") and you may use "Thank you everyone".
- Keep it concise, warm, and professional.

If speech is unclear, still return valid JSON and explain the limitation in summary.`;

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [{
          parts: [
            { text: prompt },
            { inlineData: { mimeType: file.mimetype, data: file.buffer.toString('base64') } }
          ]
        }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 3000,
          responseMimeType: 'application/json',
        },
      },
      { timeout: 120000 }
    );

    const raw = response.data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    let parsed;
    try {
      parsed = parseJsonObject(raw);
    } catch (parseError) {
      console.warn('⚠️ [MeetingMedia] JSON parse failed:', parseError.message);
      parsed = {
        transcript: '',
        summary: raw.substring(0, 1200) || 'Could not parse the meeting summary.',
        actionItems: [],
        followUp: '',
      };
    }

    const result = {
      ...normalizeRecapResult(parsed, raw),
      transcript: String(parsed.transcript || '').trim(),
    };

    // 'voice' = recorded in-app, 'audio' = uploaded file. Both arrive here.
    const source = req.body.source === 'voice' ? 'voice' : 'audio';
    const saved = await saveFollowUp({
      userId,
      source,
      result,
      transcript: result.transcript || `Uploaded meeting audio: ${file.originalname}`,
    });

    console.log(`✅ [MeetingMedia] Summary complete — ${result.actionItems.length} action items`);
    res.json({ ...result, followUpId: saved?.id || null });
  } catch (error) {
    const errMsg = error.response?.data?.error?.message || error.message;
    console.error('❌ [MeetingMedia] Error:', errMsg);
    res.status(500).json({ error: `Meeting media summary failed: ${errMsg}` });
  }
});

/**
 * 📄 Meeting Document Follow-up (PDF / Docs / minutes of meeting)
 * Receives: multipart/form-data with 'document' file and optional 'userId'
 * Produces the same follow-up recap shape as the text/audio paths.
 */
app.post('/api/meetings/summarize-document', validateApiKey, upload.array('document', 10), async (req, res) => {
  try {
    const files = req.files || [];
    const { userId } = req.body;

    if (files.length === 0) return res.status(400).json({ error: 'No document uploaded' });
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: 'Gemini API key is not configured' });
    }

    console.log(`📄 [MeetingDoc] Summarizing ${files.length} document(s): ${files.map((f) => f.originalname).join(', ')} ...`);

    const prompt = `You are a meeting recap assistant.

The attached document(s) are meeting notes, minutes of meeting, agendas, or recaps. Read them all carefully and produce a single clean follow-up that covers everything across them.

${RECAP_JSON_INSTRUCTIONS}`;

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [{
          parts: [
            { text: prompt },
            ...files.map((file) => ({
              inlineData: { mimeType: file.mimetype, data: file.buffer.toString('base64') },
            }))
          ]
        }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 1500,
          responseMimeType: 'application/json',
        },
      },
      { timeout: 120000 }
    );

    const raw = response.data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    let parsed;
    try {
      parsed = parseJsonObject(raw);
    } catch (parseError) {
      console.warn('⚠️ [MeetingDoc] JSON parse failed:', parseError.message);
      parsed = {
        summary: raw.substring(0, 1200) || 'Could not parse the document.',
        actionItems: [],
        followUp: '',
      };
    }

    const result = normalizeRecapResult(parsed, raw);

    const saved = await saveFollowUp({
      userId,
      source: 'document',
      result,
      transcript: `Uploaded meeting document(s): ${files.map((f) => f.originalname).join(', ')}`,
    });

    console.log(`✅ [MeetingDoc] Summary complete — ${result.actionItems.length} action items`);
    res.json({ ...result, followUpId: saved?.id || null });
  } catch (error) {
    const errMsg = error.response?.data?.error?.message || error.message;
    console.error('❌ [MeetingDoc] Error:', errMsg);
    res.status(500).json({ error: `Meeting document summary failed: ${errMsg}` });
  }
});

/**
 * ⏰ Schedule a WhatsApp follow-up reminder to the user (themselves only).
 * Receives: { userId, date (YYYY-MM-DD), time (HH:MM 24h), timezone, body }
 * Saves the reminder on the follow_up row. If the n8n pipeline is wired it
 * also hands off a scheduled job; the actual WhatsApp send (MSG91 template) is
 * a later integration, so a missing/failing webhook never fails the request.
 */
app.post('/api/follow-ups/:id/whatsapp-reminder', validateApiKey, async (req, res) => {
  try {
    const { id } = req.params;
    const { userId, date, time, timezone, body } = req.body;

    if (!id || !userId) return res.status(400).json({ scheduled: false, reason: 'missing_fields', error: 'Missing follow-up id or userId' });
    if (!date || !time) return res.status(400).json({ scheduled: false, reason: 'missing_fields', error: 'Missing reminder date or time' });

    const messageBody = String(body || '').trim();
    if (!messageBody) return res.status(400).json({ scheduled: false, reason: 'missing_fields', error: 'Reminder message body is required' });

    const tz = timezone || 'Asia/Kolkata';
    let remindAt;
    try {
      remindAt = localDateTimeToUtc(date, time, tz);
    } catch {
      return res.status(400).json({ scheduled: false, reason: 'invalid_datetime', error: 'Invalid reminder date/time' });
    }
    if (remindAt <= new Date()) {
      return res.status(400).json({ scheduled: false, reason: 'past_time', error: 'Reminder time must be in the future' });
    }

    // The reminder goes to the user's own WhatsApp number.
    const { data: profile } = await supabaseAdmin
      .from('users')
      .select('phone, name')
      .eq('firebase_uid', userId)
      .maybeSingle();
    const userPhone = cleanPhoneNumber(profile?.phone);
    if (!userPhone) return res.status(400).json({ scheduled: false, reason: 'no_phone', error: 'No phone number on your profile' });

    // Persist the reminder on the follow-up row.
    const { error: updateError } = await supabaseAdmin
      .from('follow_ups')
      .update({
        reminder_status: 'scheduled',
        reminder_at: remindAt.toISOString(),
        reminder_body: messageBody,
        reminder_to: userPhone,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('user_id', userId);
    if (updateError) throw updateError;

    // Hand the scheduled job to n8n only if the pipeline is wired. The WhatsApp
    // send (MSG91 template) is a later integration, so a missing/failing
    // webhook must NOT fail the user's action — the reminder is already saved.
    if (process.env.N8N_WHATSAPP_WEBHOOK_URL) {
      try {
        await sendWhatsAppReminderJobToN8n({
          type: 'follow_up_reminder',
          follow_up_id: id,
          user_id: userId,
          user_name: profile?.name || 'there',
          body: messageBody,
          to: userPhone,
          user_phone: userPhone,
          recipient_phones: [userPhone],
          timezone: tz,
          whatsapp_reminder_at: remindAt.toISOString(),
          template_name: process.env.MSG91_FOLLOWUP_TEMPLATE_NAME || 'followup_reminder',
        });
      } catch (n8nErr) {
        console.warn('⚠️ [FollowUpReminder] n8n push failed (reminder still saved):', n8nErr.response?.data || n8nErr.message);
      }
    }

    console.log(`✅ [FollowUpReminder] Scheduled for ${userPhone} at ${remindAt.toISOString()}`);
    res.json({ scheduled: true, reminder_at: remindAt.toISOString(), to: userPhone });
  } catch (error) {
    console.error('❌ [FollowUpReminder] Error:', error.message);
    res.status(500).json({ scheduled: false, reason: 'server_error', error: 'Failed to schedule follow-up reminder' });
  }
});

/**
 * 📄 Analyze Document (Gemini 2.5 Pro Vision)
 * Receives: multipart/form-data with 'document' file and 'userId'
 */
app.post('/api/analyze-document', validateApiKey, upload.array('document', 10), async (req, res) => {
  try {
    const files = req.files || [];
    const { userId } = req.body;

    if (files.length === 0) return res.status(400).json({ error: 'No document uploaded' });

    console.log(`📄 [Document] Analyzing ${files.length} document(s): ${files.map((f) => f.originalname).join(', ')} ...`);

    const prompt = `Analyze the attached document(s) carefully.

First, extract any important dates, deadlines, meetings, events, or appointments mentioned across all of them.

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
            ...files.map((file) => ({
              inlineData: { mimeType: file.mimetype, data: file.buffer.toString('base64') },
            }))
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
        transcript: 'Uploaded Documents: ' + files.map((f) => f.originalname).join(', '),
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
        name: 'user_meeting_confirmation_v2',
        language: { code: 'en', policy: 'deterministic' },
        namespace: process.env.MSG91_TEMPLATE_NAMESPACE || null,
        to_and_components: [{
          to,
          components: {
            header_1:          { type: 'image', value: headerImg },
            body_time:         { type: 'text', value: time,         parameter_name: 'time' },
            body_date:         { type: 'text', value: date,         parameter_name: 'date' },
            body_name:         { type: 'text', value: name,         parameter_name: 'name' },
            body_meeting_link: { type: 'text', value: meeting_link, parameter_name: 'meeting_link' },
            body_person:       { type: 'text', value: person,       parameter_name: 'person' }
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
        name: 'invitee_meeting_confirmation_v2',
        language: { code: 'en', policy: 'deterministic' },
        namespace: process.env.MSG91_TEMPLATE_NAMESPACE || null,
        to_and_components: [{
          to,
          components: {
            header_1:          { type: 'image', value: headerImg },
            body_time:         { type: 'text', value: time,         parameter_name: 'time' },
            body_name:         { type: 'text', value: person,       parameter_name: 'name' },   // template: "{{body_name}} has invited you" → host name
            body_meeting_link: { type: 'text', value: meeting_link, parameter_name: 'meeting_link' },
            body_person:       { type: 'text', value: name,         parameter_name: 'person' }, // template: "Hi {{body_person}}" → invitee name
            body_date:         { type: 'text', value: date,         parameter_name: 'date' }
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

async function sendMeetingReminderUserWA({ to, name, date, time, person, meeting_link, reminder_time, header_image }) {
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
        name: 'user_meeting_reminder_v2',
        language: { code: 'en', policy: 'deterministic' },
        namespace: process.env.MSG91_TEMPLATE_NAMESPACE || null,
        to_and_components: [{
          to,
          components: {
            header_1:           { type: 'image', value: headerImg },
            body_reminder_time: { type: 'text', value: reminder_time || '30 minutes', parameter_name: 'reminder_time' },
            body_time:          { type: 'text', value: time, parameter_name: 'time' },
            body_date:          { type: 'text', value: date, parameter_name: 'date' },
            body_name:          { type: 'text', value: name, parameter_name: 'name' },
            body_person:        { type: 'text', value: person, parameter_name: 'person' },
            body_meeting_link:  { type: 'text', value: meeting_link, parameter_name: 'meeting_link' }
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

async function sendMeetingReminderInviteeWA({ to, name, date, time, person, meeting_link, header_image }) {
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
        name: 'invitee_meeting_reminder_v2',
        language: { code: 'en', policy: 'deterministic' },
        namespace: process.env.MSG91_TEMPLATE_NAMESPACE || null,
        to_and_components: [{
          to,
          components: {
            header_1:          { type: 'image', value: headerImg },
            body_person:       { type: 'text', value: name,         parameter_name: 'person' }, // template: "Hi {{body_person}}" → invitee name
            body_meeting_link: { type: 'text', value: meeting_link, parameter_name: 'meeting_link' },
            body_name:         { type: 'text', value: person,       parameter_name: 'name' },   // template: "{{body_name}} invited you" → host name
            body_time:         { type: 'text', value: time,         parameter_name: 'time' },
            body_date:         { type: 'text', value: date,         parameter_name: 'date' }
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

    const firstAttendee = Array.isArray(event?.attendees) && event.attendees.length > 0 ? event.attendees[0] : null;
    const recipients = Array.isArray(req.body.to) && req.body.to.length > 0
      ? req.body.to
      : Array.isArray(req.body.recipient_phones) && req.body.recipient_phones.length > 0
        ? req.body.recipient_phones
        : [event?.user_phone, firstAttendee ? firstAttendee.phone : null].filter(Boolean);

    const to = recipients.map(cleanPhoneNumber).filter(Boolean);
    const name = req.body.name || 'Member';
    const person = req.body.person || req.body.attendee_name || (firstAttendee ? firstAttendee.name : 'Team');
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


// ─── Reminder Dispatch Job (templates 3 & 4) ─────────────────────────
/**
 * 🕒 POST /api/reminders/send-job
 *
 * Called by n8n at T-minus the meeting. Sends the 30-min reminder to BOTH
 * parties (template 3 → user, template 4 → invitee) — but only if the meeting
 * is still confirmed. A cancelled meeting is skipped, never reminded.
 *
 * Auth: x-shared-secret (n8n) or x-api-key (manual testing).
 *
 * Body: { "event_id": "uuid" }
 */
app.post('/api/reminders/send-job', validateApiKeyOrN8nSecret, async (req, res) => {
  const eventId = req.body.event_id || req.body.eventId || null;

  if (!eventId) {
    return res.status(400).json({ success: false, error: 'event_id is required' });
  }

  try {
    const { data: event, error } = await supabase
      .from('extracted_events')
      .select('*')
      .eq('id', eventId)
      .single();

    if (error || !event) {
      return res.status(404).json({ success: false, error: 'Event not found' });
    }

    // Cancellation guard — the whole reason this endpoint exists.
    if (event.status === 'cancelled') {
      console.log(`🚫 [Reminders:send-job] event=${eventId} cancelled — skipping`);
      return res.json({ success: true, skipped: true, reason: 'Meeting has been cancelled by user' });
    }

    if (event.status !== 'confirmed') {
      console.log(`⏭️  [Reminders:send-job] event=${eventId} status=${event.status} — skipping`);
      return res.json({ success: true, skipped: true, reason: 'event_not_confirmed', status: event.status });
    }

    // Idempotency — don't re-send if both reminders already went out.
    if (event.user_reminder_status === 'sent' && event.invitee_reminder_status === 'sent') {
      return res.json({ success: true, skipped: true, reason: 'reminder_already_sent' });
    }

    const userPhone = cleanPhoneNumber(event.user_phone);
    const firstAttendee = Array.isArray(event.attendees) && event.attendees.length > 0 ? event.attendees[0] : null;
    const attendeePhone = firstAttendee ? cleanPhoneNumber(firstAttendee.phone) : null;
    const prettyDate = formatDisplayDate(event.event_date);
    const prettyTime = formatDisplayTime(event.event_time);
    const userWaName = event.user_name || 'Member';
    const inviteeWaName = firstAttendee?.name || 'Guest';
    const meetingLink = req.body.meeting_link || event.meeting_link || 'See calendar invite';

    const update = {};
    const result = { user: null, invitee: null };

    if (userPhone) {
      try {
        result.user = await sendMeetingReminderUserWA({
          to: [userPhone],
          name: userWaName,
          date: prettyDate,
          time: prettyTime,
          person: inviteeWaName,
        });
        update.user_reminder_status = 'sent';
        update.user_reminder_sent_at = new Date().toISOString();
      } catch (waErr) {
        console.error('❌ [Reminders:send-job] user reminder failed:', waErr.response?.data || waErr.message);
        update.user_reminder_status = 'failed';
      }
    }

    if (attendeePhone) {
      try {
        result.invitee = await sendMeetingReminderInviteeWA({
          to: [attendeePhone],
          name: inviteeWaName,
          date: prettyDate,
          time: prettyTime,
          person: userWaName,
          meeting_link: meetingLink,
        });
        update.invitee_reminder_status = 'sent';
        update.invitee_reminder_sent_at = new Date().toISOString();
      } catch (waErr) {
        console.error('❌ [Reminders:send-job] invitee reminder failed:', waErr.response?.data || waErr.message);
        update.invitee_reminder_status = 'failed';
      }
    }

    // Keep the legacy single-channel column in sync for older dashboards/queries.
    const anySent = update.user_reminder_status === 'sent' || update.invitee_reminder_status === 'sent';
    if (anySent) {
      update.whatsapp_reminder_status = 'sent';
      update.whatsapp_sent_at = new Date().toISOString();
      update.reminder_error = null;
    }

    await supabase.from('extracted_events').update(update).eq('id', eventId);

    return res.json({
      success: true,
      skipped: false,
      event_id: eventId,
      user_reminder_status: update.user_reminder_status || 'skipped',
      invitee_reminder_status: update.invitee_reminder_status || 'skipped',
      msg91: result,
    });
  } catch (err) {
    const errorMessage = err.response?.data || err.message;
    console.error('❌ [Reminders:send-job] error:', errorMessage);
    return res.status(500).json({ success: false, error: errorMessage });
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
  const { userId, eventId, title, date, time, person, meeting_link, source } = req.body;
  const logCtx = `[WhatsApp:confirm] source=${source || 'unknown'} userId=${userId} eventId=${eventId || 'none'}`;

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

    let cleanPhone = userData.phone.replace(/\D/g, '');
    if (cleanPhone.length === 10) cleanPhone = '91' + cleanPhone;

    // 2️⃣ Duplicate check — look for recent extracted_event already confirmed & sent
    let existingEvent = null;
    if (eventId) {
      const { data, error: evErr } = await supabase
        .from('extracted_events')
        .select('id, user_confirmation_status')
        .eq('id', eventId)
        .maybeSingle();
      if (!evErr && data) {
        existingEvent = data;
      }
    } else {
      const { data, error: evErr } = await supabase
        .from('extracted_events')
        .select('id, user_confirmation_status')
        .eq('user_phone', cleanPhone)
        .eq('event_title', title)
        .eq('event_date', date)
        .eq('event_time', time)
        .eq('user_confirmation_status', 'sent')
        .maybeSingle();
      if (!evErr && data) {
        existingEvent = data;
      }
    }

    if (existingEvent && existingEvent.user_confirmation_status === 'sent') {
      console.warn(`⚠️ ${logCtx} Duplicate: WhatsApp already sent for event ${eventId || title}`);
      return res.json({ sent: false, reason: 'already_sent', phone: `+${cleanPhone}` });
    }

    // 3️⃣ Format fields for the WhatsApp template
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

    // 5️⃣ Update confirmation state in extracted_events
    const targetEventId = eventId || existingEvent?.id;
    if (targetEventId) {
      try {
        await supabase
          .from('extracted_events')
          .update({
            user_confirmation_status: 'sent',
            user_confirmation_sent_at: new Date().toISOString(),
            meeting_link: waMeetingLink !== 'See calendar invite' ? waMeetingLink : undefined,
          })
          .eq('id', targetEventId);
        console.log(`✅ ${logCtx} Updated user_confirmation_status in extracted_events.`);
      } catch (dbUpdateErr) {
        console.warn(`⚠️ ${logCtx} Could not update extracted_events state:`, dbUpdateErr.message);
      }
    }

    // 6️⃣ Mark as sent in voice_logs (upsert — graceful if column doesn't exist)
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
/**
 * 📲 Endpoint called when user manually types or updates an invitee's WhatsApp number.
 * Updates the attendees JSONB array, upserts the contact book, and fires the pending confirmation.
 *
 * POST /api/events/:id/invitee-phone
 */
app.post('/api/events/:id/invitee-phone', validateApiKey, async (req, res) => {
  const eventId = req.params.id;
  const { phone, name } = req.body;

  if (!phone || !name) {
    return res.status(400).json({ error: 'Missing phone or name in request body' });
  }

  try {
    // 1. Fetch current event
    const { data: event, error: fetchErr } = await supabase
      .from('extracted_events')
      .select('*')
      .eq('id', eventId)
      .single();

    if (fetchErr || !event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    const cleanPhone = cleanPhoneNumber(phone);
    const attendees = Array.isArray(event.attendees) ? event.attendees : [];

    // Find attendee by name (case-insensitive)
    let index = attendees.findIndex(a => String(a.name).trim().toLowerCase() === String(name).trim().toLowerCase());
    if (index === -1 && attendees.length === 1) {
      // If only one attendee exists, fallback to index 0
      index = 0;
    }

    // Idempotency: if this attendee is already confirmed on the same number,
    // don't send the WhatsApp invite again (the frontend may submit on both the
    // capture form and the confirm action).
    const existingAttendee = index !== -1 ? attendees[index] : null;
    const alreadyConfirmed = Boolean(
      existingAttendee &&
      cleanPhoneNumber(existingAttendee.phone) === cleanPhone &&
      (existingAttendee.confirmation_status === 'confirmed' || existingAttendee.confirmation_status === 'sent')
    );

    if (index !== -1) {
      attendees[index].name = name.trim();   // overwrite stale AI name with the user-edited name
      attendees[index].phone = cleanPhone;
      attendees[index].phone_source = attendees[index].phone_source || 'user_typed';
    } else {
      attendees.push({
        name: name.trim(),
        phone: cleanPhone,
        confirmation_status: 'pending',
        confirmation_sent_at: null,
        reminder_status: 'pending',
        reminder_sent_at: null,
        phone_source: 'user_typed'
      });
      index = attendees.length - 1;
    }

    // 2. Save phone back to event
    await supabase
      .from('extracted_events')
      .update({ attendees })
      .eq('id', eventId);

    // 3. Save/Upsert to contact book lookup
    if (event.user_phone) {
      const { data: userData } = await supabase
        .from('users')
        .select('firebase_uid')
        .eq('phone', event.user_phone)
        .maybeSingle();

      const userId = userData?.firebase_uid || 'dev-expo-anonymous';

      await supabase.from('contacts').upsert({
        user_id: userId,
        name: attendees[index].name,
        phone: cleanPhone
      }, { onConflict: 'user_id,name' });
    }

    // Already confirmed on this number — phone/contact are saved, skip the resend.
    if (alreadyConfirmed) {
      return res.json({ success: true, alreadySent: true, attendee: attendees[index] });
    }

    // 4. Send invitee_meeting_confirmation_v2 immediately
    const prettyDate = formatDisplayDate(event.event_date);
    const prettyTime = formatDisplayTime(event.event_time);
    const meetingLink = event.meeting_link || 'See calendar invite';
    const userWaName = event.user_name || 'Member';

    let success = false;
    try {
      await sendMeetingInvitationWA({
        to: [cleanPhone],
        name: name.trim(),   // use the req.body name (user-edited), not the stale DB value
        date: prettyDate,
        time: prettyTime,
        person: userWaName,
        meeting_link: meetingLink,
      });

      attendees[index].confirmation_status = 'confirmed';
      attendees[index].confirmation_sent_at = new Date().toISOString();
      success = true;
    } catch (waErr) {
      console.error('❌ [invitee-phone] Failed to send MSG91 confirmation:', waErr.response?.data || waErr.message);
      attendees[index].confirmation_status = 'failed';
    }

    // 5. Update confirmation statuses in database
    await supabase
      .from('extracted_events')
      .update({
        attendees,
        invitee_confirmation_status: success ? 'sent' : 'failed',
        invitee_confirmation_sent_at: success ? new Date().toISOString() : null
      })
      .eq('id', eventId);

    return res.json({ success: true, attendee: attendees[index] });
  } catch (error) {
    console.error('❌ [invitee-phone] Error:', error);
    return res.status(500).json({ error: error.message });
  }
});

/**
 * 🕒 Cron/n8n triggered User reminder endpoint.
 *
 * POST /api/reminders/user/:event_id
 */
app.post('/api/reminders/user/:event_id', validateApiKeyOrN8nSecret, async (req, res) => {
  const eventId = req.params.event_id;

  try {
    const { data: event, error } = await supabase
      .from('extracted_events')
      .select('*')
      .eq('id', eventId)
      .single();

    if (error || !event) {
      return res.status(404).json({ success: false, error: 'Event not found' });
    }

    if (event.status === 'cancelled') {
      return res.json({ success: true, skipped: true, reason: 'event_cancelled' });
    }

    if (event.user_reminder_status === 'sent') {
      return res.json({ success: true, skipped: true, reason: 'already_sent' });
    }

    const userPhone = cleanPhoneNumber(event.user_phone);
    if (!userPhone) {
      return res.status(400).json({ success: false, error: 'User phone number not found' });
    }

    const prettyDate = formatDisplayDate(event.event_date);
    const prettyTime = formatDisplayTime(event.event_time);
    const invitees = Array.isArray(event.attendees) ? event.attendees : [];
    const firstInviteeName = invitees[0]?.name || 'Guest';

    let success = false;
    try {
      await sendMeetingReminderUserWA({
        to: [userPhone],
        name: 'Member',
        date: prettyDate,
        time: prettyTime,
        person: firstInviteeName,
        meeting_link: event.meeting_link || 'See calendar invite',
        reminder_time: '30 minutes'
      });
      success = true;
    } catch (waErr) {
      console.error('❌ [Reminders:User] Outbound failed:', waErr.response?.data || waErr.message);
    }

    await supabase
      .from('extracted_events')
      .update({
        user_reminder_status: success ? 'sent' : 'failed',
        user_reminder_sent_at: success ? new Date().toISOString() : null
      })
      .eq('id', eventId);

    return res.json({ success });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * 🕒 Cron/n8n triggered Invitee reminder endpoint.
 *
 * POST /api/reminders/invitee/:event_id
 */
app.post('/api/reminders/invitee/:event_id', validateApiKeyOrN8nSecret, async (req, res) => {
  const eventId = req.params.event_id;

  try {
    const { data: event, error } = await supabase
      .from('extracted_events')
      .select('*')
      .eq('id', eventId)
      .single();

    if (error || !event) {
      return res.status(404).json({ success: false, error: 'Event not found' });
    }

    if (event.status === 'cancelled') {
      return res.json({ success: true, skipped: true, reason: 'event_cancelled' });
    }

    if (event.invitee_reminder_status === 'sent') {
      return res.json({ success: true, skipped: true, reason: 'already_sent' });
    }

    const attendees = Array.isArray(event.attendees) ? event.attendees : [];
    if (attendees.length === 0) {
      await supabase
        .from('extracted_events')
        .update({ invitee_reminder_status: 'skipped' })
        .eq('id', eventId);
      return res.json({ success: true, skipped: true, reason: 'no_invitees' });
    }

    const prettyDate = formatDisplayDate(event.event_date);
    const prettyTime = formatDisplayTime(event.event_time);
    const meetingLink = event.meeting_link || 'See calendar invite';
    const userWaName = event.user_name || 'Member';

    let anySent = false;
    let hasPendingPhone = false;

    for (let i = 0; i < attendees.length; i++) {
      const attendee = attendees[i];
      const attendeePhone = cleanPhoneNumber(attendee.phone);

      if (!attendeePhone) {
        attendee.reminder_status = 'skipped';
        hasPendingPhone = true;
        continue;
      }

      if (attendee.reminder_status === 'sent') {
        anySent = true;
        continue;
      }

      try {
        await sendMeetingReminderInviteeWA({
          to: [attendeePhone],
          name: attendee.name,
          date: prettyDate,
          time: prettyTime,
          person: userWaName,
          meeting_link: meetingLink
        });
        attendee.reminder_status = 'sent';
        attendee.reminder_sent_at = new Date().toISOString();
        anySent = true;
      } catch (waErr) {
        console.error(`❌ [Reminders:Invitee] Failed for ${attendee.name}:`, waErr.response?.data || waErr.message);
        attendee.reminder_status = 'failed';
      }
    }

    let inviteeReminderStatus = 'failed';
    if (anySent) {
      inviteeReminderStatus = hasPendingPhone ? 'pending' : 'sent';
    } else if (hasPendingPhone) {
      inviteeReminderStatus = 'pending';
    }

    await supabase
      .from('extracted_events')
      .update({
        attendees,
        invitee_reminder_status: inviteeReminderStatus,
        invitee_reminder_sent_at: anySent ? new Date().toISOString() : null
      })
      .eq('id', eventId);

    return res.json({ success: anySent, attendees });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
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
    const firstAttendee = Array.isArray(event.attendees) && event.attendees.length > 0 ? event.attendees[0] : null;
    const attendeePhone = firstAttendee ? cleanPhoneNumber(firstAttendee.phone) : null;
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
      attendeeName: firstAttendee ? firstAttendee.name : 'Guest',
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
    const { accessToken, userId, title, description, date, time, durationMinutes, timeZone, location } = req.body;
    
    let token = accessToken;
    if (!token && userId) {
      console.log(`🔑 [Google] Missing accessToken. Fetching stored token for userId: ${userId}...`);
      token = await getGoogleAccessToken(userId);
    }

    if (!token) return res.status(400).json({ error: 'Missing Google access token or unable to retrieve stored token for user' });
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
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'popup', minutes: 60 } // Exactly 1 hour before meeting, as requested!
        ]
      }
    };

    const response = await axios.post(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1',
      event,
      {
        headers: {
          Authorization: `Bearer ${token}`,
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

function htmlToReadableText(html) {
  let text = decodeHtmlEntities(String(html || ''));

  for (let i = 0; i < 3; i += 1) {
    text = stripHtmlTemplateNoise(text);
    text = decodeHtmlEntities(text);
  }

  return text
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(line => line && !isTemplateCodeLine(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&rsquo;|&lsquo;/gi, "'")
    .replace(/&rdquo;|&ldquo;/gi, '"')
    .replace(/&ndash;|&mdash;/gi, '-')
    .replace(/&#(\d+);/g, (_, code) => {
      const valueCode = Number(code);
      return Number.isFinite(valueCode) ? String.fromCharCode(valueCode) : ' ';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => {
      const valueCode = parseInt(code, 16);
      return Number.isFinite(valueCode) ? String.fromCharCode(valueCode) : ' ';
    });
}

function stripHtmlTemplateNoise(value) {
  return String(value || '')
    .replace(/<!doctype[\s\S]*?>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<img\b[^>]*>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/td|\/th|h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '$2')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\{[^{}]{0,500}\}/g, ' ')
    .replace(/\b(?:font-family|font-size|line-height|padding|margin|border|color|background|width|height|display|text-align|border-radius|box-sizing)\s*:\s*[^;]+;/gi, ' ')
    .replace(/https?:\/\/\S{80,}/gi, ' ');
}

function isTemplateCodeLine(line) {
  if (/[<>]/.test(line)) return true;
  if (/(doctype|html|body|table|tbody|thead|tr|td|font-family|border-collapse|mso-|webkit|@media|class=|style=)/i.test(line)) return true;
  const codeChars = (line.match(/[{};=<>]/g) || []).length;
  return line.length > 40 && codeChars / line.length > 0.08 && !/[?.!,]/.test(line);
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
    body = htmlToReadableText(body);
  } else {
    body = body.replace(/\s+/g, ' ').trim();
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

const REPLY_REQUEST_PATTERNS = [
  'please reply', 'please respond', 'waiting for your reply', 'awaiting your reply',
  'waiting for your response', 'awaiting your response', 'let me know',
  'please let me know', 'can you', 'could you', 'would you', 'are you available',
  'available for', 'confirm', 'please confirm', 'approve', 'approval',
  'your thoughts', 'what do you think', 'feedback', 'review this', 'need your',
  'need you to', 'follow up', 'schedule', 'meeting', 'call', 'question',
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

function parseEmailAddress(value) {
  return String(value || '').match(/<([^>]+)>/)?.[1]?.trim().toLowerCase() || String(value || '').trim().toLowerCase();
}

function looksLikeReplyRequest(email) {
  const subject = String(email.subject || '').toLowerCase();
  const snippet = String(email.snippet || '').toLowerCase();
  const text = `${subject} ${snippet}`;
  if (text.includes('?')) return true;
  return REPLY_REQUEST_PATTERNS.some((pattern) => text.includes(pattern));
}

app.get('/api/gmail/inbox', validateApiKey, async (req, res) => {
  try {
    const { userId, days } = req.query;
    const mode = req.query.mode === 'all' ? 'all' : 'important';
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
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - dayCount);
    cutoff.setHours(0, 0, 0, 0);
    const gmailAfter = `${cutoff.getFullYear()}/${String(cutoff.getMonth() + 1).padStart(2, '0')}/${String(cutoff.getDate()).padStart(2, '0')}`;
    const gmail = getGmailClient(account.access_token);
    const userEmail = account.gmail_email?.toLowerCase() || '';

    // Search the full inbox across Primary, Promotions, Social, Updates, and Forums.
    const messages = [];
    let pageToken;
    const maxMessages = mode === 'all' ? 200 : 160;

    do {
      const listRes = await gmail.users.messages.list({
        userId: 'me',
        q: `in:inbox after:${gmailAfter} -in:spam -in:trash`,
        maxResults: Math.min(100, maxMessages - messages.length),
        pageToken,
      });

      messages.push(...(listRes.data.messages || []));
      pageToken = listRes.data.nextPageToken;
    } while (pageToken && messages.length < maxMessages);

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
          const headerDate = getHeader(headers, 'Date');
          const internalTimestamp = Number(detail.data.internalDate || 0);
          const date = headerDate || (internalTimestamp ? new Date(internalTimestamp).toISOString() : '');
          const labels = detail.data.labelIds || [];

          const senderMatch = from.match(/^"?([^"]+)"?\s*<(.+)>$/);
          const senderName = senderMatch ? senderMatch[1].trim() : from.split('@')[0];
          const senderEmail = parseEmailAddress(senderMatch ? senderMatch[2] : from);

          return {
            id: msg.id,
            threadId: msg.threadId,
            subject: subject || '(no subject)',
            senderName: senderName || 'Unknown',
            senderEmail: senderEmail || '',
            date,
            internalDate: internalTimestamp,
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
      const receivedAtMs = e.internalDate || new Date(e.date || 0).getTime();
      if (!receivedAtMs || Number.isNaN(receivedAtMs) || receivedAtMs < cutoff.getTime()) return false;
      if (!Array.isArray(e.labels) || !e.labels.includes('INBOX')) return false;
      if (e.labels.includes('SPAM') || e.labels.includes('TRASH') || e.labels.includes('DRAFT') || e.labels.includes('SENT')) return false;
      if (e.senderEmail && userEmail && e.senderEmail === userEmail) return false;
      return true;
    });

    // Filter 2: For each thread, mark whether the last message needs the user's reply.
    const inboxItems = [];
    await Promise.all(
      filtered.map(async (email) => {
        try {
          const thread = await gmail.users.threads.get({
            userId: 'me',
            id: email.threadId,
          });

          const threadMessages = thread.data.messages || [];
          if (threadMessages.length === 0) {
            if (mode === 'all') inboxItems.push({ ...email, replyNeeded: false });
            return;
          }

          const lastMsg = threadMessages[threadMessages.length - 1];
          const lastHeaders = lastMsg.payload?.headers || [];
          const lastFrom = getHeader(lastHeaders, 'From').toLowerCase();

          const lastMessageIsFromUser = userEmail && lastFrom.includes(userEmail);
          const replyRequested = looksLikeReplyRequest(email);
          const isBulk = isAutoEmail(email.senderEmail, email.senderName, email.subject, email.labels);
          const replyNeeded = !lastMessageIsFromUser && replyRequested && !isBulk;

          if (mode === 'important' && !replyNeeded) return;

          inboxItems.push({
            ...email,
            replyNeeded,
            replyReason: replyNeeded ? 'Waiting for your reply' : null,
          });
        } catch (e) {
          if (mode === 'all') {
            inboxItems.push({ ...email, replyNeeded: false });
          } else if (looksLikeReplyRequest(email)) {
            inboxItems.push({ ...email, replyNeeded: true, replyReason: 'Waiting for your reply' });
          }
        }
      })
    );

    // Sort by date desc
    inboxItems.sort((a, b) => (b.internalDate || new Date(b.date || 0).getTime()) - (a.internalDate || new Date(a.date || 0).getTime()));

    res.json({
      emails: inboxItems.slice(0, mode === 'all' ? 50 : 30),
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
    const safeEmailBody = String(emailBody || '').trim() || `Subject: ${subject || 'No subject'}\nFrom: ${senderName || 'Sender'}\nNo readable body was available. Draft a brief professional reply asking for any missing details if needed.`;

    const fullName = userName || 'Shyanil Mishra';
    const prompt = `You are a professional email assistant. Draft a polished, professional reply to this email.

Context:
- Subject: ${subject || 'N/A'}
- From: ${senderName || 'Sender'}
- Tone: ${tone || 'professional and friendly'}
- Your name: ${fullName}

Original email:
"""
${safeEmailBody}
"""

Instructions:
1. Write a complete reply that directly addresses the sender's request or question
2. Keep it professional, clear, and useful; usually 4-7 sentences unless the email is very simple
3. If the email asks for confirmation, availability, feedback, approval, or information, answer in a way the user can quickly edit
4. Do not sound robotic; use natural business language
5. End with this exact closing format:
Best regards,
${fullName}
6. Do NOT include calendar invite links, meeting URLs, or video call links in the reply text. Those are shared separately.
7. Do NOT include a subject line
8. Return ONLY the reply text, no explanations

Draft reply:`;

    const model = selectModel(safeEmailBody);
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 500 },
      }
    );

    const reply = response.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!reply) {
      return res.status(502).json({ error: 'AI did not return a reply. Please try again.' });
    }

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
