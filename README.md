# Virtual Assistant Backend

Node.js Express backend that handles AI processing for the Virtual Assistant mobile app.
It proxies requests to Google Cloud Speech-to-Text and Gemini 2.5 models, and securely logs actions to Supabase.

## Setup
1. `npm install`
2. Create a `.env` file with the necessary API keys (Google, Gemini, Supabase).
3. `npm start` (or `node index.js`)

## n8n WhatsApp Reminder Flow

Required backend env:

```env
N8N_WHATSAPP_WEBHOOK_URL=
N8N_SHARED_SECRET=
```

`N8N_SHARED_SECRET` is generated locally and must also be used as the `x-shared-secret` header in n8n when n8n calls the backend result endpoint.

The project has two `.env` files on purpose:

- Root `.env`: frontend/Expo values such as `EXPO_PUBLIC_*`.
- `backend/.env`: backend-only values such as backend API keys and n8n webhook settings.

Keep `N8N_WHATSAPP_WEBHOOK_URL` only in `backend/.env`; the frontend does not need it.

### Test Order

1. For the first webhook-body test, set `N8N_WHATSAPP_WEBHOOK_URL` in `backend/.env` to a temporary Webhook.site URL or an n8n Test Webhook URL.
2. Restart the backend with `npm start`.
3. Confirm an existing `extracted_events` row:

```bash
curl -X PATCH http://localhost:3000/api/events/YOUR_EVENT_ID/confirm \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_BACKEND_API_KEY" \
  -d '{
    "customer_name": "Rahul",
    "customer_phone": "+919999999999",
    "event_title": "Sales Call",
    "meeting_time": "2026-05-04T17:00:00+05:30"
  }'
```

4. Check the backend response. It includes `n8n_triggered` and the exact `n8n_payload`.
5. Check Webhook.site or the n8n test execution. You should see the same JSON body and the `x-shared-secret` header.
6. Manually test n8n's result callback:

```bash
curl -X POST http://localhost:3000/api/reminders/whatsapp-result \
  -H "Content-Type: application/json" \
  -H "x-shared-secret: YOUR_N8N_SHARED_SECRET" \
  -d '{
    "event_id": "YOUR_EVENT_ID",
    "status": "sent"
  }'
```

7. Verify Supabase changed `whatsapp_reminder_status` to `sent` and filled `whatsapp_sent_at`.

The confirm endpoint saves the event update in Supabase before it calls n8n. If Supabase rejects the anon-key update because of row-level security, the request will stop with a database error and n8n will not be called.

If `whatsapp_reminder_at` is already in the past, the backend marks the reminder as `skipped` and does not call n8n. For a quick wait test, use a `meeting_time` about 25 minutes in the future so the WhatsApp reminder fires about 5 minutes later.
