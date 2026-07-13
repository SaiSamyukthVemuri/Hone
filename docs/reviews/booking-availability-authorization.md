# Booking — availability-bypass authorization (product policy)

## Rule (server-authoritative)

Bypassing published availability when creating an appointment is **owner-only**,
enforced on the server for every internal booking surface:

> `allow_outside_availability = true` ⇒ `practitioner.role` must be `"owner"`.

This is checked in `bookAppointmentForClientAction`
(`app/(app)/calendar/actions.ts`) against the **server-resolved** role. It is the
single internal action that reads the availability-bypass flag — the
client-profile Book flow and the calendar Quick Book both post to it; public
booking (`app/book/[slug]/actions.ts`) lives in a separate action that never
reads the flag. Other appointment-writing paths (cancel, reschedule,
session-new, data import) do not honour the bypass.

## No client-supplied authorization evidence

The gate trusts **only** the server-resolved practitioner role. It does **not**
infer authorization from any client-supplied field:

- duration / `duration_minutes_override`
- a `source` / `mode` / form-name label
- UI route (calendar vs client page)
- drag vs click interaction

A non-owner therefore cannot bypass the owner requirement by attaching a custom
duration or forging a source label.

## Product-policy decision (deliberate, not accidental)

In the current architecture a **custom appointment length** is *coupled* to the
availability bypass: `duration_minutes_override` requires
`allow_outside_availability = true` (the standard slot-membership check is
computed at the service-default length, so a non-default length skips it via the
bypass). Because the bypass is owner-only, **non-owner custom-length booking is
owner-only too**.

This is an accepted policy decision: **only owners may bypass published
availability, on every surface.** We do **not** preserve a non-owner
out-of-hours / custom-length path by trusting the duration parameter as an
implicit authorization signal.

If non-owner **custom-length booking *within* published availability** is later
required, it must be delivered by **decoupling duration from the availability
bypass** (validate a custom-length booking against availability at its own
length) — a separate slot-engine change — rather than by relaxing this gate.

## UI notes

- **Client profile Book flow:** the outside-hours override control is shown only
  to owners (`isOwner`); the server gate is the authoritative guarantee.
- **Calendar Quick Book drawer:** the override control / drag-to-create is not
  yet owner-gated in the UI, so a non-owner who reaches it receives the server
  error ("Only the studio owner can book outside your normal availability")
  rather than a silent bypass. Gating the drawer UI on `isOwner` (so non-owners
  never see the control) is a follow-up UX refinement; it does not affect the
  authorization guarantee, which is enforced server-side.
