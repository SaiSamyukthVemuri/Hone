-- 0373: two separate studio switches for the client-facing notices that follow a change to a booked appointment:
--   send_moved_appointment_emails      the email telling a client their appointment was moved (or its practitioner changed)
--   send_client_cancellation_emails    the email telling a client their appointment was cancelled by the studio
-- NOT APPLIED. Hosted apply needs the platform operator's per-change approval and its own package. The number is reserved in the
-- migration registry; `npm run migration:state` reports the next free number at the time of writing.
--
-- WHAT. Two boolean columns on public.studios, NOT NULL DEFAULT true. They are independent of each other and of
-- send_confirmation_emails (0025): turning booking confirmations off turns neither of these off.
--
-- NOTHING CHANGES UNTIL AN OWNER CHOOSES. Both default to true, so every existing and future studio keeps today's behaviour:
-- both notices are sent. Adding a NOT NULL column with a constant default is a catalog change only (no table rewrite) on the
-- supported Postgres versions. No row is rewritten and no saved preference is changed.
--
-- WHO MAY WRITE. No grant or policy on public.studios changes here. The existing policy "studios: owners update" (0001) allows
-- only the studio's owner to update the row through the Data API; a member's UPDATE touches zero rows. The application writes
-- these columns from the owner-checked email settings action. service_role bypasses RLS as before. This migration creates no
-- function, so there is no EXECUTE grant to revoke.
--
-- WHAT THIS DOES NOT DO. It changes no send code, no claim slot and no data. The owner email sent when a client cancels through
-- the link is an owner notice and is not governed by either switch.

begin;

set local lock_timeout = '5s';

alter table public.studios
  add column if not exists send_moved_appointment_emails boolean not null default true,
  add column if not exists send_client_cancellation_emails boolean not null default true;

comment on column public.studios.send_moved_appointment_emails is
  '0373. The studio sends the client an email when their appointment is moved or its practitioner changes. Default true. Read at send time. Independent of send_confirmation_emails.';
comment on column public.studios.send_client_cancellation_emails is
  '0373. The studio sends the client an email when the studio cancels their appointment. Default true. Read at send time. Independent of send_confirmation_emails. Does not govern the owner email sent when a client cancels through the link.';

commit;
