# HIPAA decision packet (HIPAA-READY-01, issue #828)

> **Proposal, not authority.** This packet lists the agreements,
> configuration and spending Hone would need *before* any HIPAA-dependent
> patient onboarding or claim.
> - Nothing here has been purchased, toggled, signed, or requested from a vendor.
> - Prices come from public pages read on 2026-10-11, re-read on 2026-10-15 where marked. They are not quotes.
> - Every decision row belongs to Sam. The legal rows also need qualified counsel.
>
> Evidence and statuses: [hipaa-readiness-assessment.md](./hipaa-readiness-assessment.md).

## 0. The only decisions that need Sam (reduced 2026-10-12)

Routine engineering approvals are delegated to Codex, so the earlier list of
D-0 to D-9 and Q2/Q4 is reduced to **four business decisions**. Everything
else either has an engineering default (§0.2) or is a per-change hosted
authorization (§0.3), which is an approval of a specific change, not an open
question.

| # | Business decision | Why only Sam can make it | What it unblocks |
|---|---|---|---|
| **B1** | **Will Hone serve HIPAA-covered studios, starting with the LA studio?** Ask the studio whether it bills insurance or sends HIPAA standard transactions (covered-entity test), and decide whether Hone accepts business-associate obligations at all. | Market and liability choice; a cash-pay studio may not be covered, and then none of B2–B4 is HIPAA-required | Whether B2–B4 happen now or later |
| **B2** | **Authorize the quote requests for option M (§0.1)** (was: approve a spend envelope) for the BAA-capable stack: Supabase **Team** (from $599/mo, public price) plus its HIPAA add-on (quote); the Vercel HIPAA BAA add-on ($350/mo, public price); Twilio **Security or Enterprise Edition** (sales quote); a BAA-capable email route such as Amazon SES under an AWS BAA (usage-priced); a separate synthetic preview project if wanted. | Recurring cost | Quotes, then the plan changes |
| **B3** | **Legal: engage counsel and an advisor, appoint a privacy official, and authorize who signs BAAs.** Counsel drafts the studio-to-Hone BAA. | Signing authority and accountability | Executed agreements; risk analysis; policies |
| **B4** | **Patient email posture for covered studios.** Either (a) keep detailed emails, but only once they run through a BAA-covered provider, or (b) switch covered studios to "sign in to see details" notifications, which still go through a BAA-covered transport unless counsel records the envelope as PHI-free (§3.1). Until then, covered studios get no detail-bearing email. | Changes what patients receive; a product and liability trade-off | The D-4 transport route and the email copy |

### 0.1 The options, priced (2026-10-15)

This replaces an open "spend envelope" with concrete options. It is an
**evidence and options packet only**:
- it is not a HIPAA-ready declaration;
- nothing here is purchased, requested, signed or configured;
- no external activation, contract or real patient import is authorized by it.

How figures are labelled:
- **Verified (account)**: read from Hone's own accounts, read-only, on the date shown.
- **Verified (public)**: read from the vendor's public page on 2026-10-15. It is a price, not a quote.
- **Estimate**: arithmetic on a stated assumption.
- **Quote needed**: no public figure exists.

**Account facts today.**
- Supabase: the organisation is on **Pro**. Verified (account), 2026-10-12.
- Vercel: the team exists, but its plan is **not exposed by the API** (the team read on 2026-10-15 returns no plan or billing field). Whether it is Pro must be read in Billing. The HIPAA BAA add-on itself has a **public price of $350/month** (Vercel pricing docs, 2026-10-15; Codex P1 4277783063).
- Twilio: the edition has not been read. **Unknown.**

