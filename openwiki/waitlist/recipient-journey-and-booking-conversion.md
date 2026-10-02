---
type: product workflow
title: Waitlist recipient journey and booking conversion
description: What an invited prospect experiences on /invitation/[token] and which server authority backs each step — the server-side resolve, recipient proof by emailed code and the signed capability cookie, decline, booking through the public booking action into the atomic create-and-convert command — plus what the bearer token does and does not prove, and the profile, SMS-consent and mobile-verification authorities that exist in the database but are not yet reachable.
tags: [waitlist, invitations, recipient-proof, booking-conversion, public-routes, sms-consent]
sources:
  - id: openwiki-source-08abff96c852db46fe5155e9
    resource: repo://app/api/twilio/inbound-sms/route.ts
  - id: openwiki-source-3cd8b2452ec5b6ab26f550db
    resource: repo://app/invitation/%5Btoken%5D/actions.ts
  - id: openwiki-source-fddaf8a665973ce5c2c6303a
    resource: repo://app/invitation/%5Btoken%5D/page.tsx
  - id: openwiki-source-ed9ea36b9695d07178f640a2
    resource: repo://lib/booking/waitlist-invitation.ts
  - id: openwiki-source-6182a5bc3a8c1b8e14327aab
    resource: repo://lib/waitlist/mobile-verification-server.ts
  - id: openwiki-source-33f31daff4688756029500f2
    resource: repo://lib/waitlist/profile-completion-server.ts
  - id: openwiki-source-156cccd16ed735df690bfbf3
    resource: repo://supabase/migrations/0192_waitlist_recipient_proof_authority.sql
  - id: openwiki-source-4dfecfd03b5b8d11602a352b
    resource: repo://supabase/migrations/0195_waitlist_atomic_booking_conversion.sql
  - id: openwiki-source-fffabb760dc0c6865e7cb412
    resource: repo://supabase/migrations/0198_waitlist_live_invitation_read.sql
  - id: openwiki-source-8babacb801362e1244e9a060
    resource: repo://supabase/migrations/0202_waitlist_profile_and_sms_consent_authority.sql
  - id: openwiki-source-07bdcb79c54bb791aa3d8cc8
    resource: repo://supabase/migrations/0203_waitlist_mobile_verification_authority.sql
  - id: openwiki-source-5974493332a90b29c2776d64
    resource: repo://tests/db/waitlist-atomic-booking-conversion.db.test.ts
  - id: openwiki-source-23b6ad401cd24a89f9891e63
    resource: repo://tests/db/waitlist-recipient-proof.db.test.ts
generated: { by: "claude-code", at: "2026-10-02T20:08:11.217Z" }
verified:
  - by: openwiki/0.6.1
    at: 2026-10-02T22:34:57.394Z
---

# Waitlist recipient journey and booking conversion

An invited prospect receives an email containing `/invitation/<token>`. The route is anonymous; the middleware
lists `/invitation/` as public, and the token in the path is the credential. Nothing in the browser holds
authority: every step calls a `service_role`-only command through `lib/booking/waitlist-invitation.ts`.

The lifecycle behind these steps is on [Waitlist entries and invitation lifecycle](entries-and-invitation-lifecycle.md).
The route's privacy controls — no Referer, no indexing, telemetry scrubbing, the signed capability cookie — are on
[Public token routes and privacy](../security/public-token-routes-and-privacy.md).

## 1. What the token proves, and what it does not

