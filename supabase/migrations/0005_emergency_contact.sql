-- Adds an optional emergency contact (name + phone) to clients.
-- Both columns are nullable; the cheat sheet shows the card only when one is set.

alter table public.clients
  add column emergency_contact_name text,
  add column emergency_contact_phone text;
