-- Adds:
--   clients.allergies — free-text record of relevant allergies (latex, fragrance, etc.).
--   sessions.performed_by_practitioner_id — who actually performed the session.
--     Distinct from sessions.practitioner_id (who CREATED the row); the same
--     person by default, but a partner can chart a session done by a colleague.
--   sessions.price_paid_cents — what the client paid for this session.

alter table public.clients
  add column allergies text;

alter table public.sessions
  add column performed_by_practitioner_id uuid references public.practitioners(id) on delete set null,
  add column price_paid_cents int check (price_paid_cents is null or price_paid_cents >= 0);