`0192` separates **two capabilities**
([`0192` L23-L48](../../supabase/migrations/0192_waitlist_recipient_proof_authority.sql#L23-L48)):

| Holding | May |
|---|---|
| **The invitation URL** (bearer token) | **view** the offer and **request** a proof code |
| **A verified recipient capability** | **book** or **decline** this invitation |

**The URL alone can do neither of the second pair.** The check is *inside* the mutating command, in the same
locked transaction, so no other entry point can skip it.

Proof state lives on the invitation row:

- a newer challenge replaces the older one;
- revoking, releasing, declining, expiring or reissuing the invitation kills outstanding proof automatically;
- only SHA-256 digests are stored — the raw code and capability each exist in exactly one server response.

DB proof ([`waitlist-recipient-proof.db.test.ts` L278-L760](../../tests/db/waitlist-recipient-proof.db.test.ts#L278-L760)):

- the bearer URL alone cannot redeem or decline;
- a separate proof grants the ability to act;
- the capability's TTL is owned by the database;
- proof is bound to the stored invitation and recipient;
- revoke, reissue and replacement invalidate it;
- validation happens inside the locked mutation.

## 2. Route by route

The page renders dynamically, is never cached and is marked no-index. Its first authority call happens on the
server before anything paints, so a dead or forged link never shows an offer
([`page.tsx` L5-L35](../../app/invitation/[token]/page.tsx#L5-L35)).

| Step | Server action | Command |
|---|---|---|
| Load the offer | `loadInvitationAction` | `resolve_new_client_waitlist_invitation` — read-only, never consumes the invitation |
| Ask for a code | `requestInvitationProofAction` | IP throttle, then the per-invitation and per-IP proof limiter (both fail open by design), then `begin_waitlist_invitation_proof`. The code is emailed to the **stored** recipient contact the command returns |
| Enter the code | `submitInvitationProofAction` | `complete_waitlist_invitation_proof` → a capability, stored in an httpOnly cookie signed and bound to this token's hash and the database expiry |
| Decline | `declineInvitationAction` | `decline_new_client_waitlist_invitation`, which requires the capability. It stamps `declined_at`, moves the entry `invited → released`, and frees the round seat |
| Book a time | `bookInvitationSlotAction` | `publicBookAppointmentAction` with the invitation context, ending in `create_waitlist_public_appointment` |

References: [`actions.ts` L755-L1084](../../app/invitation/[token]/actions.ts#L755-L1084);
[`waitlist-invitation.ts` L473-L870](../../lib/booking/waitlist-invitation.ts#L473-L870).

**Proof-request ordering.** The proof limiter runs **after** the resolve and **before** the mint, so a refusal
costs no challenge — minting would retire the code already in the recipient's inbox
([L794-L829](../../app/invitation/[token]/actions.ts#L794-L829)). Issuing a new challenge clears the cookie,
because the old capability is now dead in the database.

**Booking** ([L1084-L1180](../../app/invitation/[token]/actions.ts#L1084-L1180)):

- **Contact details come from the waitlist entry.** The stored email is matched by hash, so the recipient never
  types an address. The stored phone **wins** over a typed one; a typed number is read only when the entry has
  none.
- **An unknown outcome is its own terminal state.** If the response is lost, the screen says it cannot tell
  rather than showing live times. `0195` is atomic, so an appointment may have committed.
- **A spent invitation is terminal.** If the redeem committed but no appointment did, the offer is not shown
  again.

## 3. The atomic create-and-convert command (`0195`)

Before `0195`, an invitation booking was three transactions: redeem, create the appointment, record the
conversion. If the process died between the last two, the appointment existed while the entry stayed `invited`
forever and could be invited again
([`0195` L1-L76](../../supabase/migrations/0195_waitlist_atomic_booking_conversion.sql#L1-L76)).

`create_waitlist_public_appointment` fixes this:

- **It composes rather than copies.** It calls `create_public_appointment` and
  `record_new_client_waitlist_conversion` and reimplements neither.
- **One transaction.** Appointment, audit and conversion commit in one transaction, inside a subtransaction. A
  refusal after the appointment rows are written raises a private `WA002`, which unwinds everything and is
  mapped to a closed result code. No SQLSTATE or raw database message escapes.
- **The entry id is supplied by the server's redemption path, not inferred.** The conversion command re-verifies
  the entry's studio and state under its own lock.
- **Lock order:** `studios FOR NO KEY UPDATE`, then entry, then client, then the nested canonical booking order
  (see [Scheduling concurrency and lock order](../scheduling/concurrency-and-lock-order.md#5-waitlist-booking-conversion--the-nested-order)).

Ordinary public booking keeps calling `create_public_appointment` directly and takes no waitlist locks. The
invitation path is the scoped exception to the studio's admission mode: an invited prospect books even while new
clients are waitlisted. See [New-client admission mode](new-client-admission-mode.md).

[`waitlist-atomic-booking-conversion.db.test.ts` L270-L850](../../tests/db/waitlist-atomic-booking-conversion.db.test.ts#L270-L850) proves:

- appointment, audit and conversion commit together;
- the conversion is bound to the redeemed recipient;
- the booking stays inside the stored offer scope;
- concurrency outcomes;
- service-role-only privileges.

The whole journey runs end to end against the accepted stack in
[`waitlist-recipient-journey.db.test.ts`](../../tests/db/waitlist-recipient-journey.db.test.ts#L285-L320).

## 4. Profile, SMS consent and mobile verification

| Capability | Database authority | Reachable from the app? |
|---|---|---|
| richer profile (names, treatment-area catalog ids, SMS consent evidence) | `0202`: nine nullable columns, all-or-nothing consent evidence (a decline writes NULLs, never a timestamped false), and four `service_role` commands ([`0202` L1-L90](../../supabase/migrations/0202_waitlist_profile_and_sms_consent_authority.sql#L1-L90)) | **No.** `join_new_client_waitlist_with_profile` has no caller. `complete_waitlist_profile_by_grant` is called only from `lib/waitlist/profile-completion-server.ts`, which nothing imports. The profile UI components are imported by no route |
| STOP suppression for prospects | `waitlist_prospect_suppression_candidates` and `suppress_waitlist_prospects` (`0202`) | **Yes**, from the inbound Twilio route; see [SMS consent, STOP and senders](../communications/sms-consent-stop-and-senders.md) |
| mobile verification | `mark_waitlist_mobile_verified` (`0203`): a database-clock instant, compare-and-set against the **exact stored phone string**, refuses entries with no mobile or a mismatched one, idempotent once set; the guard allows exactly one writer ([`0203` L1-L41](../../supabase/migrations/0203_waitlist_mobile_verification_authority.sql#L1-L41), [L237-L267](../../supabase/migrations/0203_waitlist_mobile_verification_authority.sql#L237-L267)) | **No.** Its only caller, `mobile-verification-server.ts`, is imported only by `mobile-verification-flow.ts`, which nothing imports. The capability flag `verifiesMobile` is false |

Phone equivalence deliberately lives only in TypeScript, in one normalizer. The SQL backstop is an exact string
compare, so two normalizers cannot drift apart.

The practitioner surface also needed `0198`. It grants owners column SELECT on `declined_at`, so they can evaluate
the same liveness predicate as the database's one-live-per-entry index. Without it, a declined invitation looked
live ([`0198` L1-L40](../../supabase/migrations/0198_waitlist_live_invitation_read.sql#L1-L40)).

## 5. Contradictions and open questions

1. **Frozen migration headers still say "not applied".** `0203` reads "CANDIDATE, NOT APPLIED"
   ([L5-L8](../../supabase/migrations/0203_waitlist_mobile_verification_authority.sql#L5-L8)), and so does `0204`.
   Both are within the declared hosted range in `migration-state.json`. The headers are frozen history; the record
   is the authority.
2. **`0202` says STOP stamps only clients.** Its header says the inbound STOP route "still stamps `clients` alone"
   and that its four commands are "called by NOTHING"
   ([L11-L16](../../supabase/migrations/0202_waitlist_profile_and_sms_consent_authority.sql#L11-L16)). Today the
   inbound route calls the two suppression commands. The header describes the state when it was written.
3. **The profile and verification authorities are built but dormant.** The database authorities and server
   modules exist and are tested, but no route reaches them, so a prospect cannot complete a profile or verify a
   mobile today. Read them as *implemented, not reachable* in the production status vocabulary.
4. **The proof-request limiter comment is stale.** It says `limitWaitlistProofRequest` has "ZERO callers"
   ([`actions.ts` L798-L804](../../app/invitation/[token]/actions.ts#L798-L804)), but the same function calls it a
   few lines later.
