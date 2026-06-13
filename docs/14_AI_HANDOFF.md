# 14 AI handoff

**If you are an AI agent continuing work on Hone, read this first.**

## Current production status (as of PR #243)

- **Marketing site YC-style cleanup** (PR #243, public-only). The PR #242 homepage was tightened from thirteen repetitive sections to eight: hero (one combined visual), calendar-vs-Hone comparison, How Hone works (before/during/after), product proof (Before Today / charting / procedure records / Daily Prep Brief as compact cards), Record Keeping (with the local public-health caveat), ONE merged "Agentic support, but practitioner-controlled." section, privacy/trust, and pricing/CTA. The standalone mobile/iPad section was dropped; copy was sharpened and de-duplicated; the nav trimmed to Product/Records/Agentic support/Pricing/Sign in + Book walkthrough. The required docs/22 safety phrases stay (Assistant not decider, Draft not send, Flag not diagnose, Summarize do not invent, Human confirmation before external actions, No autonomous clinical decisions); Daily Prep Brief still described live + rules-based; anonymized demo data only; no medical/compliance/AI overclaims; no live-payment claim. Public marketing only: no authenticated app, payment, RLS, schema, or migration change. Pinned by tests/app/marketing-homepage.test.ts + e2e/marketing-homepage.spec.ts. Live payments still disabled.

## Earlier production status (as of PR #242)

- **Marketing site treatment-memory overhaul** (PR #242, public-only). The public homepage (`app/page.tsx`) is repositioned around the product thesis: Hone is the treatment memory system for permanent hair removal studios, not booking/practice-management/AI-advice/payment software. New arc and sections: hero ("Treatment memory for permanent hair removal studios."), calendar-vs-Hone comparison, Before Today, Daily Prep Brief (described LIVE + rules-based, matching PR #241), charting, Record Keeping (with the local public-health responsibility caveat), mobile/iPad, agentic practice support, agentic safety (aligned with docs/22), privacy/trust, $19/month founding pilot, final CTA. Visuals are coded mockups in the app's card/chip language with anonymized demo data ONLY (Maya R. / Demo Studio / lot L-204 / Sterex); never Chloe/Laura/Willow or real data. SEO metadata leads with the category ("Hone | Treatment Memory for Electrologists"). Shared marketing header/nav gained story-section anchors + a Book walkthrough CTA, overflow-safe via an lg breakpoint and a CTA in the mobile menu. No medical/compliance/AI overclaims; no claim live payments are active. Public marketing only: no authenticated app, booking, intake, charting, Calendar, Record Keeping, payment, RLS, schema, or migration change. Pinned by tests/app/marketing-homepage.test.ts + e2e/marketing-homepage.spec.ts. Live payments still disabled.

## Earlier production status (as of PR #241)

- **Daily Prep Brief V1** (PR #241, no migration). The first agentic-style workflow, RULES-BASED ONLY: no AI, no model call, no provider integration, no chatbot, no autonomous action. A pure helper (`lib/dashboard/daily-prep-brief.ts`) turns facts the Dashboard already loads (visible appointments, Before Today previews, the PR #236 linked-session charting state, intake status) into a deterministic, priority-ordered prep list rendered as a compact "Daily prep brief" card directly under Today. Zero new queries: the Before Today preview gained three passthrough fields already computed by `buildBeforeToday` (nextVisitNote, cautionNote, granular reminders); the Today-row preview is unchanged. Priority: 1 next-visit/caution note, 2 intake not reviewed, 3 charting needed, 4 missing-record reminder, 5 new client, 6 already charted. Recorded-history wording only; reads no sensitive surface (no exposure incidents / payment internals / Stripe ids / raw tokens / audit JSON); studio-scoped, no service-role, no public route, no model/provider call; links only to `/clients/<id>`; writes and sends nothing. This implements the docs/22 "Daily Prep Brief V1" workflow per the agentic safety plan. The remaining two workflows (Missing Records / Follow-up Assistant, Draft-only Client Message Assistant) are still future PRs. Live payments still disabled.

## Earlier production status (as of PR #240)

- **Agentic readiness and safety plan** (PR #240, docs-only). The strategic direction is to make Hone agentic, but safely: an operating memory system that prepares, flags, summarizes, and drafts from recorded treatment history, never a chatbot and never a decider. **No AI runtime, model call, endpoint, migration, schema, RLS change, or payment capability is added by this PR.** It adds `docs/22_AGENTIC_READINESS_AND_SAFETY.md`, the rules any agentic build must satisfy first: assistant not decider, draft not send, flag not diagnose, summarize recorded history (do not invent), require human confirmation before any external action, never silently mutate clinical history, never auto-charge, never auto-message clients. The doc fixes the safe read surfaces, the excluded sensitive surfaces (exposure incidents + audit payloads, payment internals, Stripe ids, raw appointment + calendar feed tokens, auth/session, cross-studio, anything outside RLS, mirroring Global Search V1 PR #232 and the exposure-incident owner tier PR #222), the hard prohibitions, per-action human confirmation rules, the safe-wording vocabulary, the first three future workflows (Daily Prep Brief V1, Missing Records / Follow-up Assistant, Draft-only Client Message Assistant), and the audit + RLS posture (same studio-scoped access, no service-role broad AI search, no cross-studio memory, no public AI endpoints, exposure incidents stay owner-tiered, Stripe grep gates still apply). The agentic roadmap starts with this safety plan; the next possible PR is Daily Prep Brief V1, read-and-draft only. Live payments still disabled.

## Earlier production status (as of PR #238)

- **Chloe pilot feedback cleanup** (PR #238, no migration). Her retest was strongly positive ("in a heartbeat now"); five UX-only fixes closed the remaining friction: mobile search input is text-base so iOS stops auto-zooming on focus (user zoom untouched); client page sections are a native select on phones (md+ keeps the tab row; same pick() navigation); the session page gains a Finish up section (explains per-piece saving, Done charting -> client Sessions tab, Review appointment & billing -> /calendar/<appt> when linked; links only, no new write path); Records section reads "Procedure records" with "Choose a client" + one-client helper (filter/print behavior unchanged, formal printed title unchanged); Dashboard puts Today first and collapses the Getting started card to a "Setup complete" footer link once all auto steps are done (incomplete keeps the card below Today; /getting-started route unchanged). Live payments still disabled.

## Earlier production status (as of PR #237)

- **Before Today visual hierarchy** (PR #237, no migration). The client-page briefing card now reads in pre-treatment order: Remember today (watch + For-next-visit note) first as the dominant blue band; Last treatment snapshot (date, areas, wrapping chips: modality, frequency, probe, lot, energy level, minutes); Client response (last recorded) with tolerance/reaction chips and the last treatment's reaction notes; Record reminders last. Pure reorder of lib/sessions/before-today.ts + components/before-today-card.tsx; two new pure input fields (blockMinutes, blockReactionNotes) mapped from already-selected block columns; no new queries, no rule changes. New-client empty state explains memory appears after the first charted session. Dashboard Today compact preview deliberately unchanged (latestSetupLine kept for it). Both E2E specs assert the new sections + phone overflow. Live payments still disabled.

## Earlier production status (as of PR #236)

- **Dashboard Today next actions** (PR #236, no migration). Each Today row shows ONE primary action from a pure resolver (lib/dashboard/next-action.ts): linked charted session -> View session + Charted chip; linked empty session -> Continue charting; completed uncharted -> Chart appointment + Charting needed chip; cancelled/no-show -> Open client; upcoming returning -> Review Before Today; upcoming new -> Open client. Two batched session/blocks reads; row body keeps the calendar link, action is a sibling button. Both E2E specs assert the action branches. Live payments still disabled.

## Earlier production status (as of PR #235)

- **Mobile charting comfort** (PR #235, no migration). The session page gains a "Risks & aftercare" section (same AftercareExplainedToggle + markAftercareExplainedAction as the Records row; no new write path) so the stamp is markable where charting happens; side chips bumped to comfortable touch size; sticky save bar deferred (documented). Mobile E2E now charts end to end at 390px with per-control reachability + viewport assertions and confirms the Before Today loop; iPad opens the charted session page with overflow asserted. Live payments still disabled.

## Earlier production status (as of PR #234)

- **Mobile header and search sheet polish** (PR #234, no migration). Mobile Search and Menu panels are viewport-fixed sheets under the header (fixed inset-x-3 top-16; the old icon-anchored absolute panel pushed the search input off-screen left). Menu identity block compact ("My account" headline when the display name is an email; studio · role; address as small tertiary text). Desktop search/account dropdown untouched. E2E geometry assertions (panels/input/Close fully inside viewport) + Close/Escape dismissal added. Also: a public-surface mobile sanity sweep (booking, confirmation, manage/cancel/reschedule, invalid token, intake) asserting no overflow and no authenticated-shell leakage; zero fixes needed; deeper /portal mobile polish deferred. Live payments still disabled.

## Earlier production status (as of PR #233)

- **Mobile client page polish** (PR #233, no migration). Client detail header is mobile-first (compact name, small Edit button, stacked contacts); Log session + Book appointment paired in one action row with a short helper; profile tab bar is a contained one-row scroller on phones (desktop unchanged). No action/business-logic change. E2E client-detail step extended (actions reachable, six tabs reachable, pinned notes visible, overflow assertions). Live payments still disabled.

## Earlier production status (as of PR #232)

- **Global Search V1** (PR #232, no migration). Header search on both breakpoints (desktop inline input; mobile magnifier icon + panel): clients (name/email/phone), appointments (client/service/status keyword), treatment memory (areas, cautions, reactions, probe labels/lots, next-session notes; safe labels), Records (sterile lots w/ traceability link, disinfectants), page shortcuts. Single user-scoped "use server" action, explicit studio_id on every query, caps (12 total), app-internal hrefs only; exposure incidents/audit payloads/payment internals/tokens excluded and pinned. No AI/index/external service; trigram-index follow-up documented. E2E coverage in both specs. Live payments still disabled.

## Earlier production status (as of PR #231)

- **Account menu + header navigation polish** (PR #231, no migration). Desktop primary nav = Dashboard/Clients/Calendar/Records; Settings/Admin/Sign out moved into a new account dropdown (first-name trigger, aria-expanded, profile block with name/studio/role, Settings + Getting Started + Admin + Sign out; same dismissal model as MobileMenu). Mobile Menu reordered as an account panel (profile block on top, nav, then Settings/Getting Started/Admin/Sign out). Bell unchanged on both breakpoints. All PR #228-#230 header/calendar behaviors retained and E2E-asserted. Live payments still disabled.

## Earlier production status (as of PR #230)

- **Mobile menu outside-tap dismissal** (PR #230, no migration). MobileMenu closes on any pointerdown outside its root (listener active only while open); link-tap/current-page/Escape/Sign-out dismissal from PR #229 unchanged; bell stays independently usable. Also: the authenticated Hone wordmark is a Dashboard link again (aria-label "Go to Dashboard"; old Today-tab conflict no longer applies; marketing header untouched). E2E outside-tap + wordmark-navigation steps added; all PR #228/#229 mobile assertions retained. Live payments still disabled.

## Earlier production status (as of PR #229)

- **Mobile header polish** (PR #229, no migration). Mobile Menu is now a client component that auto-closes on every link tap (incl. current page), Escape, and Sign out (`app/(app)/MobileMenu.tsx`; the PR #228 details element stayed open across client-side navigations). Notifications moved from a nav tab to a header bell on both breakpoints (server-rendered link + unread badge; accessible name carries the count); desktop Notifications tab removed. Notifications page/badge logic and PR #228 calendar touch-safety unchanged (E2E regression green). Live payments still disabled.

## Earlier production status (as of PR #228)

- **Mobile and iPad UX stabilization** (PR #228, no migration). Phone nav overflow fixed: full nav row is md+ only; phones get a details/summary Menu (all destinations + badge + Sign out). Calendar touch safety: grid drag/click-create is mouse-only, `touch-action: manipulation` restores native scrolling, explicit coarse-pointer-only "+" button per day column opens the quick-book drawer (time editable); week grid scrolls inside its card on phones (min-w + existing overflow-x-auto). No booking/business-rule change. Proven by e2e/mobile-ux.spec.ts (iPhone + iPad + desktop-regression contexts) plus 10 source pins; manual native-gesture smoke in docs/12. Live payments still disabled.

## Earlier production status (as of PR #227)

- **Browser E2E core memory loop** (PR #227, no migration). Playwright (Chromium, one spec) drives the full treatment-memory loop against a LOCAL production build + LOCAL Supabase stack: booking, intake, REAL magic-link login via Mailpit (no auth bypass; invite-path account), dashboard + charted-24h wording, charting with clinical-memory fields, second booking, Before Today memory, filtered procedure record + print + aftercare mark, anonymous lockout. New separate `browser-e2e` CI job (local stack, no secrets, traces on failure only); `npm run test:e2e` locally after `supabase start` + `db reset`. Local-only by construction (hosted URLs refused; supabase-demo JWTs only; dummy provider keys). supabase/config.toml allow-lists the localhost:3111 E2E origin (local-only setting). Pins in tests/scripts/e2e-guardrails.test.ts. Live payments still disabled.

## Earlier production status (as of PR #226)

- **Post-hardening docs drift cleanup** (PR #226, docs/source-pin only). Root-level and operational docs corrected to the post-#218/#220/#221/#222/#223/#224/#225 reality: canonical charge path `session-payment-charge.ts` (CONTRIBUTING, docs/11, docs/14 guidance blocks), `payment_charge_attempts` as the canonical CHECK-pinned ledger (README), db-integration lane + types drift check acknowledged (README, docs/00, docs/03), supervised-pilot vs paid-launch line stated (docs/00), docs/11 dormancy recipes fixed to query both ledgers and expect the right gate output. 11 pins in tests/docs/docs-drift-pr226.test.ts. No runtime change. Live payments still disabled.

## Earlier production status (as of PR #225)

- **Charted-within-24h metric** (PR #225, no migration). Practice Snapshot card: completed appointments (status `completed`, `ends_at` in the rolling last 7 days) vs those whose earliest non-deleted linked session_block was created within 24h of `ends_at` (inclusive). Pure `summarizeChartedWithin24h` + three batched user-scoped reads in `getPracticeDashboardMetrics`; sessions with zero areas do not count as charted; studio-level only, never per-practitioner; no score/compliance wording (pinned). Empty state "No recent completed sessions yet." No RLS/payment change. Live payments still disabled.

## Earlier production status (as of PR #224)

- **New studio setup runbook** (PR #224, docs-only). `docs/20_NEW_STUDIO_SETUP_RUNBOOK.md`: internal operator checklist for safely creating Studio #2 (inputs; two approved SQL inserts: studio + owner invitation via the 0081 invite path; in-app config for the rest; surface verification; Willow isolation checks; ZZ-TEST smoke with delete-hardening-respecting cleanup; do-not-touch list; known limitations). Not a user-facing onboarding surface; no runtime/migration/RLS/payment change. Safety content pinned in tests/docs/new-studio-runbook.test.ts. Live payments still disabled.

## Earlier production status (as of PR #223)

- **Per-client procedure record filter + print** (PR #223, no migration). Records → Client Procedure Records: client select + optional studio-timezone date range (GET form, shareable URL); print accepts the same params (`/records/print?section=procedures&clientId&from&to`) with a "Filtered: client ..." header line and a clear empty state. Default 30-most-recent view unchanged; filtered pulls capped at 200 (cap explained in UI). Shared `utcInstantsForLocalDayRange` keeps screen and print identical; params sanitized via `normalizeProcedureRecordFilter`. machine_frequency now shown on items lines where recorded. No RLS change; studio scoping + user-scoped client unchanged; PR #222 exposure tier untouched. Live payments still disabled.

## Earlier production status (as of PR #222)

- **Exposure incident owner access tier** (PR #222, **migration 0088, policy-only; apply to prod BEFORE merge after SQL approval**). `record_keeping_exposure_incidents`: SELECT/UPDATE owner-only (`is_studio_owner`), INSERT stays member-wide (staff can report without browsing history), still no DELETE. Audit SELECT carve-out: exposure-incident audit rows owner-only (they carry old/new values); other record types unchanged; immutability untouched. UI: owner-only note for non-owners on Records + Print (Add form stays); update action role-checks. Privacy hardening before multi-practitioner studios; no change for solo Willow. 10 new DB-lane tests. Live payments still disabled.

## Earlier production status (as of PR #221)

- **Generated types drift check** (PR #221, no migration). `scripts/check-db-types.mjs` (`npm run check:db-types`; runs in the `db-integration` CI job after `npm run test:db`) regenerates types from the LOCAL migrated database (`supabase gen types typescript --local`, hardcoded local) and exact-matches column sets both directions for 15 curated tables vs the hand-rolled `lib/types/database.ts`, pins 11 recent columns individually, and asserts DB-side presence of the relied-upon payment/webhook columns. First run caught six live columns missing from the app types (calendar_feed_token_hash, terms/privacy stamps, normalized_email); declarations added (types-only, additive). Hosted/non-localhost env URLs refused; no production access. Pins in `tests/scripts/db-types-drift.test.ts`. Deferred: nullability comparison, non-curated tables. Live payments still disabled.

## Earlier production status (as of PR #220)

- **DB/RLS integration test harness** (PR #220, no migration). `tests/db/` + `npm run test:db` (vitest.db.config.ts) run against a LOCAL Supabase Postgres only: `supabase db start && supabase db reset --local` applies migrations 0001-current from scratch, then the suites exercise real RLS/triggers/claim-RPCs/constraints as the `authenticated` role (request.jwt.claims simulation). v1 covers cross-studio isolation, audit immutability + triggers, the 0087 delete posture, the double-booking constraint (incl. buffer trigger), and claim_email_send / claim_session_payment_charge_attempt. New CI job `db-integration` (separate from the fast lane; no secrets, no --linked). The harness refuses non-localhost/hosted URLs by construction; guardrails pinned in `tests/scripts/db-harness-guardrails.test.ts`. Deferred: generated-types drift check, portal/anon token-route policies, storage policies, browser E2E. Live payments still disabled; payment runtime untouched.

## Earlier production status (as of PR #218)

- **Dead legacy fee executor removed** (PR #218, no migration). `lib/billing/manual-fee-charge.ts` deleted (zero runtime imports since #196); legacy `manual_fee_charge_attempts` stays as read-only history (one SELECT in eligibility). Stripe gate tightened: paymentIntents.create exactly 1 (unified executor only); other gates unchanged. 36 per-PR gate-pin clones consolidated into the canonical gates test. Live payments still disabled; docs/18 blockers unchanged.

## Earlier production status (as of PR #217)

- **Clinical RLS delete hardening** (PR #217, **migration 0087, policy-only; apply to prod BEFORE merge after SQL approval**). Production catalog confirmed live FOR ALL policies let authenticated members hard-delete clinical history; 0087 replaces them with per-command policies: NO DELETE on clients/sessions/session_blocks/photos/probe_lots/intake/tags/goals/personal-notes; DELETE kept explicitly only for entries/plan-stages/client-pricing (real UI affordances). App fixes: block-cleanup soft-deletes; plan rollback closes (old delete was a silent no-op since 0024). DB/RLS integration harness still an open follow-up. Live payments still disabled.

## Earlier production status (as of PR #216)

- **Getting Started future-onboarding section removed** (PR #216, no migration). /getting-started keeps the six sections + first-consultation readiness; the "Before onboarding another practitioner or studio" section is gone (scale checklist, not user setup); the record-keeping public-health caveat relocated into the first-consultation section; live-payments-off posture unchanged; Dashboard card and honest progress counts unchanged. Live payments still disabled; docs/18 blockers unchanged.

## Earlier production status (as of PR #215)

- **Getting Started checklist** (PR #215, no migration). `/getting-started` + Dashboard progress card: six sections (basics/booking/charting/records/daily/payments) with auto-detected Done/To-do from existing data + Review guidance badges; honest progress counts auto items only; first-consultation and Laura-readiness lists; payments posture explicit (live off, reviews pending). No manual mark-done persistence in V1 (migration deliberately deferred). Live payments still disabled; docs/18 blockers unchanged.

## Earlier production status (as of PR #214)

- **Clients needing attention** (PR #214, no migration). Fourth Action-needed card + compact list on the Dashboard (top 5, "+ N more"): clients flagged by their newest watch/caution note or next-visit plan (PR #203 per-client rule) or a notable recorded reaction on the most recent charted session; tolerance shown only alongside another reason; watch-first sorting; two batched reads, 200-session cap. Recorded-history surfacing only (unsafe wording pinned absent). All deferred Dashboard follow-ups now closed except record-keeping CSV export + traceability print. Live payments still disabled; docs/18 blockers unchanged.

## Earlier production status (as of PR #213)

- **Probe lot traceability** (PR #213, no migration). Record Keeping -> Sterile Items gains a lot search + per-record Trace usage (`/records?section=sterile&lot=...`): matching sterile-item details + every treatment area recorded with the lot (client/date/area/operator/setup/aftercare status, linked). Exact normalized matching (trim + case-insensitive escaped ILIKE; never fuzzy). Traceability, not causation (pinned). Print/export for traceability deferred (screen-only v1). Live payments still disabled; docs/18 blockers unchanged.

## Earlier production status (as of PR #212)

- **Before Today previews on Dashboard Today** (PR #212, no migration). Each Today roster row shows a compact briefing (Remember line with Watch-over-Plan, Latest setup, Records reminder count) rendered from the exact PR #211 pipeline via three batched reads (never per-appointment). Full Before today card unchanged on the client Overview. Read-only; recorded-history wording. Live payments still disabled; docs/18 blockers unchanged.

## Earlier production status (as of PR #211)

- **Before Today card** (PR #211, no migration). Pre-treatment briefing on the client Overview (below Client info, above Treatment Intelligence): last treated areas+date, Remember today (watch/plan + latest reaction/tolerance, blue memory styling), latest recorded setup, and record reminders using the procedure-completeness field rules (missing lot/aftercare/DOB/phone/address). Pure assembler over data the page already loads; recorded-history wording only (overclaim words pinned absent); clean empty states. Live payments still disabled; docs/18 blockers unchanged.

## Earlier production status (as of PR #210)

- **Client Treatment Intelligence Summary** (PR #210, no migration). Treatment Intelligence card on the profile Overview (pure builder over sessions + session_blocks + entry hairs): overall sessions/areas/minutes/hairs/hairs-min/first-last treated, per-area cards (grouped case-insensitively; latest recorded setup; commonly recorded reaction; watch notes), client-level reaction/tolerance, Notes to remember (latest watch + plan). Recorded-history wording only (overclaim words pinned absent); "Not recorded" for gaps; empty state for uncharted clients. Live payments still disabled; docs/18 blockers unchanged.

## Earlier production status (as of PR #209)

- **Header navigation fit** (PR #209, no migration). Top-nav label shortened to "Records" (route /records and the "Record Keeping" page heading unchanged); nav links are whitespace-nowrap with a tighter sub-md gap so the post-#208 header fits without wrapping. UI-only. Live payments still disabled; docs/18 blockers unchanged.

## Earlier production status (as of PR #208)

- **Practice Dashboard V1** (PR #208, no migration). /dashboard (nav renamed Dashboard; still the login landing; Today roster preserved as a section) gains a period filter (today/week/month, default week, studio tz), appointment counts, booked/completed SERVICE VALUE (service-menu prices; never "revenue"; required helper copy pinned), an explicit payments-posture card (live Off / test Available / collected revenue not enabled; period test-mode counts), and action cards (incomplete procedure records / missing probe lots / aftercare not marked -> Record Keeping procedures). Clients-with-watch-notes deferred. Live payments still disabled; docs/18 blockers unchanged.

## Earlier production status (as of PR #207)

- **Record Keeping print / export** (PR #207, no migration). Protected `/records/print?section=...` renders an inspector-friendly print document per section (studio + generated UTC stamp header, all BodySafe fields, "Not recorded" for gaps, created/updated stamps, opt-in ?history=1 audit appendix); window.print() with chrome print:hidden; Print / Export button on each Record Keeping section. No CSV/PDF/email/storage. Not a compliance guarantee; public-health review still needed. Live payments still disabled.

## Earlier production status (as of PR #206)

- **Record Keeping audit trail + edit** (PR #206, **migration 0086**: `record_keeping_audit_events`, SELECT-only RLS, trigger-written via narrow security-definer functions; apply to prod BEFORE merging). Append-only for normal users (no insert/update/delete/for-all policies); events: logbook created/updated diffs, aftercare_marked/cleared, probe_lot_updated (column-scoped, no noise). Edit forms shipped for the three logbooks (no delete/archive anywhere). History expanders in the Record Keeping UI. Not a compliance guarantee; public-health review still needed. Live payments still disabled.

## Earlier production status (as of PR #205)

- **Record Keeping tab + probe lot numbers** (PR #205, **migration 0085**: three RLS record tables + `session_blocks.probe_lot_number` + `sessions.aftercare_and_risks_explained_at/_by`; additive; apply to prod BEFORE merging). Top-level `/records` tab (not under Settings) with Sterile Items / Disinfectants / Exposure Incidents (sensitive; studio-RLS) / generated Client Procedure Records ("Not recorded" for missing data; explicit reversible aftercare toggle). Probe lot/batch captured in charting (Probe section), shown in area summaries and procedure records. Record-keeping support, not a compliance guarantee; needs public-health review. Live payments still disabled.

## Earlier production status (as of PR #204)

- **Charting field order + blue From-last-visit band** (PR #204, no migration). Treatment-area form order matches Chloe's flow: area, frequency, probe, mode, modality (+EL), readings, pulse count, hairs treated, minutes performed (layout-only; payload/copy/sticky unchanged). "From last visit, for today" renders BLUE everywhere (treatment memory, not warning); same PR #203 pre-client source. Live payments still disabled; enablement blockers unchanged (docs/18 §16).

## Earlier production status (as of PR #203)

- **Sticky machine frequency + chip polish + Sessions Watch/Plan source** (PR #203, **migration 0084**: `practitioners.default_machine_frequency`, additive + nullable; apply to prod BEFORE merging). Machine frequency toggle defaults from the practitioner's last-used value (saved best-effort by the treatment-area save actions; editable per area; block row still stores the actual value). Reaction/response chips show leading + like the other observation chips. The Last treatment card's Watch/Plan band uses `pickPreClientWatchPlanSource` (newest session with any watch/plan content), matching the charting page's pre-client context. Live payments still disabled; enablement blockers unchanged (legal/accounting review + Willow Stripe checklist, docs/18 §16).

## Earlier production status (as of PR #202)

- **Payment default service label** (PR #202, UI/copy only). The Session payment prepare form shows "Booked service: <name> (<N> min)" directly under the Amount field whenever the PR #200 default resolved (both service-price and custom-pricing sources; reminder line kept; field editable; no fake label when no default). No resolver/action/executor/gate change. **Numbering: controlled live enablement (docs/18 "PR #202") shifts to the next available PR number.** PR #196 fee smoke closed; live payments still disabled; remaining enablement blockers: legal/accounting review + Willow live Stripe checklist (docs/18 §16).

## Earlier production status (as of PR #201)

- **Live payments gate preparation** (PR #201, no migration, NO live enablement). Receipt template renders a cautious live-mode variant behind `livemode` (default false; test branch byte-identical; sender pins `livemode: false` and refuses non-test rows, so live copy is unreachable; final wording needs legal/accounting review). **Refunds are owner-only** across session payments and fees ("Only the studio owner can issue a refund."). Audit decision: the ledger row is the audit record (no new table). Stale pending_stripe recovery verified already shipped (deterministic idempotency + reconciliation + ops alerts). docs/18 §16: UI copy map, Willow Stripe readiness checklist, legal/accounting checklist, PR #202 runbook (FUTURE ONLY). **PR #196 fee smoke is fully closed** (both legs backend-verified clean 2026-06-11; gate on PR #201 cleared). Live payments still disabled.

## Earlier production status (as of PR #200)

- **Last treatment warning placement + service price default** (PR #200, no migration). The "From last visit, for today" Watch/Plan box is now a flush footer band INSIDE the Last treatment card (`attached` variant on `FromLastVisitForToday`; `hasFromLastVisitContent` gate; once per Sessions tab; entries-fallback sessions no longer drop their plan note). Session payment prepare amount defaults from the booked service via the pure `resolveSessionPaymentDefault` (`lib/billing/session-payment-default-amount.ts`): client custom pricing (name-matched, newest effective, future-dated ignored) > service menu price > historical session price > blank; source copy shown, field stays editable, practitioner can override before preparing. Executor/eligibility/gates untouched; no Stripe call in defaulting. **PR #196 fee smoke still pending; live payments still disabled.**

## Earlier production status (as of PR #199)

- **Last treatment + charting redundancy + client info cleanup** (PR #199, no migration). Sessions-tab top card is now **Last treatment**: `pickLastTreatment` (pure helper in `lib/sessions/clinical-summary.ts`) picks the most recent session with charted areas or legacy entries, so a newer empty session can't blank the pre-appointment summary ("Most recent charted treatment" note when that happens; empty state "No charted treatments yet."). ONE "For next visit" surface: per-area next-visit/caution inputs removed from the charting form (caution columns untouched; data round-trips and still renders in watch lines). ONE "Performed by" surface: inline line under the session title with Edit (new `SessionPerformerLine`; `session-info-card.tsx` deleted). Detach renders inside the treatment plan card (`detachSlot`). Birthday is a plain row in Client info (no nested box/helper; edit via the card's Edit link). **PR #196 fee smoke still pending; live payments still disabled.**

## Earlier production status (as of PR #198)

- **Chloe iPad retest fixes** (PR #198, no migration). Messages tab works (`isProfileTab` had omitted "messages"); Last Session pinned to carry cautions/next-visit context; charting order readings -> Client tolerance (rating only) -> Treatment observations (reaction chips, same reaction_type field) -> For next visit; session header price block removed (performed-by editable); Overview "Client info" card (birthday + emergency + address, Edit link); calendar today contrast raised again. **PR #196 fee smoke still pending; live payments still disabled.**

## Earlier production status (as of PR #197)

- **Chloe launch polish round 3** (PR #197, no migration). Unified History group (Charted + Session history merged; walk-in fallback list); Last session keeps per-area settings; one free-text box per area in charting (Client tolerance = rating + dropdown; legacy response notes still visible); session price is a collapsed optional disclosure (no more "$0"); dedicated Messages tab (off Overview); Overview ordered pinned/allergies/Skin first; stronger calendar day separators. Backlog: retail/add-on tracking. **PR #196 fee path still needs its production test-mode fee smoke; live payments remain disabled.**

## Earlier production status (as of PR #196)

- **Payment ledger unification** (PR #196, migration 0083). Fees (no-show / late-cancel) now prepare, charge, receipt, refund, and reconcile on `payment_charge_attempts`; the legacy `manual_fee_charge_attempts` table gets no new runtime writes (historical rows readable). Claim RPC reason guard widened (0083) with three additive evidence columns. Live payments still blocked; gates unchanged. docs/18 P0 #2 closed; remaining blockers: live receipt copy + legal/accounting review, test-mode copy pass, controlled enablement.

## Earlier production status (as of PR #195)

- **Ops alert app-path smoke action** (PR #195, no migration). Admin-only "Send test critical alert" button on `/admin/ops-alerts` calls the real `recordOpsAlert` (event `smoke_test_critical_alert_app_path`), deterministically exercising the durable-row + critical-email pipeline added in PR #193. `OPS_ALERT_EMAILS` is set in Production and baked in via redeploy `8a5a3e3`.

## Earlier production status (as of PR #194)

- **Chloe launch polish round 2** (PR #194, no migration). Treatment time card reframed as a tracker (goal UI hidden); collapsible session groups (only Needs charting open; Cancelled and no-shows merged; Session history renamed + collapsible); one-tap "Copy areas and settings from last session" onto an empty chart (never copies client response; duplication-proof); client-page Last session uses the shared per-area summary; treatment-plan card owns plan context (detach-only attachment state, redundant session-number line hidden when attached); "Session price" replaces "Price paid"; "For next visit" replaces "Plan for next visit"; Overview puts allergies first and collapses messages; birthday collects an optional real YEAR on date_of_birth (no migration); calendar today contrast strengthened for iPad. Deferred: practitioner portal/intake preview, studio logo upload. **Pre-launch blocker: awaiting Chloe's health inspector documents.** Rollout: Laura after Chloe's real consultations; Teresa (laser) later; Brooks later; calendar sync not required for launch. No payment/Stripe/auth/export/reminder change (gates unchanged from PR #193).

## Earlier production status (as of PR #193)

- **Ops alerts dashboard + critical notifications** (PR #193, no migration). The docs/18 §6 P0 live-payment blocker is closed: `/admin/ops-alerts` (ADMIN_EMAILS-gated) lists unresolved alerts critical-first with safe metadata and a conditional mark-resolved action (0067's `resolved_*` columns; no migration); `recordOpsAlert` dispatches a critical-only operator email AFTER the durable insert via the new standalone `lib/ops/alert-email.ts` (reads `OPS_ALERT_EMAILS`, bare Resend client, no appointment-email import, never calls recordOpsAlert, never throws; unset env = dashboard/rows still work). **Set `OPS_ALERT_EMAILS` in Production to activate emails.** Remaining live-payment blockers: ledger unification (#194), live receipt copy + legal/accounting review (#195), test-mode copy + controlled enablement (#196). Stripe gates unchanged from PR #192.

## Earlier production status (as of PR #192)

- **Live payments readiness audit** (PR #192, docs + gate-pin tests only; no runtime change). `docs/18_LIVE_PAYMENTS_AUDIT.md` is now the current readiness picture: **NOT READY FOR LIVE PAYMENTS (4/10; internal test-mode only)**. P0 blockers: ops-alert human visibility, fee-ledger unification, live receipt copy, legal/accounting review, test-mode copy pass. Agreed sequence: #193 ops alerts dashboard/notifications, #194 ledger unification, #195 gate preparation, #196 controlled enablement. Stripe gates verified unchanged and strong.

## Earlier production status (as of PR #191)

- **Treatment memory UX cleanup** (PR #191, no migration). Eight fixes from Chloe's practitioner smoke of PR #190: plan-area seed applies only to a session's first treatment area (no auto-filled repeat areas); "Copy settings from last treatment area" copies the full configuration (now incl. minutes), prefers a same-named area, and explains what it copied; "Plan for next visit" shows explicit saved/cleared/error feedback (action returns a result); back navigation from session pages lands on the client's Sessions tab; last-session summaries are PER treatment area (`areas[]` + `watchLines[]` in `lib/sessions/clinical-summary.ts`, shared render in `components/last-session-summary.tsx`); the duplicate amber/blue warning boxes merged into one "From last visit, for today" box (Watch + Plan); the charting form is bucketed into Treatment observations / Client/skin response / For next visit; the Sessions tab is ordered treatment time, last session, Needs charting above Upcoming, then "Session history" (renamed from "All sessions"). Practitioner copy says "treatment area", never "block". No payment/Stripe/auth/export/reminder change (gates unchanged from PR #190).

## Earlier production status (as of PR #190)

- **Clinical memory moat, phase 1** (PR #190, migration 0082). `session_blocks` gains structured client response (`tolerance_rating` CHECK 1..5, `reaction_type` CHECK 7-value vocabulary, `reaction_notes`, `caution_for_next_session`, `caution_note`); `sessions` gains `next_session_note`. Captured in the charting form's optional "Client response" section and the session page's "Plan for next visit" card. Surfaced at the point of care through the shared unit-tested `lib/sessions/clinical-summary.ts` formatter: upgraded appointment detail "Last session" card (areas, settings, probe, worst tolerance, reactions, caution, next-visit note), new-session "Previous session context" panel, and a "From last visit, for today" charting banner. All additive and nullable; pre-#190 records render unchanged; no RLS change; no payment/Stripe/auth/export/reminder change (gates unchanged from PR #189).

## Earlier production status (as of PR #189)

- **Pilot-safety fixes: email claim, export gate, invite-only login** (PR #189, migration 0080). (1) The 24h/2h reminder cron now claims each row atomically via `claim_email_send` (mirror of the SMS claim from 0049: conditional UPDATE on sent-is-null + 3-attempt cap + 5-minute stale-claim window; new `confirmation/reminder_24h/reminder_2h_claimed_at` columns) before calling Resend, and records outcomes via `record_email_result` (stamps sent_at on success, clears the claim, no double-increment); overlapping cron runs can no longer double-send, and both RPCs are service_role-only. Unclaimed one-shot email paths keep `record_email_attempt`. (2) `exportStudioDataAction` is owner-only with a generic refusal, and every successful export writes a fail-closed `audit_logs` row (`studio_export`, actor, studio, filename + file list + row counts). (3) Practitioner login is invite-only at two layers: the magic-link request runs through a server action gating `shouldCreateUser` on a pending invitation (generic responses, no enumeration oracle), and migration 0081 removed `handle_new_user()`'s no-invite fresh-studio fallback so even Google OAuth (which cannot pass shouldCreateUser) provisions no studio/practitioner for uninvited users; the invited arm (inviting-studio placement + terms stamping) is unchanged. No payment, Stripe (gates unchanged from PR #187), live-mode, portal, SMS, calendar-feed, or availability change.

## Cumulative status through PR #188 (2026-06-10)

HISTORICAL snapshot as of PR #188; the rolling "Current production status" entries at the top of this doc supersede it. Kept for the detailed per-PR history below.

**Payment status:** Test-mode session payments are built end-to-end. Live payments are still blocked. Fees are not active.

**Stripe gate status** (pinned by `scripts/check-stripe-gates.mjs` + per-PR tests):

```text
paymentIntents.create   exactly 2  (lib/billing/manual-fee-charge.ts, lib/billing/session-payment-charge.ts)
                                   [superseded: exactly 1 in session-payment-charge.ts since PR #218]
refunds.create          exactly 1  (lib/billing/payment-refund.ts)
charges.create          0
checkout.sessions       0
STRIPE_ALLOW_LIVE_MODE  guarded    (string appears only in lib/stripe/server.ts error message)
```

**Completed (PRs #170-#187):**

```text
#170  Card authorization current-version gate
#171  Canonical payment_charge_attempts ledger
#172  Prepare session payment
#173  Run Stripe test charge
#174  Payment status UX
#175  Test-mode receipts
#177  Card authorization pointer refresh
#178  Test-mode refunds
#179  Webhook reconciliation
#180  Appointment completion/session-start workflow unblock
#181  Session completion to billing UI cleanup
#182  Calendar feed token hash-at-rest phase 1
#183  Portal last_seen_at fix
#184  DST two-pass conversion fix
#185  localTimeString 24:xx normalization
#186  Explicit server-only dependency
#187  Waitlist/demo public form rate limits
```

**Still open:**

```text
Live payment readiness
Legal review of card authorization wording
Tax/HST decision
Statement descriptor review
Off-session SetupIntent confirmation before live
Live runbook
Dispute response runbook
Willow live Stripe onboarding
Supervised first live charge
Late cancellation/no-show fee charging
manual_fee_charge_attempts unification/retirement
Calendar feed phase 2
Docs/launch checklist final polish
```

**Calendar feed phase 2:** Not started. A parked WIP commit exists locally (branch `claude/calendar-feed-token-hash-phase-2`, not pushed). Do not proceed until real Google/Apple calendar subscriptions are confirmed still polling cleanly after phase 1. Renumber the old parked PR/migration labels before using.

## Earlier production status (as of PR #187)

- **Waitlist + demo request rate limiting** (PR #187, no migration). The anonymous landing-page actions `submitWaitlistEntry` and `submitDemoRequest` previously had no rate limit. Both now route through `lib/rate-limit/public.ts` via new `limitWaitlistSubmit` / `limitDemoRequestSubmit` helpers (shared `limitMarketingForm` implementation): 5/hour per IP + 2/day per normalized email, checked after validation and before the Supabase insert, with namespaced Redis prefixes (`rl:waitlist_*`, `rl:demo_*`), SHA-256-hashed identifiers, the shared generic `RATE_LIMIT_MESSAGE` refusal copy, and the module's standard FAIL-OPEN posture on Upstash outage. No raw body or PII logging. No payment behavior change, no Stripe behavior change (gates unchanged from PR #186), no migration, no email/SMS sending, no portal or calendar feed change.

## Earlier production status (as of PR #186)

- **Explicit server-only dependency** (PR #186, no migration). `server-only@0.0.1` is now declared in `dependencies`. The 23 runtime server modules using `import "server-only"` as a client-bundle security boundary previously resolved the package only through Next's internal vendored alias; it was missing from package.json and the lockfile, so a Next upgrade could have silently weakened the boundary. No runtime behavior change intended; the Vitest stub alias is unchanged and takes precedence in tests. `tests/dependencies/server-only-explicit.test.ts` pins the declaration. No payment behavior change, no Stripe behavior change (gates unchanged from PR #185), no migration, no portal logic change, no calendar feed phase 2.

## Earlier production status (as of PR #185)

- **localTimeString hour-24 normalization** (PR #185, no migration). Some ICU builds resolve Intl's `hour12: false` to the h24 hour cycle and render hour 0 as "24" ("24:30" instead of "00:30"); the PR #184 CI run surfaced this when its runner ICU emitted 24:xx where dev machines emitted 00:xx. `lib/booking/tz.ts:localTimeString` now rewrites a leading `24:` to `00:` via a private `normalizeHour24` helper, so HH is always 00-23 on every runtime (calendar grid labels, dashboard roster, SMS templates). `tzOffsetMinutes` already guarded the same quirk numerically; `localTimeString12h` (h12 cycle) and `localDateString` (date-only) are unaffected and pinned by test; `utcInstantFromLocal` untouched. The PR #184 DST round-trip tests now exercise the production normalization directly (the test-side copy was removed). No conversion logic change, no payment behavior change, no Stripe behavior change (gates unchanged from PR #184), no migration, no new dependency.

## Earlier production status (as of PR #184)

- **DST two-pass offset correction in utcInstantFromLocal** (PR #184, no migration). `lib/booking/tz.ts:utcInstantFromLocal` previously applied a single offset correction sampled at the naive instant; when the naive and corrected instants straddle a DST transition the sample is the pre-transition offset and local times in the hours after a spring-forward jump were stored one hour late (Toronto 2026-03-08 `03:30` -> `08:30Z` -> rendered back `04:30`; `05:30` -> `10:30Z` -> `06:30`). The fix re-samples the offset at the corrected instant and re-applies when it differs. Behavior is unchanged for every wall-clock time that exists: normal days, already-correct DST-day times, and the fall-back ambiguous hour (still resolves to the first, pre-transition occurrence). Only nonexistent spring-forward gap times changed convention (now map one hour before the wall string; pinned by test). Regression suite `tests/lib/booking/tz-dst-two-pass.test.ts` covers Toronto spring-forward round-trips (03:30, 05:30, 09:00, 00:00), 23/24/25-hour day-window spans, fall-back conventions, and zero-dependency pinning. No payment behavior change, no Stripe behavior change (gates unchanged from PR #183), no migration, no new dependency, no portal or calendar feed change.

## Earlier production status (as of PR #183)

- **Client portal session last_seen_at lazy-builder fix** (PR #183, no migration). `lib/portal/session.ts:getCurrentPortalSession` previously "fired" the `last_seen_at` touch as a bare `void admin.from("client_portal_sessions").update({ last_seen_at: nowIso }).eq("id", data.id);`. Supabase/PostgREST builders are lazy thenables: without `await` or `.then(...)` no request is sent, so `last_seen_at` was never written despite the fire-and-forget comment. The fix appends `.then(onFulfilled, onRejected)` so the update actually executes while staying un-awaited (a slow touch never blocks the portal render). The fulfilled arm inspects the PostgREST `{ error }` result, the rejected arm covers transport throws; both log the sanitized structured event `portal_session_last_seen_update_failed` with only the session id, error code/message, and timestamp (no cookie token, no token hash, no email, no client PII). A failed touch still resolves the session normally. No schema change (`last_seen_at timestamptz` exists since migration 0052), no auth behavior change (hash lookup, revoked/expired checks, cookie attributes, login timing padding all untouched), no payment behavior change, no Stripe behavior change (gates unchanged from PR #182: 2 allowlisted `paymentIntents.create`, 1 allowlisted `refunds.create`, zero `charges.create`/`checkout.sessions`, 1 allowlisted `STRIPE_ALLOW_LIVE_MODE=true` string), no calendar feed phase 2, no SMS.

## Earlier production status (as of PR #182)

- **Calendar feed token hash-at-rest, phase 1** (PR #182, migration 0079). Closes `docs/13` security backlog item "Hashed `practitioners.calendar_feed_token` | Currently stored raw" for the runtime route + future rotations without breaking existing in-the-wild feed URLs. Migration 0079 adds nullable `practitioners.calendar_feed_token_hash text` + a 64-hex-char CHECK + a partial unique on the hash + a backfill via `encode(extensions.digest(calendar_feed_token, 'sha256'), 'hex')` (pgcrypto already enabled by migration 0001; Supabase installs it under the `extensions` schema, matching the 0032 precedent). The runtime feed route `app/calendar-feed/[token]/route.ts` now hashes the URL token via the new `lib/calendar-feed/token.ts:hashCalendarFeedToken` helper and looks up by `calendar_feed_token_hash`; the raw `calendar_feed_token` column is no longer in the route's SELECT list so a database read that leaks a row to logs does not include the bearer token. `rotateCalendarFeedTokenAction` + `clearCalendarFeedTokenAction` in `app/(app)/settings/profile/actions.ts` now use the shared `generateCalendarFeedToken` + `hashCalendarFeedToken` helpers and write BOTH columns (rotate writes both; clear nulls both). The raw column is intentionally KEPT in phase 1 for rollout safety because `CalendarFeedCard.tsx` still renders the existing URL from the raw column on page render; phase 2 (a later PR) refactors the UI to display the URL only at rotation time and then nulls the raw column. Prod verified post-migration: 2 practitioners had raw tokens; both now have well-formed 64-hex hashes; zero raw-without-hash or hash-without-raw mismatches; live-mode CHECKs intact. Stripe gates unchanged from PR #181 (2 allowlisted `paymentIntents.create`, 1 allowlisted `refunds.create`, zero `charges.create`/`checkout.sessions`, 1 allowlisted `STRIPE_ALLOW_LIVE_MODE=true` string). No SMS, no email, no payment behaviour change, no RLS change, no payment_charge_attempts touch.

## Earlier production status (as of PR #181)

- **Session completion to billing workflow + payment UI cleanup** (PR #181, no migration). Two surfaces touched. Calendar: new `NextStepCard` on `app/(app)/calendar/[id]/page.tsx` replaces the bare `Completed` placeholder. Renders "Appointment completed" + "Next step: chart the session and bill the client." + ONE primary CTA chosen from three states: no linked session -> `Start session` (forwards to `/clients/<id>/sessions/new?appointment_id=<id>`), linked unstarted session -> `Open session`, linked started session -> `Go to billing` (deep-links to `#session-payment` on the session page). `ChartSessionCard` is now hidden when status is `completed` so the new card owns the CTA surface (it still renders for confirmed / no_show; cancelled hides both). Session payment card cleanup (`components/session-payment-prepare-card.tsx`): (1) the stale "Session payment prepared / Attempt id: ... / No charge has been run / Refresh to see the persisted state" banner is replaced with a concise "You can now run the test charge." line gated on `!activeAttempt`, so it disappears as soon as the persisted Ready row catches up; (2) `router.refresh()` is now called after a successful prepare so the persisted ready row replaces the local banner immediately; (3) `SucceededPanel` promotes `refund_status='succeeded'` to the top heading: when refunded the panel uses the amber palette, reads "Test payment refunded.", and shows a `Refund details` block (Amount refunded / Refunded / Refund id) directly under the charge details. Receipt + Refund sub-panels continue to render below as the per-section detail; "Refund test charge" button stays hidden when `refund_status='succeeded'`. Session detail page: `<div id="session-payment">` anchor wraps the payment card so the calendar `Go to billing` deep link lands precisely on the payment surface. Receipt template: `lib/email/templates/payment-receipt.ts` `NO_REFUND_BODY_DISCLAIMER` renamed to `REFUND_AVAILABLE_BODY_DISCLAIMER` with new copy "If this test payment needs to be refunded, the practitioner can issue a test-mode refund in Hone." (PR #178 made test-mode refunds available; the old "Refund handling is not enabled in Hone yet." disclaimer is gone from both text and html bodies). No payment behavior change. No new Stripe call. No live mode. No migration. No SMS / client-portal / `manual_fee_charge_attempts` touch. Stripe gates unchanged from PR #180.

## Earlier production status (as of PR #180)

- **Appointment completion + session-start workflow unblock for payment smoke** (PR #180, no migration). Re-exposes the "Mark completed" button on `app/(app)/calendar/AppointmentLifecycleActions.tsx` (removed earlier per pre-payments feedback) alongside the existing Mark no-show. Same gating: `status === "confirmed"` AND `hasEnded`. Two-click `window.confirm` with the exact copy "Mark this appointment completed? This marks the appointment completed and allows the session to be charged after charting." Success hint "Appointment marked completed." Primary (filled) styling so the happy path is the obvious affordance. ALSO adds `maybeMarkAppointmentCompletedOnSessionStart` in `app/(app)/clients/[id]/sessions/new/actions.ts`: after a session insert with a linked appointment, if `appointment.status='confirmed'` AND `appointment.ends_at <= now()`, the helper calls the `mark_appointment_complete` RPC via the admin client. Cancelled / no-show / completed / future appointments are explicitly skipped. Fail-soft: RPC errors are logged (`session_start_auto_mark_complete_rpc_error` / `session_start_auto_mark_complete_threw`) but never rethrown, so a failed auto-complete cannot break session start. The appointment SELECT in the action is widened from `id, studio_id, client_id, practitioner_id` to also include `status, ends_at` so the auto-complete decision is made off the same roundtrip as the lineage check. The PR #172 payment prepare gate (`appointment.status='completed'`) is unchanged. No new Stripe call, no live mode, no migration, no payment_charge_attempts change, no manual_fee_charge_attempts change, no SMS, no client-portal mutation. Stripe gates unchanged from PR #179.

## Earlier production status (as of PR #179)

- **Stripe webhook reconciliation for payment_charge_attempts** (PR #179, no migration). Adds four event handlers in `lib/billing/payment-webhook-reconciliation.ts` dispatched from `app/api/stripe/webhook/route.ts`: `payment_intent.succeeded`, `payment_intent.payment_failed`, `charge.refunded`, `charge.dispute.created`. The existing `stripe_events` ledger (migration 0032) + `claim_stripe_event` RPC chain provide Stripe-event idempotency; no new ledger needed. Test mode only: `event.livemode === true` is a hard dormancy guard that records a warning `stripe_webhook_livemode_event_ignored` ops_alert and returns without mutation. Reason-agnostic by construction (handlers read `row.charge_reason`, never branch on it). Row-lookup order: canonical metadata `hone_payment_charge_attempt_id` → legacy `hone_session_payment_charge_attempt_id` (PR #173 backward compat) → fallback by `stripe_payment_intent_id` or `stripe_charge_id`. Metadata mismatch on studio/client/reason fires a critical `stripe_webhook_metadata_mismatch` and refuses to mutate. State-transition discipline: a row already in a terminal local state (`failed`/`cancelled`/`blocked`/`refund_status=succeeded`) is NEVER silently flipped; mismatch fires critical ops_alert (`payment_intent_succeeded_local_terminal_mismatch`, `payment_intent_failed_after_local_succeeded`, etc.). Out-of-band FULL refunds (Stripe Dashboard) are reconciled to `refund_status='succeeded'` with a warning `charge_refunded_out_of_band_reconciled`. Out-of-band PARTIAL refunds fire critical `charge_refunded_partial_out_of_band` and leave the row alone (v1 schema cannot represent partial). Disputes are alert-only (`payment_charge_dispute_created`); no automated response. Stripe gates unchanged: 2 allowlisted `paymentIntents.create`, 1 allowlisted `refunds.create`, zero `charges.create` / `checkout.sessions`, 1 allowlisted `STRIPE_ALLOW_LIVE_MODE=true` string. The webhook helper itself imports `recordOpsAlert` and `createAdminClient` only; it does NOT import `getStripe` (no SDK access from the reconciliation module). No SMS, no email, no client-portal mutation, no `manual_fee_charge_attempts` touch, no migration.

## Earlier production status (as of PR #178)

- **Reason-agnostic test-mode refunds on payment_charge_attempts** (PR #178, migration 0078). Adds nine nullable refund columns to `public.payment_charge_attempts` + a single allowlisted `refunds.create` call site in `lib/billing/payment-refund.ts` + a `RefundSubPanel` inside `SucceededPanel` only. Reason-agnostic by construction: the helper records `charge_reason` as Stripe-refund metadata and never branches on the value, so a future `late_cancellation_fee` / `no_show_fee` row refunds with no code change. v1 is full-refund only (`refund_amount_cents = amount_cents`); one refund per attempt enforced by partial unique on `stripe_refund_id`. Triple dormancy guard: `inferStripeLivemode()` short-circuit at entry, `payment_charge_attempts_livemode_false_check`, conditional UPDATE claim requires `status='succeeded' AND stripe_livemode=false AND (refund_status IS NULL OR refund_status='failed')`. Deterministic idempotency key `hone:payment_refund:<attemptId>:v1` + partial-unique `payment_charge_attempts_refund_idempotency_uniq`. Stripe gates: 2 allowlisted `paymentIntents.create`, 1 allowlisted `refunds.create` (`lib/billing/payment-refund.ts`), zero `charges.create` / `checkout.sessions`, 1 allowlisted `STRIPE_ALLOW_LIVE_MODE=true` string. UI uses two-click confirm with the amount in the second button; forbidden copy ("Live refund", "Refund complete", "Money returned", "Official refund receipt") pinned absent by negative source-grep tests. Migration 0078 applied to prod before merge; live-mode CHECKs intact. No webhook handling of `charge.refunded` (out-of-band Stripe-dashboard refunds NOT reconciled). No dispute automation. No refund receipt email. No SMS. No client-portal refund surface. No `manual_fee_charge_attempts` touch (the legacy 0032 `stripe_refunds` tables remain dormant; PR #178 ships refund state ON `payment_charge_attempts` directly).

## Earlier production status (as of PR #177)

- **Card authorization pointer refresh + tightened charge gate** (PR #177, migration 0077). Closes the `docs/16` §5.11 audit-trail gap surfaced in PR #176. Three pieces ship together: (1) `lib/payment-methods/refresh-card-authorization-pointer.ts` is called from `app/portal/consent-actions.ts` after a successful `card_authorization` signature insert; it updates active, non-removed `client_payment_methods` rows for `(studio_id, client_id, stripe_livemode=inferStripeLivemode())` to `card_authorization_signature_id = newSignatureId`. Fail-soft (critical `card_authorization_pointer_refresh_failed` ops_alert; never rolls back the signature). (2) Migration 0077 backfills existing prod rows; idempotent via `IS DISTINCT FROM`; scoped strictly by studio/client/livemode/status='active'/removed_at IS NULL/signature.template_version=template.version. NOTICE confirms row count. Applied to prod 2026-06-08; 1 row updated (the known Sai @ My Studio case); known row pointer went `a6b1fdbe-…0dd4` → `cd3af5cb-…a278`. (3) `getChargeReadyCardAuthorizationStatus` (new in `lib/consent/current-card-authorization.ts`) wraps the base PR #170 helper, adds the card-row pointer-equality check, returns the existing four variants plus `signed_current_but_card_pointer_stale`. Wired into session payment PREPARE eligibility + session payment EXECUTE recheck; remedy copy "Client must re-sign the current card authorization for the card on file." Critically, the charge-only helper is NOT used by `app/portal/consent-actions.ts` (re-sign), `app/portal/payment-method-actions.ts` (Add Card / Replace Card), or `lib/billing/manual-fee-eligibility.ts` (which already gates on the card row pointer); the deadlock-prevention contract is enforced both by code and by tests. Live-mode CHECKs (`manual_fee_charge_attempts_livemode_false_check`, `payment_charge_attempts_livemode_false_check`) verified intact post-migration. PR #175 receipt smoke can now resume against the repaired row. No new Stripe call, no live mode, no refund, no receipt-behavior change beyond eligibility unblock, no SMS, no client-portal payment UI expansion, no manual_fee runtime touch.

## Earlier production status (as of PR #175)

- Production domain: `https://hone.care`.
- Default branch: `claude/build-hone-saas-hOex7`. Every push to it triggers a production deploy. Vercel project: `prj_pJUjs6ImP01FBPqrZyiJRpbpJ2mk`, team `team_Pwj27KsmnBKe3ZUBfKLcFczf`.
- At least 71 migrations applied. Most recent in-tree: `0071_thermolysis_duration_decimal.sql`. The next migration is `0072`. Always double-check the highest file in `supabase/migrations/` before assuming the count.
- Practitioner notification center (PR #164, migration 0070) records business events (`new_booking`, `appointment_cancelled`, `appointment_rescheduled`) into `public.practitioner_notifications`. Writes happen via the server-only `lib/notifications/practitioner-notifications.ts:recordPractitionerNotification` helper (admin/service-role client, never-throws fire-and-forget IIFE; a notification failure cannot roll back the booking / cancel / reschedule that just committed). Reads + mark-all-read happen via the authenticated RLS client on `/notifications`. Visibility is studio-wide in v1; `practitioner_id` is stored for future per-practitioner filtering. Separate from `ops_alerts` (which is the operator surface for system failures, PR #153).
- Thermolysis duration is fractional (PR #165, migration 0071). `electrolysis_entries.thermolysis_duration_seconds` is `numeric` (was integer in migration 0042). The form input uses `step="0.01"` + `inputMode="decimal"`; the read view routes through `lib/sessions/format-seconds.ts:formatSeconds` which yields `"0.15 seconds"` / `"1 second"` / `"2 seconds"`. Only the thermolysis column was widened; galvanic_duration_seconds and intensity_percent fields stay integer.
- Portal magic-link expiry is **60 minutes** (PR #166, raised from 30 minutes). The TTL constant `MAGIC_LINK_TTL_MS` lives in `app/portal/login/actions.ts` and is the single source of truth; the email body copy ("This link expires in 1 hour.") in `lib/email/templates/portal-magic-link.ts` is pinned by `tests/lib/email/portal-magic-link.test.ts`. No migration. The GET/POST split-consumption model (PR #142), the single-use atomic UPDATE on `consumed_at IS NULL`, and the 7-day portal session cookie TTL are all unchanged. PR #166 also flipped the portal-header right cluster from `flex-col items-end` to `flex-row items-center` so Sign out sits visibly at top-right next to the Email <studio> button instead of stacked below it.
- **Reason-agnostic test-mode receipt path** (PR #175, migration 0076). Adds the receipt-state columns to `public.payment_charge_attempts` and ships `lib/billing/payment-receipt.ts:sendPaymentChargeReceipt` + `lib/email/templates/payment-receipt.ts:buildPaymentReceiptEmail` (uses the existing `sendEmailSafely` helper from `lib/email/send-appointment.ts`). The helper is reason-agnostic: today only `session_payment` succeeded rows exist, but `late_cancellation_fee` and `no_show_fee` rows will work without code changes. UI: new `ReceiptSubPanel` inside `SucceededPanel` reads `receipt_status` from the persisted row so the already-sent / failed / sending states survive page refresh; a Send test receipt button appears only when status is null or failed. Atomic dedup via conditional UPDATE on `receipt_status IS NULL OR receipt_status = 'failed'` → `'sending'`. Subject "TEST MODE receipt from <studio>: <reason> $X.XX CAD". Body carries three disclaimers ("This is a Stripe test-mode receipt. No live card was charged.", "No tax calculation is included on this receipt.", "Refund handling is not enabled in Hone yet."). No auto-send from `runSessionPaymentCharge` -- the spec is explicit. No new Stripe call. No live mode. No refund. No SMS. No client-portal change. No manual_fee touch. Forbidden copy ("Pay now", "Send invoice", "Tax receipt", "Official invoice", "Payment complete", "Live payment") absent from the receipt surface, pinned by negative source-grep tests. Migration ledger advanced to 0076.
- **Session payment UX hardening** (PR #174, no migration). `SessionPaymentPrepareCard` refactored so every post-refresh state renders rich detail driven by the persisted `payment_charge_attempts` row. New `AttemptStatusPanel` dispatcher switches on `attempt.status` and returns one of `ReadyPanel` / `PendingPanel` / `SucceededPanel` / `FailedPanel` / `CancelledPanel` / `BlockedAttemptPanel` (mirrors `ManualFeeChargeCard.tsx` precedent). `SessionPaymentExistingAttemptSummary` widened to carry `stripePaymentIntentId / stripeChargeId / chargedAt / failedAt / failureCode / failureMessageSafe`; `getSessionPaymentEligibility` SELECT widened accordingly. `SucceededPanel` displays the PaymentIntent + Charge ids + charged-at timestamp + explicit "Stripe test-mode charge. No live card was charged. No receipt was sent in this PR." `FailedPanel` displays the sanitised failure message + failure code + failed-at + PaymentIntent id with "Prepare a new session payment attempt" guidance. `STATUS_LABEL` map updated to reflect post-PR-#173 reality (`ready: "Ready (test mode)"`, `succeeded: "Succeeded (test mode)"`, `failed: "Failed (test mode)"`, `pending_stripe: "Pending Stripe (test mode)"`). Forbidden copy ("Pay now", "Charge card", "Collect payment", "Payment complete", "Live payment", "Receipt sent") absent from actionable JSX (pinned by negative source-grep tests). No new Stripe call. No webhook change. No SMS / email. No client-portal change. No migration. Migration ledger remains 0075.
- **Session payment EXECUTE flow** (PR #173, migration 0075, test mode only). Adds `lib/billing/session-payment-charge.ts:runSessionPaymentCharge`, a faithful port of `runManualFeeCharge` adapted for `payment_charge_attempts`. Stripe gate script + live-mode-blocker test updated to allow exactly 2 allowlisted `paymentIntents.create` call sites (`lib/billing/manual-fee-charge.ts` + the new file). Migration 0075 adds the atomic claim RPC `claim_session_payment_charge_attempt` (mirror of 0065's manual fee RPC). Execution flow: live-mode early return -> attempt + reason + livemode-row guards -> PR #170 current-card-authorization recheck (signature id must still match the stamped value) -> lineage recheck -> claim RPC (status='ready' -> 'pending_stripe' + deterministic idempotency key `hone:session_payment:<attemptId>:v1`) -> `paymentIntents.create({amount, currency: 'cad', customer, payment_method, confirm: true, off_session: true, description, metadata}, {stripeAccount, idempotencyKey})` -> write succeeded (PI id, charge id, charged_at) or failed (sanitised failure_code + failure_message_safe + failed_at + ops_alert). No `application_fee_amount`, no `receipt_email`, no `statement_descriptor_suffix`. UI: new "Run test charge" button on `SessionPaymentPrepareCard`'s existing-attempt branch with a two-click confirm + clear test-mode disclaimer; no "Pay now" / "Charge card" label. No live mode. No receipt. No refund. No webhook business logic added. No SMS / email. manual_fee_charge_attempts runtime untouched. Per-file `paymentIntents.create` count: 1 in each of the two allowlisted files; `STRIPE_ALLOW_LIVE_MODE=true` still 1 in `lib/stripe/server.ts` only.
- **Session payment PREPARE flow** (PR #172, test mode only). The session detail page (`app/(app)/clients/[id]/sessions/[sessionId]/page.tsx`) now renders a `SessionPaymentPrepareCard` after `SessionInfoCard`. The card resolves eligibility via `lib/billing/session-payment-eligibility.ts:getSessionPaymentEligibility` and dispatches between blocked / existing-attempt / ready states. The action `prepareSessionPaymentChargeAction` writes one row to `public.payment_charge_attempts` with `charge_reason='session_payment'`, `status='ready'`, `stripe_livemode=false`, the practitioner-confirmed amount, the active card's lineage, and the PR #170 `signed_current` `card_authorization_signature_id`. The chargeability proxy (no `sessions.completed_at` column exists today) is `sessions.appointment_id IS NOT NULL AND appointments.status='completed' AND sessions.started_at IS NOT NULL`. NO Stripe call. NO PaymentIntent. NO charge. NO webhook. NO SMS. Duplicate protection via PR #171's `payment_charge_attempts_active_session_payment_uniq` partial unique + a 23505 catch in the action. UI explicitly does not render any "Pay now" or "Charge card" button; the disclaimer reads "This prepares a test-mode payment record. It does not charge the client." manual_fee_charge_attempts runtime fully untouched.
- **Canonical `payment_charge_attempts` ledger** (PR #171, migrations 0073 + 0074). Dormant: 0 rows in production. First writes land in PR #181 (test mode only) for `session_payment`. Schema covers all three charge reasons (`session_payment`, `late_cancellation_fee`, `no_show_fee`); status enum mirrors `manual_fee_charge_attempts` exactly (no parallel state machine); amount_cents bounded `> 0 AND <= 200000` ($2,000 CAD vs manual_fee's $200, intentionally larger for full session amounts); `payment_charge_attempts_livemode_false_check` is the named dormancy guard the future live-enablement PR drops deliberately; `payment_charge_attempts_reason_shape_check` enforces session_payment-requires-session_id (appointment_id OPTIONAL so a future freeform-session charge does not need a relax migration) AND cancellation/no-show-requires-appointment_id-and-forbids-session_id; `card_authorization_signature_id` nullable in this dormant PR (execution PR #181 must refuse to charge unless `lib/consent/current-card-authorization:getCardAuthorizationStatus` returns `signed_current` AND stamps the matching signature id); FK ON DELETE rules audited (studio CASCADE; client/appointment/practitioner composite RESTRICT; session_id RESTRICT after corrective 0074 -- initial 0073 declared SET NULL but that contradicted the reason_shape_check requiring session_payment rows to have non-null session_id; signature/payment_method RESTRICT); 12 secondary + 4 partial-unique indexes (idempotency, stripe_payment_intent, active-fee-per-appointment, active-session_payment-per-session) match manual_fee's three-layer duplicate-protection pattern; RLS enabled with studio-member SELECT only, no INSERT/UPDATE/DELETE policy, service-role admin owns mutations. **TEMPORARY TWO-TABLE STATE:** `manual_fee_charge_attempts` remains the runtime test-mode ledger; runtime fee charging must be migrated or unified onto `payment_charge_attempts` BEFORE live `late_cancellation_fee` or `no_show_fee` charging ships (see docs/13 + docs/16 §12.5b for the dated checkpoint + gate language).
- **Card authorization current-version re-sign gate** (PR #170). The product-ready DRAFT body lives at `lib/consent/card-authorization-draft.ts:CARD_AUTHORIZATION_DRAFT_V1_BODY` (around 2.5 kB; covers card on file, completed-session off-session charges, late cancellation, no-show, receipts/refunds/disputes, payment processing + privacy, scope + revocation; explicit "does not waive my dispute rights" line; no legal-approval claim). The shared helper `lib/consent/current-card-authorization.ts:getCardAuthorizationStatus` returns one of four kinds (`no_live_template` / `unsigned` / `signed_out_of_date` / `signed_current`); `createCardSetupIntentAction` refuses unless `signed_current`; `manual-fee-eligibility.ts` performs the same comparison inline. Portal page renders a new "Card authorization was updated" block when out-of-date; the practitioner `PaymentMethodCard` renders `AuthorizationOutOfDateBlock` (no card) or `AuthorizationOutOfDateWarning` (active card present). The unsignedConsentTemplates filter special-cases card_authorization so re-signing reuses the existing Review and sign UI; other consent types do NOT force re-sign on every edit. No migration. No production data change in this PR -- the operator step (Chloe pastes the body via Settings -> Consent forms, which bumps version 1 -> 2 via the existing updateConsentTemplateAction) is documented in docs/05; until then existing "test" signatures continue to satisfy version=1 and nothing visible changes for current clients.
- **Session payment product model defined** (PR #169, docs + guardrails only). [docs/16 §12](./16_LIVE_PAYMENTS_READINESS.md#12-session-payment-product-model-pr-169) carries the v1 model: charge AFTER the session with a practitioner-confirmed amount (no auto-charge from `services.price_cents` or duration), one charge primitive parameterized by `charge_reason` (`session_payment` / `late_cancellation_fee` / `no_show_fee`), off-session SetupIntent already satisfied at `lib/stripe/setup-intent.ts:202`, 0% Hone platform fee in v1, no tax calculation, paid status derived from charge rows (no boolean), studio is merchant of record, risk-ordered enablement (session_payment ships live first, then cancellation, then no-show). The PR sequence in docs/16 §11 + §12.13 was renumbered: PR #169 is the product model, PR #170 is the legal review of `card_authorization` wording (was original PR #169), and the session_payment build PRs are #179 to #183. No schema commitment yet (separate table vs unified table with reason enum); the schema PR's own audit decides.
- **Live payments are NOT enabled.** PR #168 is a docs + guardrails-only readiness review concluding **NOT READY FOR LIVE PAYMENTS**. Three independent dormancy guards remain in place: (1) `lib/stripe/server.ts` rejects `sk_live_` keys unless `STRIPE_ALLOW_LIVE_MODE=true`; (2) `lib/billing/manual-fee-charge.ts:runManualFeeCharge` short-circuits with `outcome: "live_mode_blocked"`; (3) migration 0065 adds `CHECK (stripe_livemode = false)` on `manual_fee_charge_attempts`. The full readiness doc + 9-PR unblock sequence lives at [docs/16_LIVE_PAYMENTS_READINESS.md](./16_LIVE_PAYMENTS_READINESS.md). The "Test mode only" UI copy in 7 locations across the portal + practitioner surfaces survives PR #168 deliberately; PR #170 will remove it as part of the live-mode-enablement track. Willow's `card_authorization` template is still titled `"test"` (not legally reviewed); PR #169 covers the legal review.
- Consent templates have a **Live in client portal** control separate from the practitioner-facing `status` enum (PR #167, migration 0072). `consent_form_templates.is_live boolean NOT NULL DEFAULT false`; backfilled to `is_live = (status = 'active')` to preserve pre-migration portal visibility. DB CHECK constraint `(NOT is_live OR status = 'active')` guarantees a draft / archived row can never be live. The portal query in `lib/consent/queries.ts:getActiveConsentTemplatesForPortal` filters `is_live=true AND status='active'` (defense-in-depth); the portal Add card flow in `app/portal/payment-method-actions.ts` and the sign action in `app/portal/consent-actions.ts` apply the same two-clause gate. `createConsentTemplateAction` forces `status='draft'` and `is_live=false` on insert; `setConsentTemplateStatusAction` auto-sets `is_live=false` when moving to draft or archived; a new `setConsentTemplateLiveAction` is the only path to `is_live=true` and pre-flights the requirement that the row be active first. The `Settings -> Consent forms` UI gained a `Live` / `Draft` badge per row and a `Make live in client portal` / `Hide from client portal` button. Historical `client_consent_signatures` are untouched; the "Completed forms" portal surface reads signatures directly without joining the templates table. Audience targeting (per-modality / per-service / new-vs-existing-client) is deferred to a future PR. No payment / live-mode / SMS / RLS change.
- Client profile (`app/(app)/clients/[id]/page.tsx`) Sessions tab leads with an Appointments timeline (PR #157) that groups every appointment into Upcoming / Needs charting / Charted / Cancelled / No-show with per-row Chart / View / Open affordances. The query helper is `getAppointmentsForClientProfile` (`lib/supabase/queries.ts`); the component is `components/client-appointment-timeline.tsx`. No service role.
- Portal card-on-file section (PR #158) renders one of four explanatory states (no template configured / authorization needed / signed but no card / active card) with a deep-link `#forms-to-sign` from the "Card authorization needed" placeholder to the existing "Review and sign forms" block. Matching practitioner-side `PaymentMethodCard` on the client profile renders the same four branches with practitioner-actionable copy. Manual fee blocked-reason strings (`lib/billing/manual-fee-eligibility.ts`) updated to tell the practitioner exactly what to ask the client to do next. No new schema, no new RPC, no new payment behavior.
- Portal layout (PR #159) replaces the legacy "Your info" wrapper with four top-level sections (Appointments / Care instructions / Forms and records / Payment method). Header now carries an `Email <studio>` contact button next to Sign out. Care instructions render `<details open>` so the client sees them without clicking. "Signed forms" renamed to "Completed forms" with quiet border-top divider styling so the rows do not read as actionable. PR #158 card-authorization guidance preserved and verified by existing tests.
- Pre-appointment instructions (PR #160) are studio/service-owned via the existing `services.pre_care_instructions` field (migration 0025), edited from `Settings → Services`. The same field feeds the booking confirmation email, both reminder emails, AND the portal Care instructions section. The prior hardcoded "Please arrive 5 minutes early. Wear comfortable clothing. Avoid caffeine before your appointment." paragraph was removed from `lib/email/templates/appointment.ts`; empty prep text now omits the block entirely. No migration; no payment / SMS / public-route behavior change.
- Charting terminology (PR #162). The `session_blocks.side` value `bilateral` now renders as `"Both sides"` everywhere (Chloe's charting feedback); the stored enum, the migration 0039 CHECK constraint, and the server validation array all keep the canonical `bilateral` lowercase value. Label mapping lives in `lib/sessions/side-labels.ts`; both `block-setup-form.tsx` and `session-blocks-view.tsx` read from it. Thermolysis input order in the block editor is now `Duration -> Intensity -> Pulse count` (was `Intensity -> Duration -> Pulse count`) to match Chloe's machine; persisted column names (`thermolysis_duration_seconds`, `thermolysis_intensity_percent`, `pulse_count`) are unchanged. No data migration.
- Booking referral attribution (PR #163, migration 0069). Public booking form asks "How did you hear about us?" with seven canonical options (Google / Instagram / Friend or referral / Existing client / Studio website / Other / Prefer not to say). Answer stored on the nullable `appointments.referral_source` text column; no CHECK constraint at the DB layer (option set enforced at the action layer in `lib/booking/referral-source.ts`). Practitioner sees the value on the calendar appointment detail page and in the new-booking notification email; client-facing surfaces (confirmation email, reminder emails, portal) deliberately do not surface it. v1 is appointment-level only.
- Card-on-file and test-mode manual fee charge are live in production **test mode**. Live mode is blocked by three independent guards.
- GitHub Actions CI (PR #154) runs typecheck, lint, build, `npm test`, `git diff --check`, and `npm run check:stripe-gates` on every PR and push to default. `npm run ci` is the local shortcut. A red CI check blocks merge. Since PR #220 a separate `db-integration` job also applies the full migration chain to a LOCAL Supabase Postgres and runs `npm run test:db` (tests/db/, real RLS/trigger/RPC behavior; local only, no secrets). If a PR touches migrations, policies, triggers, or claim RPCs, run the DB lane locally too: `supabase db start && supabase db reset --local && npm run test:db`.
- Ops alerts (PR #153, migration `0067_ops_alerts.sql`) capture silent failure states for the manual-fee path, Stripe webhook, SMS path, and the appointment-reminder cron. The SMS path stamps `studio_id` on alerts as of PR #155.
- Sessions can be explicitly linked to appointments via `sessions.appointment_id` (PR #156, migration `0068_sessions_appointment_link.sql`). Write-forward is partial: appointment-context flows stamp the FK, client-scoped session creation remains null. Historical sessions remain null; no backfill has been run. The dedup site in `lib/supabase/queries.ts:getPastConfirmedAppointmentsForClient` prefers the explicit link and falls back to the `+/- 2 hour` heuristic only for unlinked sessions.

## Branch / PR / deploy workflow

1. Branch off `claude/build-hone-saas-hOex7` with a short descriptive name.
2. Build, validate locally:
   ```bash
   npm run typecheck
   npm run lint
   npm run build
   npm test
   npm run check:stripe-gates
   git diff --check
   # or as one command:
   npm run ci
   ```
3. Commit as `SaiSamyukthVemuri <samyukth.ssv@gmail.com>` (the Vercel author gate requires this).
4. Push. Open a PR with the `.github/pull_request_template.md` checklist filled honestly.
5. STOP. Do not merge until reviewed.
6. On review approval: `gh pr merge <N> --merge`.
7. Poll the Vercel commit status:
   ```bash
   gh api "repos/SaiSamyukthVemuri/Hone/commits/<sha>/status" --jq '.state'
   ```
8. When `state=success`, confirm `READY` via Vercel MCP `get_deployment`.
9. Report merge SHA, deployed SHA, production status, any check failures.
10. Run the post-deploy smoke that you CAN do from a non-authenticated harness. Clearly say what could not be verified.
11. Do not start another PR until the deploy is `READY`.

## What not to touch casually

The list of high-risk areas. Each has a doc you MUST read before changing anything in it.

| Area | Doc | Why high-risk |
|---|---|---|
| Stripe / payment / live mode | [docs/06](./06_PAYMENTS_AND_STRIPE.md) | Money. Live charging is blocked by three independent guards; do not weaken any of them. |
| Token routes (`/cancel`, `/reschedule`, `/manage`, `/intake`, `/portal/verify`, `/calendar-feed`) | [docs/03](./03_SECURITY_AND_PRIVACY.md) | Token IS the credential. No analytics. noindex + no-referrer headers. |
| Portal session / magic link / `client_portal_magic_links` | [docs/03 §3](./03_SECURITY_AND_PRIVACY.md#3-portal-session-model) | The GET on `/portal/verify/<token>` is deliberately non-consuming. POST consumes. Do not flip this. |
| Manual fee `paymentIntents.create` | [docs/06](./06_PAYMENTS_AND_STRIPE.md), [docs/13](./13_BACKLOG_AND_DECISIONS.md) | The single allowed occurrence. Do not delete. Do not add a second. |
| RLS policies + `SECURITY DEFINER` RPCs | [docs/09](./09_DATABASE_AND_RLS.md) | Trust boundary. |
| Service-role client usage | [CONTRIBUTING.md](../CONTRIBUTING.md) | Never in `"use client"`. Never to bypass RLS as a convenience. |
| Analytics mount points | [docs/03 §6](./03_SECURITY_AND_PRIVACY.md#6-analytics-privacy-pr-142) | Root layout MUST NOT mount Analytics. Safe trees opt in. |
| `ADMIN_EMAILS`, `NEXT_PUBLIC_APP_ORIGIN`, `PORTAL_FINGERPRINT_SALT` fail-closed behavior | [docs/03 §7](./03_SECURITY_AND_PRIVACY.md#7-production-config-fail-closed-pr-143) | Production with missing values fails closed deliberately. |

## Payment safety rules (non-negotiable)

- **No live charges** unless `STRIPE_ALLOW_LIVE_MODE=true` AND a deliberate live-mode PR is open AND the `manual_fee_charge_attempts_livemode_false_check` constraint has been deliberately replaced AND the [docs/06 §9 checklist](./06_PAYMENTS_AND_STRIPE.md#9-live-charging-requirements) is complete.
- **No automatic / batch / background / public-triggered charge.** Charging is one manual practitioner click on a `ready` attempt.
- **No platform customer / platform PaymentMethod.** Every Stripe call must carry `{ stripeAccount }`.
- **No raw card / CVC / `client_secret` storage.**
- **No blind retry past the 60-minute reconciliation window.** Stripe idempotency is a 24-hour belt; the action's 60-minute window is the suspenders. Past that window, return `needs_manual_review`.

## PR review pattern

When reviewing a PR:

1. Read the PR template. Refuse to review further if the checklist is empty or dishonest.
2. Read the migrations (if any). Confirm RLS posture, grants, `search_path`, additive shape.
3. Read the diff for the search gates:
   ```bash
   git diff | grep -E '^\+' | \
     grep -E 'paymentIntents\.create|charges\.create|refunds\.create|checkout\.sessions|set_studio_require_card_on_file|STRIPE_ALLOW_LIVE_MODE=true'
   ```
4. Confirm no new Stripe SDK imports outside the existing helper.
5. Confirm the migration was applied to prod BEFORE the code references it.
6. Confirm docs are updated per [docs/15](./15_DOCS_MAINTENANCE.md).
7. Confirm the PR body lists what could not be verified.
8. Stripe-touching PRs: confirm idempotency, claim-then-act, evidence recheck, lineage recheck, test-mode gate.

## Standard validation commands

```bash
npm run typecheck
npm run lint
npm run build
npm test
git diff --check
npm run check:stripe-gates
```

Or `npm run ci` to run all six in sequence. All must pass before pushing. The Vercel preview deploy must reach `READY` before merge.

GitHub Actions runs the same six steps automatically on every PR and on every push to the default branch (`claude/build-hone-saas-hOex7`). See `.github/workflows/ci.yml`. A red CI check is a hard merge block. CI does NOT replace manual smoke; browser / Stripe Elements / real-send paths still need a human against the live deploy.

## Grep gates (current)

```
charges.create:                       zero
checkout.sessions:                    zero unless explicit Checkout PR
refunds.create:                       exactly one (lib/billing/payment-refund.ts, PR #178)
set_studio_require_card_on_file:      zero unless explicit card-required booking PR
STRIPE_ALLOW_LIVE_MODE=true:          zero unless explicit live-mode PR

paymentIntents.create:                exactly one occurrence allowed today:
                                      lib/billing/session-payment-charge.ts
                                      (the canonical executor; the legacy
                                      manual-fee-charge.ts was deleted in
                                      PR #218)

                                      Any new paymentIntents.create
                                      occurrence is high-risk and must be
                                      explicitly reviewed.
```

The current `paymentIntents.create` path is **test-mode-only manual fee charging**. It is behind:

- practitioner auth
- `getManualFeeChargeEligibility` evidence recheck
- `loadCardAndVerifyLineage` lineage recheck
- `claim_manual_fee_charge_attempt` RPC (`FOR UPDATE`, conditional UPDATE, idempotency key stamp in one transaction)
- deterministic idempotency key `hone:manual-fee:<attempt_id>:v1`
- connected-account context `{ stripeAccount }`
- `inferStripeLivemode()` test-mode gate
- `manual_fee_charge_attempts_livemode_false_check` DB CHECK

**Never live without an explicit live-mode PR.** A live-mode PR must add stronger stale-pending reconciliation (Stripe `paymentIntents.search` by metadata before retry) and must deliberately alter or drop the `livemode_false_check` constraint after review.

## Merge discipline

- One PR per logical change. Do not mix schema + product behavior + security in one PR.
- Migrations apply to prod BEFORE the code PR merges.
- The PR description is the contract; if it does not match the diff, the reviewer rejects it.
- Em-dashes in added lines: zero. Use plain hyphens or colons.
- Commits authored as `SaiSamyukthVemuri <samyukth.ssv@gmail.com>`.

## How to write prompts for future PRs

Useful patterns:

- State the goal first. Then state non-goals. Then the acceptance criteria.
- Always include the validation list (typecheck / lint / build / diff-check) and the grep gates.
- Always include "Do not merge until reviewed."
- Include the SQL the reviewer can run to verify state after merge.
- Include the explicit "what could not be verified" list.

## How to review PRs

- Read the diff before the description.
- Match every claim in the description to a line in the diff.
- If the description says "no schema change" and the diff shows a migration: stop.
- If the description says "no Stripe behavior change" and the diff adds a Stripe SDK import: stop.
- If docs are not updated for a behavior-changing PR: stop.
- Re-run the smoke against a preview deploy where possible.

## Current non-negotiables

Repeat the list in the PR you open, every time:

- Author commits as SaiSamyukthVemuri <samyukth.ssv@gmail.com>
- Zero em-dashes in added lines.
- Apply additive migration to prod BEFORE merging code that references new columns.
- "Do not merge until reviewed."
- "Do not start the next PR until deploy is READY."
- Stripe dormancy: no charges, no `require_card_on_file=true`, no live-mode enable, exactly one `paymentIntents.create`.
- Grep gates: `paymentIntents.create` (allowed only in `lib/billing/session-payment-charge.ts`, the canonical executor since PR #196/#218), `charges.create` (zero), `refunds.create` (only `lib/billing/payment-refund.ts`), `checkout.sessions` (zero), `set_studio_require_card_on_file` (zero), `STRIPE_ALLOW_LIVE_MODE=true`. Enforced by `scripts/check-stripe-gates.mjs` + the `npm run check:stripe-gates` script in CI (PR #154). The `STRIPE_ALLOW_LIVE_MODE=true` rule allowlists `lib/stripe/server.ts` because the string appears in an operator-facing error message there, NOT as a code path that flips the flag.
- **CSP discipline (PR #150).** The global CSP in `next.config.ts` (via `lib/security/headers.ts`) is the single source of truth. Any new third-party browser integration MUST extend the CSP source lists in the same PR. Never weaken `frame-ancestors 'none'` or `X-Frame-Options: DENY`. Never add wildcard `*`. Never add Sentry domains unless that PR actually installs Sentry. Token routes keep `Referrer-Policy: no-referrer`.
- **Ops alert hygiene (PR #153).** `lib/ops/alerts.ts:recordOpsAlert` is the single entry point for silent-failure alerts. NEVER throw from the helper to the caller; DB failures are swallowed and surface only as additional structured logs. NEVER put raw tokens / `client_secret` / Stripe secret keys / card data / CVC / API keys in `safe_details`; the helper has a defensive redactor but the contract is "the caller already redacted". **The helper MUST NOT import `lib/email/send-appointment.ts` or any module that imports it.** Operator email is intentionally deferred; the same module observes the email subsystem and cycling back through it (even with a loop guard) is avoidable. A future PR may add a standalone `lib/ops/alert-email.ts` that uses Resend directly. New silent-failure surfaces should reuse the helper and a stable event name (`<surface>_<state>`).

## If you find yourself wanting to…

- **Add a new `paymentIntents.create`:** stop. Read [docs/06](./06_PAYMENTS_AND_STRIPE.md). The only legitimate new call site is a live-mode PR that satisfies the [docs/06 §9](./06_PAYMENTS_AND_STRIPE.md#9-live-charging-requirements) checklist.
- **Use `createAdminClient` in a client component:** stop. Move the logic to a server action.
- **Mount Analytics on `app/layout.tsx`:** stop. See [docs/03 §6](./03_SECURITY_AND_PRIVACY.md#6-analytics-privacy-pr-142). Mount on the safe-tree layout instead.
- **Add a wildcard `*` to the CSP, weaken `frame-ancestors`, or add Sentry domains "just in case":** stop. Read [docs/03 § Global browser security headers](./03_SECURITY_AND_PRIVACY.md). The CSP is the single source of truth and additions require explicit review.
- **Trust a `studio_id` / `client_id` / `appointment_id` from formData:** stop. Resolve from the session or from the token.
- **Add `process.env.NEXT_PUBLIC_APP_ORIGIN ?? "https://hone.care"`:** stop. Use `getRequiredAppOrigin()` from `lib/app-origin.ts`. PR #143 removed every silent fallback.
- **Skip a doc update because "the PR is small":** stop. The doc update is part of the PR.

## What was not verified by the agent in PR #148

This documentation overhaul is itself a docs-only PR. I did NOT:

- Run any new code paths.
- Apply any new migrations (no schema change in this PR).
- Send any email or SMS.
- Trigger any Stripe call.

The validation gates that DID run: `typecheck`, `lint`, `build`, `git diff --check`, em-dash count, and a grep for stale `hone.studio` references. Each doc was cross-referenced against the actual code, migrations, and PR template at the moment of writing (PR #147 just merged; the deployed SHA was `3ab714f`).

Where a doc references a behavior, the citation is the PR number and the migration number so a future reviewer can spot-check by reading the migration or the action file directly.
