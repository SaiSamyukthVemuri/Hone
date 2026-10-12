# Email: what the email provider can see (HIPAA-READY-01, #828)

> **Hone email is not PHI-free.** The subject rule (#859) and the hidden
> preheader (this change) minimize what shows in an inbox list or on a lock
> screen. **Neither changes what the provider receives**: every field below
> reaches the provider (Resend today) in full. Resend states it cannot sign a
> BAA ([resend.com/security](https://resend.com/security)). This inventory does
> **not** clear #828 gap G-05; that needs a BAA-covered route (decision D-4).

Source-traced at `f7b68c87` (stacked on #859), 2026-10-12.

## 1. Every send carries these fields to the provider

From `sendEmailSafely` (`lib/email/send-appointment.ts`) and
`lib/email/new-client-waitlist-send.ts`:

| Field | Content | Patient data? |
|---|---|---|
| `to` | The recipient's address (patient or practitioner) | **Yes** for patient emails |
| `from` | `"<Studio name>" <hello@hone.care>` via `buildFromHeader` | Reveals the care relationship |
| `replyTo` | Studio contact address, where set | No |
| `subject` | Minimized by #859: studio name only | Minimized |
| `html` | Full body, now **preheader first** | **Yes** |
| `text` | Full plain-text body. **No preheader**: a text-only client previews its first line | **Yes** |
| `attachments` | `appointment.ics` on booking confirmations; a receipt PDF on payment receipts | **Yes** |
| `Idempotency-Key` | Waitlist family only (opaque) | No |

## 2. Per template

"Preheader" means the hidden first line added by this change. The inbox preview
shows it instead of body text.

| Template | Recipient | Subject (after #859) | Preheader (this change) | Patient data in the body | Links, attachments | Owner |
|---|---|---|---|---|---|---|
| Booking confirmation (`appointment.ts`) | Patient | `Your appointment with <studio> is confirmed` | `A message from <studio>…` | Service, date and time, duration, practitioner, address, prep text, treatment-time line | Cancel, reschedule, intake, portal links; **ICS: service, studio, client name and email, cancel URL with token** | ENG (copy); delivery (send) |
| New-booking notice (`appointment.ts`) | Practitioner | `New booking at <studio>` | `New activity at <studio> in Hone…` | **Client name, email, phone**, service, time, notes, referral source | App link | ENG |
| Cancellation, client-facing | Patient | `Appointment cancelled · <studio>` | `A message from <studio>…` | Service, date and time, reason | Rebook link | ENG |
| Cancellation, studio-facing | Practitioner | `Appointment cancelled by the <role> · <studio>` | `New activity at <studio> in Hone…` | Client name, actor, time, service, reason | — | ENG |
| 24h and 2h reminders (`reminders.ts`) | Patient | `Appointment reminder from <studio>` | `A message from <studio>…` | Service, time, practitioner, prep text | Cancel, reschedule, intake links | ENG |
| No-show follow-up | Patient | `A message from <studio>` | `A message from <studio>…` | Attendance fact ("We missed you today") | Rebook link | ENG |
| Move or reassignment (`notify-appointment-moved.ts`) | Patient | `Your appointment with <studio> has been updated` | `A message from <studio>…` | Service, new date and time, practitioner | Manage and reschedule links (token) | ENG |
| Postcare (`postcare.ts`) | Patient | `A message from <studio>` | `A message from <studio>…` | Aftercare, warning signs, products, service, date | Review link | ENG |
| Portal message notification | Patient | `New secure message from <studio>` | `A message from <studio>…` | None (the message stays in Hone) | Portal login (no token) | ENG |
| Portal reply notification | Practitioner | `New client reply in Hone` | `New activity at <studio> in Hone…` | None | Client profile link | ENG |
| Portal magic link | Patient | `Your new secure <studio> sign-in link` | `A message from <studio>…` | None | **Magic link (bearer token)** | ENG |
| Intake request and reminder | Patient | Neutral (intake rule) | Generic `Open this message to see the details.` (intake rule: no studio) | Appointment time (reminder) | **Intake link (token)** | ENG |
| Waitlist invitation and recipient proof | Patient | Studio name | **Not changed: excluded** (§3) | Offer window; proof code | **Invitation link (token)**, code | WAIT/SMS lanes |
| New-client waitlist, studio notice | Practitioner | `[HONE WAITLIST] New client · <studio>` | **Not changed: excluded** (§3) | **Name, email, phone** | — | Lead/WAIT lanes |
| New-client waitlist, client acknowledgement | Patient | `You're on the waitlist · <studio>` | **Not changed: excluded** (§3) | Waitlist status | — | Lead/WAIT lanes |
| Payment receipt (`payment-receipt.ts`) | Patient | `Receipt from <studio>: <reason> <amount>` | **Not changed: Audit lane** | Amount, reason (for example "Late cancellation fee"), date | **Receipt PDF** | **Audit** |
| Practitioner invitation and welcome | Practitioner | Studio name | Not applicable (workforce, no patient data) | None | Invite link | — |
| Ops alerts, feedback, demo | Hone operator | Event name | Not applicable | Designed to be PHI-free (#828 F15, F19) | — | Sentry, #826 |

## 3. Deliberately excluded from the preheader change, and why

**The waitlist family** (`waitlist-invitation`, `waitlist-recipient-proof`,
`new-client-waitlist`) sends through `lib/email/new-client-waitlist-send.ts` with
a Resend `Idempotency-Key`.
- `lib/waitlist/delivery/policy.ts` requires the payload to be a pure function
  of the key, because the key carries no payload digest.
- A preheader changes the bytes. A resend that spans a deploy, inside Resend's
  roughly 24-hour key window, would then present the same key with a
  different body.
- `tests/lib/email/new-client-waitlist-presentation.test.ts` also pins those
  builders as import-free.
- So this belongs to the owning lane, with that deploy question answered
  first.

**Payment receipts** belong to the Audit lane. Their subject still names the
charge reason (for example "Late cancellation fee", an attendance fact) and the
amount.
- **Audit lane, 2026-10-12: defer.** They have no objection to
  `Receipt from <studio>`, with the TEST MODE prefix kept.
- **Condition:** the reason, amount and currency stay in the body detail rows
  and the PDF exactly as today, which the USD tests assert.
- **Who decides:** the live wording is recorded as covered by the 2026-07-04
  copy approval, so changing it is **Sam's copy decision, possibly with
  legal**. If approved, Audit will make it as a separate small PR off
  production.

## 4. What this does not cover

- **Plain-text clients and parts.** The `text` part has no preheader. A
  text-only client previews its first line, which is a greeting or the
  appointment details.
- **The ICS attachment** carries the service, client name and email, and a
  token link. Calendar apps show it.
- **Provider retention.** Resend's retention of message content is not
  verified here.
- **Recipient and From.** These still reveal the patient-to-studio
  relationship to the provider.
- **SMS** is a separate surface (Twilio BAA, packet §2.3).
