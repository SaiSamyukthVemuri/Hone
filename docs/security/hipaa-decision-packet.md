# HIPAA decision packet (HIPAA-READY-01, issue #828)

> **Proposal, not authority.** This packet lists the agreements,
> configuration and spending Hone would need *before* any HIPAA-dependent
> patient onboarding or claim.
> - Nothing here has been purchased, toggled, signed, or requested from a vendor.
> - Prices come from public pages read on 2026-10-11 and are not quotes.
> - Every decision row belongs to Sam. The legal rows also need qualified counsel.
>
> Evidence and statuses: [hipaa-readiness-assessment.md](./hipaa-readiness-assessment.md).

## 1. Agreement chain

```
Studio (covered entity, if D-0 says so)
  └─ BAA ─ Hone (business associate)
             ├─ BAA ─ Supabase   (DB, Auth, Storage)        required
             ├─ BAA ─ Vercel     (hosting, functions, logs)  required
             ├─ BAA ─ Twilio     (SMS, Verify)               required if SMS carries PHI
             ├─ BAA ─ email route (see §3.1)                 required unless email is PHI-free
             ├─ BAA ─ Upstash    (rate limiting)             confirm need: keys are hashed
             └─ none ─ Sentry, PostHog, Stripe, Google, GitHub
                       → keep PHI out by design; verify at the wire (G-08)
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

| Processor | Recommended stance | Check |
|---|---|---|
| Sentry | Keep PHI out (current scrubbers); consider a BAA as defence in depth | Check plan eligibility for its published BAA; gate the DSN so local and CI runs never report to production |
| PostHog | Keep PHI out; browser marketing-only, server events practitioner-only | Wire capture with synthetic data (G-08) |
| Stripe | Minimize: remove `hone_client_name` from customer metadata (G-09) | Confirm reconciliation needs only opaque ids |
| Upstash | Hashed keys only | Confirm BAA availability and plan if hashed email plus studio counts as PHI |
| Google Calendar | Times only, constant title | Studio guidance only (G-15) |

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
| Supabase Team plan | "From $599 / month", first project included ([pricing](https://supabase.com/pricing)) | Verified public price |
| Supabase HIPAA add-on | "HIPAA available as paid add-on"; price not published | **Quote needed** |
| Supabase PITR and any compute upgrade it requires | Add-on; price depends on retention and compute | **Quote or calculator needed** |
| Vercel HIPAA BAA add-on (Pro) | Purchased in team Billing; price not shown on the public pricing page read | **Read in Billing (read-only)** |
| Vercel Pro seats | Developer seat $20 / month ([pricing](https://vercel.com/pricing)) | Verified public price |
| Twilio BAA | Requires **Security Edition or Enterprise Edition** (verified 2026-10-12); edition pricing via sales | **Quote needed** |
| BAA-capable email provider | Amazon SES is HIPAA-eligible under an AWS BAA (verified); usage pricing not read | **Read AWS pricing; confirm AWS BAA steps** |
| Upstash plan with BAA | Not stated | **Quote needed** |
| Counsel (studio BAA, risk analysis review, policies) | Not applicable | **Quote needed** |

## 5. Decisions for Sam, in recommended order

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
- G-09 Stripe metadata minimization;
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
| Sentry, PostHog, Upstash | Public BAA or eligibility statements exist | Hone's plans; whether a BAA is needed if PHI stays out |

**Engineering already under way, in this lane** (drafts, not merged or
deployed; neither depends on a decision above):
- G-07 Vercel analytics URL redaction: #842;
- G-12 isolated restore drill: #848.
- G-09 Stripe Customer metadata without the client name: #857 (by agreement
  with the Audit lane).
- Email subjects without client name, service, date, time, attendance or
  treatment fact: #859. This reduces exposure but does **not** clear G-05.
- PostHog token-path redaction derived from the canonical registry: #869.
- Hidden neutral email preheader (previews only): #870, stacked on #859.
  The waitlist family is excluded (idempotency payload) and handed to the
  WAIT lane. **Email is not PHI-free.**
- Provider-visible email inventory:
  `docs/security/email-provider-visible-inventory.md` (in #870).
- G-13 clinical access audit: contract proposed in
  [clinical-access-audit-contract.md](./clinical-access-audit-contract.md);
  shape agreed in principle with the RBAC lane; no migration number held (≥ 0223: #868 now claims 0222; allocated via the shared register).

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
