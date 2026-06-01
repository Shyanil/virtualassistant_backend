-- Adds the meeting_link column used by the backend to store the generated
-- Google Meet / calendar URL for an extracted event.
--
-- Why this is needed: saveExtractedEventFromIntent() inserts `meeting_link`
-- and the /api/events/:id/invitee-phone endpoint reads `event.meeting_link`.
-- Without this column, every insert into extracted_events failed with
-- Postgres error 42703 ("column ... does not exist"), so no event rows saved.
--
-- Run once against the reminder-system Supabase project (SQL editor or psql).

ALTER TABLE public.extracted_events
  ADD COLUMN IF NOT EXISTS meeting_link text NULL;
