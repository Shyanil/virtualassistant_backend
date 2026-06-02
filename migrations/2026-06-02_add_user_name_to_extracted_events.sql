-- Add user_name column so invitee WhatsApp messages can show the host's real name
-- instead of the hardcoded fallback 'Member'.
ALTER TABLE public.extracted_events
  ADD COLUMN IF NOT EXISTS user_name TEXT NULL;