| Option | What it is | Monthly cost | Agreements and who signs | Patient-communication consequence |
|---|---|---|---|---|
| **S: synthetic-only demo** (recommended until B1–B3 are settled) | The prospective-studio demo runs on synthetic data only, on the current stack. Preview isolation (§0.2) still comes first if a preview is used. | **$0 incremental.** No plan change is needed. | None. No BAA is needed, because no PHI is processed. | None for real patients. Demo messages go only to synthetic recipients, and today's production email/SMS behaviour is unchanged. |
| **M: minimum live for ONE covered studio** | The smallest stack that can carry PHI under executed BAAs (agreement chain below). | **Floor of about $1,074/mo total + quotes and usage**, for a one-seat Vercel Pro team. The verified (public) parts are Supabase Team $599/mo (replacing Pro), Supabase PITR $100/mo for 7 days of retention, Supabase **Small compute** at about $15/mo less the $10/mo compute credit (+$5), which HIPAA projects with PITR require (Codex P2 4277870222; [HIPAA projects](https://supabase.com/docs/guides/platform/hipaa-projects), [compute](https://supabase.com/docs/guides/platform/manage-your-usage/compute)), the Vercel Pro platform fee $20/mo, which includes $20 of usage credit (Codex P2 4277843924), and the Vercel HIPAA BAA add-on $350/mo. If the team is already on Vercel Pro, that is **about $1,029/mo more** than today's $45/mo (Supabase Pro $25 plus Vercel Pro $20). Whether it is on Pro is unverified (read in Billing), and extra seats and usage come on top. Estimate: SES at $0.10 per 1,000 emails, about $0.20/mo at 2,000 emails. Quote needed: Supabase HIPAA add-on; Twilio Security or Enterprise Edition; counsel; Upstash (or remove it from the PHI path). The real total is unknown until those quotes exist, so the floor is not a budget. | See below the table. | Email moves off Resend, which cannot sign a BAA, to a BAA-covered route such as SES, **under either B4 posture**. A B4(b) "sign in to see details" email still shows the provider the patient's address and the studio relationship (§3.1). So B4(b) does not remove the BAA requirement unless counsel records that the whole envelope is PHI-free (Codex P2 4277843913). SMS stays on Twilio only under an executed BAA with eligible products. Until every agreement is executed, a covered studio gets no detail-bearing email or SMS. |
| **N: the studio is not a covered entity** (decided by B1) | Cash-pay studio with no HIPAA standard transactions: HIPAA BAAs are not required. | **$0 incremental for HIPAA.** The security hardening in §2 is still recommended on its own merits. | None for HIPAA. Counsel should confirm the covered-entity test. | Current minimized email/SMS continues. Marketing still makes **no** HIPAA claim. |

**Option M agreements and signatories:**
- **Studio → Hone BAA.** Counsel drafts it. The studio signs, and Hone signs through the person B3 authorizes.
- **Hone → processor BAAs.** One each for Supabase (needs Team plus the add-on), Vercel (Pro add-on or Enterprise), Twilio (Security or Enterprise Edition), and AWS (SES, via the AWS BAA).
- **Upstash and other processors.** Each is either removed from the PHI path or brought under a BAA. For Upstash this means raw ids in **every** family listed in [egress audit](./record-id-egress-audit.md) row 19, the single exhaustive key list: the per-studio and refresh lock keys (studio and connection UUIDs), the **two durable no-TTL studio cursors** (`gcal_reconcile:studio_cursor`, `gcal_reconcile:dead_alerts:cursor`), the appointment/link continuation cursor, the raw waitlist keys `<invitationId>:<studioId>` (proof) and `<entryId>:<studioId>` (mobile verification), and the **raw studio UUID suffix** on the hashed new-client-waitlist and waitlist-proof-IP limiter keys (`<hash>:<studioId>`). **Every limiter key** is record- or person-linked too: token, IP and email hashes, studio slugs and studio ids. Only the heartbeats and coordinator locks hold no identifier, so **Upstash as a whole is in the PHI path**. The remedy: **Keys**: HMAC every id with a server secret, and salt `hashId`. **Cursor values**: an HMAC is not usable, because they are passed back to `.gt("id", …)` and `.gt("studio_id", …)` keyset queries (`lib/google-calendar/sync/reconcile-store.ts:84-105, 228-237`). Store them with **reversible authenticated encryption** (for example AES-GCM under a server key), or keep the raw boundary in Postgres and put only an opaque pointer in Upstash (Codex P2 4280380207). These steps are **hardening only**: the tokens stay mappable to records, so clearing still needs a BAA covering every use, removal of Upstash from the PHI path, or a qualified de-identification determination ([clearing rule](./record-id-egress-audit.md); Codex P2 4280570002) (Codex P2 4280325402).
- **Meta conversion tracking (G-23).** It must be **off** for the covered studio. No Meta BAA is known, and the integration is self-service per studio.
- **Record-identifier egress ([audit](./record-id-egress-audit.md), G-26).** Every audit row marked NOT READY must be cleared by the audit's **clearing rule**: an executed agreement with evidence; removal of the record-linked value and its identifying context; or a documented qualified de-identification determination. **HMAC or opaque tokens alone do not clear a row** (Codex P1 4280528834). Contractual coverage without evidence is UNKNOWN.
- **Record ids to non-BAA processors.** Option M also needs two fixes, both engineering-only with no spend. G-24: remove the ids from critical alert emails sent through Resend. G-25: redact clinical ids from Sentry URLs. The alternative to G-25 is a Sentry BAA on an eligible plan.
- **Who signs for Hone.** Each vendor BAA is signed by Hone's account owner on that vendor, unless B3 delegates.

**What Sam actually decides** (B1–B4 unchanged in substance):
- B1 picks S, M or N for the LA studio.
- B2 becomes **"authorize the quote requests for M"**. That needs vendor contact, so it is Sam's to authorize; it is no longer an open spend envelope.
- B3 names the signatory.
- B4 chooses the email posture under M.

Option S needs none of B1–B4, and authorized synthetic development continues without waiting for them.

### 0.2 Engineering defaults adopted under the delegation

The owning lane proceeds unless Sam objects:

- **Access log (G-13, former Q2 and Q4):** the full log lives on the
  platform/support path; an owner-scoped projection comes later;
  practitioners do not see it in V1 (the RBAC lane's recommendation).
- **Preview isolation (former D-6), now URGENT:** previews must never use
  production data. **Verified 2026-10-13: today they do.** The production
  Supabase URL and service-role key, plus live Twilio and Resend credentials,
  are shared with the preview target, so any pushed branch runs with full
  production database access, behind Vercel SSO only. The fix is to give
  previews a separate Supabase project with synthetic data and scope every
  shared secret to production only. This is the **first** per-change
  authorization in §0.3, ahead of the Supabase hardening steps. Until then:
  no mutation or demo tests on any preview.
- **Receipt subject (former D-7):** `Receipt from <studio>`, with the reason
  and amount kept in the body and PDF, implemented by the Audit lane. It is
  reversible copy. If Sam regards the 2026-07-04 copy approval as binding,
  this moves into B4.
- **Waitlist email preheader (former D-9):** the ENG/HIPAA lane owns the
  presentation change. It versions the idempotency key first, with the
  DB/WAIT lane reviewing the key change.
- **Sentry environment gate (G-16):** deferred past 2026-10-16, Sentry lane.

### 0.3 Hosted changes that need per-change authorization (not questions)

These are release actions under #824's boundaries, each requested
separately with its pre-check:
- **first: preview isolation** (a separate preview Supabase project with
  synthetic data, and every shared secret re-scoped to production only), see
  §0.2;
- the Supabase hardening sequence in §2.1 (MFA enforcement, SSL, session
  limits, password policy, then PITR and network restrictions);
- plan purchases (after B2);
- signing agreements (after B3).

The former D-list in §5 and §6 is kept below as the detailed record.

## 1. Agreement chain

```
Studio (covered entity, if D-0 says so)
  └─ BAA ─ Hone (business associate)
             ├─ BAA ─ Supabase   (DB, Auth, Storage)        required
             ├─ BAA ─ Vercel     (hosting, functions, logs)  required
             ├─ BAA ─ Twilio     (SMS, Verify)               required if SMS carries PHI
             ├─ BAA ─ email route (see §3.1)                 required unless email is PHI-free
             ├─ BAA ─ Upstash    (rate limiting AND calendar-sync state)
             │                    required for EVERY use unless removed; raw
             │                    ids in every key family of egress audit row 19,
             │                    including the two durable studio cursors
             └─ none ─ Sentry, PostHog, Stripe, Meta, Google, GitHub
                       → "keep PHI out by design" is NOT met today: Sentry,
                         PostHog, Stripe and Meta receive record ids, and Google
                         receives deterministic per-link hashes (egress audit
                         rows 2-4, 12-15, 17, 18, 20; G-26). Each must be
                         remediated, or brought under an agreement with evidence.
                         Verify at the wire (G-08)
```

**Studio-to-Hone BAA (G-22).** Counsel drafts this. The packet does not.
It must at least settle:
- permitted uses and disclosures;
- safeguards and subcontractor flow-down;
- reporting of incidents and breaches, with timelines and which party
  notifies individuals;
- patient access, amendment and accounting support. Hone has an export and
  append-only amendments (F18, G-21);
- making Hone's books and records available to HHS;
- return, export or destruction of data at termination, including backups
  and Storage objects (G-12);
- termination for breach;
- limits on Hone's liability.

These items track 45 CFR 164.504(e); counsel confirms the current text.

**Hone-to-processor BAAs.** Each must be executed for **Hone's own
account** and cover the products Hone actually uses. When one is signed,
record in the assessment (without the contract text):
- the date;
- the account or team;
- the product scope;
- where the signed copy is stored, outside GitHub.

**Keep out of GitHub:** signed contracts, quotes, account ids beyond what
is already public, secrets, customer records and raw logs.

## 2. Configuration packet

These are checklists for each provider. Every item starts **UNKNOWN**
until a dated read-only check is recorded. A change happens only with
Sam's explicit per-change authorization.

### 2.1 Supabase (G-02, G-03, G-11, G-12)

**Current state, read-only, 2026-10-12** (each item below is a separate change that needs authorization):

| Item | Today |
|---|---|
| 1. Team plan or higher | **Pro**: not met |
| 2. HIPAA add-on and BAA | Not possible on Pro: not met |
| 4. Org MFA | The sole member has MFA on; enforcement not visible |
| 5. PITR | **Off** |
| 6. SSL enforcement | **Off** |
| 7. Network restrictions | **Open** (`0.0.0.0/0`, `::/0`) |
| 8. Connection logging | No custom config, so the platform default (documented as off); confirm read-only |
| 10. Auth sessions | No timebox, no inactivity timeout |
| 10. Auth SMTP | None: Supabase's built-in sender |
| 10. Password policy | Leaked-password protection off; minimum length 6 |

Prerequisites and duties are from Supabase's
[shared responsibility model](https://supabase.com/docs/guides/deployment/shared-responsibility-model)
and its [HIPAA projects](https://supabase.com/docs/guides/platform/hipaa-projects) page.

1. Organization on **Team plan or higher**. The production project is on
   Pro today.
2. HIPAA add-on request, then a signed BAA.
3. Mark the project as a HIPAA project, then address the Security Advisor
   items it raises. Use the assessment's §6 classification method: no
   blanket revokes or blanket policies.
4. **Enforce MFA** for every member of the Supabase organization.
5. **Point-in-time recovery** enabled. Check the compute-size
   prerequisite.
6. **SSL enforcement** on.
7. **Network restrictions** on. Vercel functions connect from dynamic
   egress. Before enabling, confirm from Supabase's network-restrictions
   documentation which connection types it governs, and check that every
   real app and CI connection path still works. This is unverified here.
8. **Postgres connection logging** (`log_connections`) kept on.
9. Storage objects need their own backup and restore route. Database
   backups exclude Storage objects
   ([backups](https://supabase.com/docs/guides/platform/backups)).
10. Auth settings:
    - session timebox and inactivity timeout (G-11);
    - leaked-password protection;
    - the custom SMTP provider for workforce email (F16).
11. Rotate the service-role key and other secrets on a schedule; keep an
    inventory of who holds them.

**Proposed change sequence for the §2.1 settings** (each is a separate
authorization; nothing has been changed):

| Step | Setting | Pre-check (read-only, before the change) | Risk if done blind | Rollback |
|---|---|---|---|---|
| 1 | Enforce MFA on the org | The sole member already has MFA on | Low | Toggle off |
| 2 | SSL enforcement on | List every **direct** Postgres client (CI `supabase db push`, operator `psql`/`db query`, any pooler user) and confirm each connects with TLS. The app uses HTTPS (PostgREST, Storage) | A non-TLS operator or CI connection is refused | Toggle off |
| 3 | Session timebox and inactivity timeout | Pick values with the practice workflow (for example a 12h inactivity limit; product decision) | Mid-session logouts during treatment | Set back to 0 |
| 4 | Leaked-password protection; longer minimum password | Check the plan tier for the feature | Existing short passwords keep working until changed | Toggle off |
| 5 | PITR | Read the compute-size prerequisite and price (D-2 quote) | Cost | Disable |
| 6 | Network restrictions | Inventory direct DB connection sources: CI runners use **dynamic** IPs, Vercel functions use HTTPS, not direct DB. Decide how CI and the operator reach the DB after the change | **Locks out migrations and operator access** if the CI and operator paths are not planned | Reset to `0.0.0.0/0` |
| 7 | Team plan, HIPAA add-on, BAA, HIPAA project mark | Quote, then legal review | Spend | Plan downgrade per Supabase terms |
| 8 | Confirm `log_connections` | `show log_connections` (read-only) | None | n/a |

### 2.2 Vercel (G-04, G-07, G-16)

**Account facts, read-only (Vercel API, 2026-10-12):**
- The authenticated account belongs to **one** team, "Build", which owns
  project `hone-z2uf` (domains `hone.care`, `www.hone.care`).
- **Vercel Authentication (SSO protection) is ON** for "all deployments
  except custom domains". Preview URLs therefore require a Vercel login;
  this is relevant to G-16.
- Password protection and trusted IPs are off.
- **Not readable here:** the team's plan (Hobby, Pro or Enterprise) and
  whether the HIPAA add-on is held. Both stay UNKNOWN until read in
  Billing.

1. Confirm the team plan. A BAA is available to **Pro and Enterprise**;
   Pro buys the HIPAA add-on from Billing
   ([compliance](https://vercel.com/docs/security/compliance)).
2. After signing, obtain in writing which features the BAA covers.
   Specifically: functions, runtime logs, log drains, Web Analytics, Speed
   Insights, previews, and Blob (if it is ever used).
3. **Web Analytics and Speed Insights on `(app)` and `/book`** (G-07):
   - if the BAA does not cover them, unmount them on authenticated and
     booking trees, or strip ids in `beforeSend`;
   - either way, re-verify at the wire with synthetic data.
4. Runtime logs: do a log-payload audit with synthetic data. Logs must not
   carry names, contact details, notes or tokens. Set a retention period
   and decide whether to use a log drain to a BAA-covered destination.
5. Previews:
   - decide whether previews may ever touch production data;
   - the default recommendation is **no**: previews get a separate
     Supabase project with synthetic data (G-16);
   - put deployment protection on previews.
6. Team access: individual accounts, MFA, least-privilege roles, and an
   offboarding checklist.
7. **Secure Compute is optional, not required.** It is an Enterprise
   feature that Vercel offers as "additional protection". Do not treat it
   as a legal requirement.

### 2.3 Twilio (G-06)

1. Confirm that every product in use is on Twilio's
   [HIPAA Eligible Products and Services](https://www.twilio.com/en-us/hipaa)
   list for Hone's account: Programmable Messaging through a Messaging
   Service, and Verify.
2. **Edition prerequisite (verified 2026-10-12):** Twilio says customers
   who sign its BAA "must have our Security Edition or Enterprise Edition"
   ([twilio.com/hipaa](https://www.twilio.com/en-us/hipaa) FAQ). Both are
   sold through sales, so this carries a sales turnaround and a price
   that is not public.
3. Execute Twilio's Business Associate Addendum on the account and
   subaccount that actually sends.
4. Configure message retention and redaction to match the BAA guidance
   ("Architecting for HIPAA on Twilio").
5. Keep the existing callback signature verification, idempotent claims,
   STOP and opt-out handling.
6. **A2P 10DLC registration is a separate matter** from HIPAA. Track it in
   the sender lane of #824.

### 2.4 Other processors

> The remediations in this table (HMAC, redaction, opaque tokens) **reduce exposure; they do not clear a row**. A processor is cleared for option M only under the [egress audit's clearing rule](./record-id-egress-audit.md): an executed agreement with evidence; removal of the record-linked value and its context; or a qualified de-identification determination.

| Processor | Recommended stance | Check |
|---|---|---|
| Sentry | Keep PHI out. **Not met today**: the scrubbers keep clinical path UUIDs in URLs, breadcrumbs and spans ([egress audit](./record-id-egress-audit.md) rows 2-4, G-25) | Redact UUIDs and dynamic clinical segments to route templates in events, breadcrumbs, transaction names and span data, and verify with a captured event. **Or** bring Sentry under its published BAA on an eligible plan, with evidence. Gate the DSN so ordinary local development never reports to production (the CI browser lanes are already guarded: SENTRY-E2E-NOISE-02) |
| PostHog | Keep PHI out. The browser is marketing-only. **Server events carry raw practitioner and studio UUIDs with activity data**, such as session started with its modality, and payment charged or refunded (audit row 18, G-26) | HMAC `distinctId` and `studio_id`, and drop `modality`, as hardening. Clearing needs a BAA with evidence, removal of the ids and context, or a determination (clearing rule). Wire capture with synthetic data (G-08) |
| Stripe | The client **name** is gone from new writes (#857, merged `ce133c18`). **Raw record UUIDs remain** across Customers, SetupIntents, PaymentIntents (including descriptions such as "No-show fee for appointment <id>"), refunds and idempotency keys (audit rows 12-15, G-09 and G-26) | Generic descriptions, one opaque or HMAC reference in metadata, and HMAC idempotency keys. Payment processing has a HIPAA exemption, but ids beyond payment need are still in scope. Historical Customers keep `hone_client_name`; any backfill needs Sam's authorization |
| Upstash | **Not** hashed keys only: raw ids in **every** family listed in [egress audit](./record-id-egress-audit.md) row 19, the single exhaustive key list: the per-studio and refresh lock keys (studio and connection UUIDs), the **two durable no-TTL studio cursors** (`gcal_reconcile:studio_cursor`, `gcal_reconcile:dead_alerts:cursor`), the appointment/link continuation cursor, the raw waitlist keys `<invitationId>:<studioId>` (proof) and `<entryId>:<studioId>` (mobile verification), and the **raw studio UUID suffix** on the hashed new-client-waitlist and waitlist-proof-IP limiter keys (`<hash>:<studioId>`). **Every limiter key** is record- or person-linked too: token, IP and email hashes, studio slugs and studio ids. Only the heartbeats and coordinator locks hold no identifier, so **Upstash as a whole is in the PHI path** | **Keys**: HMAC every id with a server secret, and salt `hashId`. **Cursor values**: an HMAC is not usable, because they are passed back to `.gt("id", …)` and `.gt("studio_id", …)` keyset queries (`lib/google-calendar/sync/reconcile-store.ts:84-105, 228-237`). Store them with **reversible authenticated encryption** (for example AES-GCM under a server key), or keep the raw boundary in Postgres and put only an opaque pointer in Upstash (Codex P2 4280380207). These steps are **hardening only**: the tokens stay mappable to records, so clearing still needs a BAA covering every use, removal of Upstash from the PHI path, or a qualified de-identification determination ([clearing rule](./record-id-egress-audit.md); Codex P2 4280570002) (Codex P2s 4277963235, 4280325402) |
| Google Calendar | Times only and a constant title, **plus deterministic per-link hashes** as the event id and marker (audit row 20, G-15 PARTIAL) | HMAC the event id and marker with a server secret, as **hardening only**. Clearing needs Google agreement coverage (a studio Workspace BAA covering the calendar), removal of the token and context, or a qualified de-identification determination (clearing rule) |
| Meta (Conversions API) | Self-service per studio and consent-gated; inert in production today. Sends the raw appointment UUID inside `event_id` and hashed contact details (audit row 17, F22) | **Off for covered studios** (G-23). HMAC `event_id` before any use |

## 3. Provider routes for PHI-bearing communications

### 3.1 Email (G-05): the main blocker

Resend cannot sign a BAA. Removing note text alone is **not** enough. Each
part of a message has to be classified:

| Surface | Today | PHI-free target |
|---|---|---|
| Recipient address | Patient email | Still identifies a person, so it needs a BAA route or patient consent analysis by counsel |
| From / display name | Studio name | Reveals the care relationship, so treat it as PHI in a covered context |
| Subject | Service, studio, date and time | Generic: "A message from your provider" |
| Body | Times, aftercare, names | "Sign in to view": content only behind authentication |
| Links and tokens | Manage, intake, portal bearer tokens | Short-lived, single-purpose; never log them |
| Attachments | ICS invite (service, studio) | Remove, or generic |
| Tracking and metadata | Provider logs, opens and clicks | Disable tracking; classify the provider's retention |
| Replies | Go to the studio or to Hone | Route to a BAA-covered inbox, or disable replies |

Options for Sam:
- **A. A BAA-capable email provider** for every patient-facing email.
  Candidates must be verified against the vendor's current BAA terms
  before they are named in code.
  - **Verified candidate:** Amazon Simple Email Service (SES) is on AWS's
    [HIPAA Eligible Services Reference](https://aws.amazon.com/compliance/hipaa-eligible-services-reference/)
    (read 2026-10-12). It is covered only under an executed AWS BAA on the
    sending AWS account; the steps and turnaround for that are unverified
    here.
  - Dedicated HIPAA email vendors also exist. None is verified here. Keep the existing provider-neutral
  delivery truth, idempotency, callback authentication and opt-out
  handling.
- **B. PHI-free notifications** using the table above, with content only
  behind authenticated portal access. Counsel must still classify the
  recipient address and studio name. B lowers exposure but probably does
  not remove the need for a BAA in a covered context.
- **C. Both (recommended):** B everywhere, plus A as the transport.
  Exposure stays minimal even under a BAA.

Workforce-only email (ops alerts, admin, feedback, demo) can stay on
Resend if it is shown PHI-free (F15, F19). Patient-facing email cannot.

### 3.2 SMS

Twilio under an executed BAA, following §2.3. Templates already avoid
treatment detail but include the studio name and time. That is PHI in a
covered context, so the BAA is required, not optional.

## 4. Cost packet

Only figures read from a public page on 2026-10-11 are listed. Everything
else needs a quote.

| Item | Public figure | Status |
|---|---|---|
| Supabase Team plan | "From $599 / month", first project included; re-read 2026-10-15 ([pricing](https://supabase.com/pricing)) | Verified public price |
| Supabase HIPAA add-on | "HIPAA available as paid add-on"; price not published | **Quote needed** |
| Supabase PITR | $100 / month per 7 days of retention (public pricing, 2026-10-15); HIPAA projects with PITR need at least **Small compute**, about $15 / month less the $10 / month compute credit ([compute](https://supabase.com/docs/guides/platform/manage-your-usage/compute)) | Verified public price |
| Vercel HIPAA BAA add-on (Pro) | $350 / month, purchased in team Billing ([pricing docs](https://vercel.com/docs/pricing), 2026-10-15) | Verified public price; whether the team is on Pro: **read in Billing** |
| Vercel Pro plan | $20 / month platform fee including $20 of usage credit, plus deploying seats ([Pro plan docs](https://vercel.com/docs/plans/pro-plan), 2026-10-15) | Verified public price |
| Twilio BAA | Requires **Security Edition or Enterprise Edition** (verified 2026-10-12); edition pricing via sales | **Quote needed** |
| BAA-capable email provider | Amazon SES is HIPAA-eligible under an AWS BAA (verified); outbound email $0.10 per 1,000 ([pricing](https://aws.amazon.com/ses/pricing/), 2026-10-15) | Verified public price; **confirm AWS BAA steps** |
| Upstash plan with BAA | Not stated | **Quote needed** |
| Counsel (studio BAA, risk analysis review, policies) | Not applicable | **Quote needed** |

## 5. Detailed decision record (superseded by §0 for what needs Sam)

1. **D-0**: obtain the Los Angeles studio's covered-entity status and the
   workflows it wants. Ask counsel whether Hone acts as its business
   associate.
2. **D-1**: appoint the security/privacy official and engage a qualified
   advisor for the risk analysis and policies (G-01, G-19, G-20).
3. **D-2**: the Supabase upgrade path. Team plan, HIPAA add-on and BAA,
   and the §2.1 settings; get the quote first.
4. **D-3**: the Vercel BAA add-on and its covered features; then decide
   G-07 (analytics on app routes).
5. **D-4**: the email route (§3.1 A, B or C).
6. **D-5**: the Twilio BAA and product confirmation.
7. **D-6**: preview isolation (G-16).
8. **D-7**: the payment receipt subject (copy decision, possibly with
   legal). Proposal: `Receipt from <studio>`, with the reason and amount kept
   in the body and PDF. The Audit lane has no objection and will implement it
   if approved.
9. **D-8**: the access-log questions Q2 and Q4 from the G-13 contract.
10. **D-9: assign an owner for the waitlist emails' preheader.** It is
    excluded from #870. Both candidate lanes declined on 2026-10-12:
    - **SMS/lead lane:** the builders, keys and
      `lib/waitlist/delivery/policy.ts` belong to DB/WAIT;
    - **DB/WAIT:** it does not own the email presentation surface.

    Both agree a preheader must not ship before the idempotency question is
    settled. Two fix options are on record:
    - **(a) version the Idempotency-Key** (DB/WAIT's recommendation;
      the invitation window is now a fixed 48h);
    - **(b) freeze the exact message per key generation in the database**,
      as #831's lead alerts do (0213 `freeze_platform_lead_alert_message`),
      so retries resend the stored bytes.

Engineering can start these now, with no spend and no hosted change:
- G-07 analytics unmount or strip;
- G-08 wire-capture tests;
- G-09 Stripe metadata minimization (new writes done: #857 merged; historical Customers remain);
- G-13 clinical read-audit design;
- G-16 Sentry DSN gate;
- G-17 form copy;
- G-18 advisor classification.

Each is a small PR in its owning lane, using synthetic data.

## 6. Monday decision sheet (2026-10-12)

The decisions above, with each one's external dependency and who acts.
Nothing here is authorized until Sam approves that row.

| # | Decision | External dependency | Turnaround | First action, read-only or quote |
|---|---|---|---|---|
| D-0 | Covered-entity status of the LA studio | The studio plus counsel | Unknown | Ask the studio how it bills (insurance or cash) and whether it sends HIPAA standard transactions |
| D-1 | Privacy official and advisor | Advisor engagement | Unknown | Name the official; request an advisor quote |
| D-2 | Supabase Team, HIPAA add-on and BAA | Supabase HIPAA request form | Unknown (form, then review) | Request a quote; read the current org settings |
| D-3 | Vercel HIPAA add-on | Self-serve on Pro in team Billing | Self-serve once on Pro | Read the team plan and add-on price in Billing |
| D-4 | Email route | AWS BAA plus SES setup, or another verified vendor | Unknown | Choose option A, B or C; read SES pricing |
| D-5 | Twilio BAA | Security or Enterprise Edition through Twilio sales | Sales cycle | Request an edition quote; list the products in use |
| D-6 | Preview isolation | None (engineering) | Days | Approve a separate preview project with synthetic data |

**Account-specific status at a glance (2026-10-12)**

| Provider | Verified | Unknown |
|---|---|---|
| Supabase | **Verified 2026-10-12 (read-only):** project org on `pro`; `us-east-1`; SSL **not** enforced; network restrictions **open**; PITR **off** (daily backups only); no custom Postgres config; auth TOTP available but not required; no session timebox or inactivity limit; leaked-password protection off; no custom SMTP; the sole org member has MFA on | BAA and HIPAA add-on (need Team first); whether org MFA is *enforced*; `log_connections` value |
| Vercel | One team, project `hone-z2uf`; SSO protection on for previews | Plan; HIPAA add-on; which features the BAA covers; log retention and drains |
| Twilio | The BAA needs Security or Enterprise Edition (public FAQ) | Account edition; products in use per subaccount; retention |
| Resend | Cannot sign a BAA (public FAQ) | n/a: patient email must move or be shown PHI-free |
| AWS (candidate) | SES is HIPAA-eligible (public list) | No account known; BAA, pricing, setup time |
| Sentry, PostHog, Upstash | Public BAA or eligibility statements exist | Hone's plans. Record ids reach all three today ([egress audit](./record-id-egress-audit.md)), so each must be cleared under the audit's clearing rule. Hardening such as HMAC is not enough on its own |

**Engineering already under way, in this lane** (drafts, not merged or
deployed; neither depends on a decision above):
- G-07 Vercel analytics URL redaction: #842;
- G-12 isolated restore drill: #848.
- G-09 Stripe Customer metadata without the client name: #857 is **merged**
  (`ce133c18`, recorded in the production record by a834daf4). New writes carry
  no client name, but still carry raw record UUIDs (egress audit rows 12-15, G-26);
  existing Customers keep the old metadata, and a backfill needs Sam's
  authorization.
- Email subjects without client name, service, date, time, attendance or
  treatment fact: #859. This reduces exposure but does **not** clear G-05.
- PostHog token-path redaction derived from the canonical registry: #869.
- Hidden neutral email preheader (previews only): #870, stacked on #859.
  The waitlist family is excluded (idempotency payload) and handed to the
  WAIT lane. **Email is not PHI-free.**
- Provider-visible email inventory:
  `docs/security/email-provider-visible-inventory.md` (in #870; **not in this tree** until #870 merges).
- G-13 clinical access audit: contract proposed in
  [clinical-access-audit-contract.md](./clinical-access-audit-contract.md);
  shape agreed in principle with the RBAC lane; no migration number held (≥ 0224: #868 claims 0222 and #860 (MPX) holds 0223; allocated via the shared register).

**Consequence for Friday (2026-10-16).** Several of these depend on vendor
turnaround that this packet cannot vouch for. Unless each gate is met and
evidenced, the meeting stays synthetic-only, as #824 already requires.

**Lane agreements recorded on 2026-10-12** (none is a HIPAA claim):
- **Delivery (Sentry lane):**
  - the email ledger and incidents (0212, 0215) store ids and codes only;
  - the receipt table is still Resend-shaped, and adding an SES path is
    additive (an SNS verifier plus a widened provider check), done after D-4;
  - the Sentry environment gate (G-16) is theirs.
- **SMS lane:** readiness will state that "Registration is not HIPAA
  coverage". "Active" means sender plus registration only.
- **Audit lane:** no reader of `hone_client_name`. Any backfill of existing
  Customers needs Sam's authorization.
- **RBAC lane:** the G-13 contract shape is agreed in principle. Q2 and Q4
  are Sam's.

## 7. Until the gate is met

- No HIPAA claim in marketing, sales or replies to prospects. The marketing
  tests already reject the word "HIPAA" on public pages.
- The demo for the prospective studio uses **synthetic data only**. Do not
  import real patient records, and do not invite reliance on an unverified
  HIPAA claim.
- **Gate for any HIPAA-dependent onboarding.** All of these, together:
  - executed BAAs for every PHI processor;
  - a recorded configuration evidence row for each §2 item;
  - the risk-management disposition;
  - tested incident and breach procedures;
  - qualified compliance/legal review.
