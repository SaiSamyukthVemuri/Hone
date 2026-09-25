// Single source of truth for the Hone marketing site's positioning, pricing,
// conversion copy, navigation, page metadata, and privacy-safe analytics event
// names. Built for the flagship marketing rebuild on
// `feat/marketing-site-category-seo-pricing`.
//
// WHY THIS FILE EXISTS
// -------------------
// Every marketing page and component reads its copy-critical constants from
// here so the truthful CTA label, CAD currency, plan prices, and page titles
// stay byte-identical across the header, hero, pricing, demo, metadata,
// JSON-LD, and tests. That consistency is a correctness requirement, not a
// nicety:
//   - The primary CTA describes ONE real workflow everywhere (marketing
//     addendum §3). `/demo` is a lead-capture form, the founder replies to
//     schedule; the visitor never selects a real appointment time, so the
//     truthful verb is "Request", never "Book". See `DEMO_FLOW` below.
//   - SaaS currency is CAD everywhere: prices, FAQ, metadata, JSON-LD, tests
//     (prompt §15). This is a product-owner decision, independent of the
//     currency a studio uses to charge its own clients.
//   - Titles are pinned per prompt §22.
//
// PRODUCT-TRUTH BOUNDARY
// ----------------------
// Nothing in this file markets a capability that the internal product-truth
// register (docs/marketing/product-truth-register.md) classifies as not
// public-ready. In particular, Google Calendar synchronization is
// DORMANT / controlled-validation-only and is NEVER referenced here or on any
// public surface (prompt §3 "Google Calendar rule"). Payments always carry the
// "enabled during guided onboarding" qualifier.
//
// This module is intentionally framework-agnostic (no next/* imports) so both
// server components and Vitest can consume it. It defines shared data only; the
// wiring into components, metadata, sitemap, and analytics happens in later
// delivery stages (prompt §30).

export const CANONICAL_HOST = "https://hone.care" as const;
export const CONTACT_EMAIL = "hello@hone.care" as const;

// ---------------------------------------------------------------------------
// POSITIONING — copy deck v2.2 §1, the fixed hero and category language.
// ---------------------------------------------------------------------------
//
// EVERY VALUE HERE IS QUOTED FROM THE DECK, NOT PARAPHRASED. The deck says its
// lines are "written to be pasted", and the difference matters: a rewritten
// line is a claim nobody reviewed against the truth register.
//
// WHAT THE DECK RETIRES, AND WHY THE STRINGS ARE GONE RATHER THAN UNUSED.
// v2.2 retires six strings outright. A retired string left exported is a string
// a later surface can still render, so each is deleted with its test. They are
// DESCRIBED here and never reproduced:
//
//   * the former `heroH1`, which restated the category and then claimed total recall
//   * a short line about what rival tools fail to retain
//   * the former `categoryAmbition`, a whole-business category metaphor
//   * the former `proofLine`, whose four clauses were about onboarding terms
//     rather than about the record
//   * a "most popular" badge on the Solo pricing card
//   * the six-box capability grid AS THE HOMEPAGE'S MAIN PRODUCT SECTION
//
// REPRODUCING A RETIRED LINE HERE WOULD BE A DEFECT, not documentation. A guard
// that scans this file for retired copy has to strip comments to tell an
// assertion from its denial, and the strip order is a known trap: line comments
// must go before block comments or a `next/*` sequence eats the rest of the
// file. Describing the retired lines keeps this file's prose out of that
// question entirely, and `tests/lib/marketing/content-v22.test.ts` asserts the
// retired strings appear nowhere in the module at all — comments included.
//
// THE LAST TWO ARE NOT THIS LANE'S TO REMOVE, and saying so is the point.
// Both are rendering decisions: the badge lives on a pricing card and the grid's
// content is absorbed into a homepage section this lane is explicitly told not
// to build. `CAPABILITY_GROUPS` therefore stays exported and unchanged here —
// retiring the grid's ROLE is a structural change, not a constant change.
//
// `categoryAmbition` IS deleted, because the deck conditions that on nothing
// internal reading it and nothing does: the only occurrence in app/, lib/,
// components/, tests/ or e2e/ was its own definition.
export const POSITIONING = {
  category: "Electrolysis practice software",
  differentiator: "Treatment memory",
  corePromise: "Hone carries the important details from one appointment into the next.",
  heroEyebrow: "Electrolysis practice software",
  heroH1: "Start the next treatment where the last one ended.",
  // Replaces `heroSupporting`, whose sentence listed eight capabilities in one
  // breath. The deck's sub names ONE mechanism and is the claim the film shows.
  heroSub:
    "Each treated area keeps its own history. Before a returning client sits down, Hone brings forward last time's settings, response and notes.",
  // KEPT VERBATIM. The deck moves this from the hero to the connected-workflow
  // section header, which is a placement change and belongs to the lane that
  // builds that section; the string itself does not change.
  differentiationLine:
    "Your calendar remembers the appointment. Hone helps you remember the treatment.",
  keepPhrase: "Treatment memory for electrologists",
  // Every clause is register-backed, and the fourth is the one worth naming:
  // "CSV export on every plan" rests on `lib/export/resource-registry.ts` plus
  // the register's "Exportable records (full studio export)" row, class
  // LIVE_FOR_ALL_ONBOARDED — not plan-gated, so "every plan" is literal.
  proofLine:
    "Built for electrolysis records · History by treated area · Probe lots tied to treatments · CSV export on every plan",
  // Rendered directly under the Before Today block (deck §3 section 2).
  //
  // THE FOURTH ITEM IS NOT A SUPPORT PROMISE, AND THAT IS DELIBERATE.
  // It read as a commitment that one specific person answers support. That is a
  // personal obligation, not a property of the product: it has no truth-register
  // row, nothing in the repository can verify it, and it binds the business to
  // one individual's availability on a public page. It is replaced by a
  // commercial term the operator actually sets and already publishes in
  // `assuranceLine` — no invented substitute, and deliberately NOT "24/7
  // support" or "the Hone team", which would trade an unsupported promise for a
  // larger one.
  trustStrip:
    "Records isolated by studio · Imported history stays marked as imported · CSV export on every plan · No setup fee",
  // Under the pricing cards and in the CTA block — deliberately NOT under the
  // hero, which is where the retired proof line used to put this material.
  assuranceLine:
    "Founder-led setup · Free standard client import · No setup fee · Cancel anytime",
  // [VERIFY] RESOLVED — nothing caps clients or appointments.
  //
  // Verified as an ABSENCE, which needs saying because a negative is the easiest
  // thing to assert and the hardest to trust. Searched application code, the
  // full migration set and the truth register for a plan-level limit on client
  // or appointment count: there is none, and the register carries no caps row.
  //
  // The only matches were a DIFFERENT KIND OF LIMIT and must not be mistaken
  // for this one: per-IP request rate limiters (abuse protection), Google API
  // quotas, and waitlist proof attempt ceilings. A rate limit on how fast
  // requests arrive is not a cap on how many records a studio may hold.
  noCapsLine:
    "Every plan includes the full treatment workflow. No client caps. No appointment caps.",
  // PAYMENTS ARE NAMED HERE, SO THE QUALIFIER IS NOT OPTIONAL.
  //
  // The truth register's payment rule: card on file and owner-run session
  // payments "may be described WITH the qualifier 'Payments are enabled during
  // guided onboarding.' Never imply self-service live-payment activation." Card
  // on file is LIVE_WITH_GUIDED_SETUP, not LIVE_FOR_ALL_ONBOARDED.
  //
  // This list therefore carries a rendering obligation that no constant can
  // enforce on its own: any surface rendering `everyPlanIncludes` must render
  // `PAYMENT_QUALIFIER` with it. `tests/lib/marketing/content-v22.test.ts`
  // asserts the pairing obligation so it cannot be silently dropped.
  //
  // Every other item is register-backed: intake (LIVE_FOR_ALL_ONBOARDED),
  // consent, photos (MARKET), follow-up, client portal (passwordless
  // magic-link, LIVE_FOR_ALL_ONBOARDED/MARKET) and CSV export.
  everyPlanIncludes:
    "Treatment memory, charting, intake, consent, photos, follow-up, payments, a client portal and CSV export. On every plan.",
  pricingHeading: "Simple plans, in Canadian dollars.",
  recordsHeading: "Your client records should stay yours.",
  walkthroughHeading: "See it with a returning client.",
  // The film's end card, reused as the walkthrough CTA eyebrow and as the
  // closing line of the treatment-memory page.
  filmClosingLine: "Pick up where you left off.",
  // ALREADY BURNED INTO THE FILM, so it is carried verbatim rather than
  // restyled. The deck standardises on this exact wording — not a middle-dot
  // variant — precisely so no recut is needed and every screenshot matches.
  demoDataLabel: "Demo data. Actual Hone application.",
} as const;

// ---------------------------------------------------------------------------
// Film V1 — the treatment-memory product film (deck v2.2 §12b). MKT-02B.
// ---------------------------------------------------------------------------
//
// THIS CONSTANT HOLDS FACTS ABOUT A FILE, NOT COPY. Every word the film's
// placement needs — its closing line, its demo-data label — is POSITIONING's,
// above, because it is copy and copy has one owner. What lives here is what
// only the asset can answer.
//
// AND EVERY NUMBER WAS READ FROM THE BYTES, not from the deck and not from the
// still. Parsed from the MP4 boxes:
//
//   moov/mvhd      duration 25.000 s
//   trak/tkhd      1920 x 1080
//   stbl/stts      750 frames -> 30.00 fps
//   stbl/stsd      avc1 (H.264)
//   trak/mdia/hdlr ONE handler, "vide". There is no "soun" track.
//   file           3,647,564 bytes
//
// `hasAudioTrack: false` is the PREMISE for shipping a player with no unmute
// control and no caption track, so it is recorded as a checked property rather
// than left implicit in a design decision. tests/app/marketing-homepage-film
// re-derives all of it from the file on every run: if a recut ever arrives with
// sound, that goes red the same day, rather than on the day a Deaf visitor
// finds out the page has an uncaptioned soundtrack.
//
// The transcript is the §12b card sequence, verbatim and in the film's order —
// the film's text equivalent (WCAG 1.2.1). The film carries product claims, and
// a claim only sighted visitors can reach is a claim the page makes selectively.
export const FILM = {
  src: "/film/hone-treatment-memory-v3-1.mp4",
  type: "video/mp4",
  durationSeconds: 25,
  width: 1920,
  height: 1080,
  hasAudioTrack: false,
  // Accessible name for the play control and the player. States the running
  // time and that there is no sound, so nobody waits for narration.
  accessibleName: "Hone treatment-memory product film, 25 seconds, silent",
  transcript: [
    "Monday, Sep 14. Your next client has a history. — the studio calendar, week view.",
    "Hone. Treatment memory for electrologists. — title card.",
    "Treatment memory: see what happened last time. Areas treated, how she responded, and the note left for this visit. — the Last Treatment card: areas treated, response and tolerance per area, a Watch Today caution, setup used per area, consultation and skin/hair.",
    "Treatment memory: the exact setup you used. — the Setup Used card: two areas, each with frequency, probe and lot, modality, level, timing, percentage, pulses, duration and a numbing note.",
    "Charting: record today's treatment. — the appointment page: confirmed session, pinned notes, allergies, client summary.",
    "One client record: appointments, records, and treatment history together. — the client profile with its tabs and pinned notes marked visible on every appointment.",
    "Hone. Pick up where you left off. hone.care — end card.",
  ],
} as const;

// ---------------------------------------------------------------------------
// Primary conversion, the founder-led walkthrough (prompt §5, §19; addendum §3)
// ---------------------------------------------------------------------------
//
// `/demo` is a LEAD-CAPTURE form: it inserts a `demo_requests` row and the
// founder replies within one business day to schedule. The visitor does NOT
// see a calendar or select/receive a real appointment time during submission
// (verified: app/demo/page.tsx, app/_components/DemoForm.tsx, app/actions/demo.ts).
// Therefore the honest label is "Request …", not "Book …". Every surface below
// uses the same verb and describes the same workflow.
export const DEMO_FLOW = "lead_capture" as const;

export const WALKTHROUGH = {
  href: "/demo",
  // Header/nav (tight space), still "Request", never "Book".
  primaryLabelShort: "Request a walkthrough",
  // THE DURATION IS GONE, AND THAT IS A DELIBERATE READING OF v2.2.
  //
  // This named a fifteen-minute meeting and rendered on ten surfaces
  // across eight pages. v2.2 does not state a duration ANYWHERE — the string
  // "15-minute" appears zero times in the deck — while §1 gives `ctaPrimary` as
  // "Request a walkthrough" and both the hero (§3) and the walkthrough CTA (§9)
  // spec that exact button label.
  //
  // So the duration is not a line the deck retires by name; it is a claim the
  // deck no longer supports. Kept, it would promise a 15-minute meeting on every
  // marketing page on no current authority. The deck's own rule is that an
  // unverifiable line is cut rather than softened, so it is cut.
  //
  // `primaryLabelShort` now holds the same text. It is KEPT rather than removed
  // because three components read it, and collapsing two keys into one is a
  // refactor of the header, nav and pricing surfaces that buys nothing here.
  primaryLabel: "Request a walkthrough",
  // §1 `ctaSecondary`, new: the label AND the destination change together.
  //
  // It read "See how Hone works" and pointed at the on-page anchor
  // `#how-hone-works`. The deck routes this to /features/treatment-memory, and
  // the two must move as one: a control may only promise what its destination
  // delivers, and "See how treatment memory works" jumping to a generic
  // homepage section is exactly that promise broken.
  secondaryLabel: "See how treatment memory works",
  secondaryHref: "/features/treatment-memory",
  // Demo page, heading, submit control, and success state all describe the
  // same lead-capture reality (founder replies to schedule).
  demoHeading: "Request a 15-minute Hone walkthrough.",
  submitLabel: "Request my walkthrough",
  submitPendingLabel: "Sending…",
  successMessage:
    "Thanks, we'll be in touch within one business day to set up your walkthrough.",
} as const;

// ---------------------------------------------------------------------------
// Pricing (prompt §15/§16; addendum §1 CAD, §2 operationally-fulfillable)
// ---------------------------------------------------------------------------
//
// Currency is CAD everywhere. No Stripe Products/Prices are created. No caps,
// quotas, SMS overages, automatic seat billing, annual gimmicks, or fake
// scarcity. Core treatment memory / charting / intake / consent / records are
// NOT crippled to build tiers, tiers differ only by who the plan is for and
// how many practitioners it covers.
//
// STUDIO DECISION: published at CAD $99/month for up to three practitioners.
// Rationale (recorded in the truth register): multi-practitioner studios are
// LIVE_FOR_ALL_ONBOARDED, each practitioner charts under their own name and is
// colour-coded on the shared calendar, and owners invite/manage/remove
// practitioners, and this works for three (and more) practitioners today. The
// "up to three" seat boundary is a packaging promise honoured during guided
// onboarding; there is no automatic seat billing. (Note for feature copy: the
// public booking page attributes bookings studio-wide and availability is a
// single studio-wide schedule, so we must NOT claim clients pick a specific
// practitioner or that each practitioner has independent online availability.)
export const CURRENCY = "CAD" as const;
export const STUDIO_PRICE_PUBLISHED = true as const;

export type PricingPlan = {
  id: "founding-solo" | "solo" | "studio";
  name: string;
  /** Display price, e.g. "CAD $29". Null when the plan is "Talk to us". */
  priceLabel: string | null;
  cadence: string | null;
  badge: string | null;
  bestFor: string;
  /** Truthful transition/continuity sentence, when the plan has one. */
  transition?: string;
  /** Practitioner coverage line, when the plan states one. */
  seats?: string;
};

export const PRICING_PLANS: ReadonlyArray<PricingPlan> = [
  {
    id: "founding-solo",
    name: "Founding Solo",
    priceLabel: "CAD $29",
    cadence: "/month",
    badge: null,
    bestFor: "Early solo electrologists joining Hone.",
    transition:
      "CAD $29/month for the first 12 months, then CAD $39/month while continuously subscribed.",
  },
  {
    id: "solo",
    name: "Solo",
    priceLabel: "CAD $49",
    cadence: "/month",
    badge: "Most popular",
    bestFor: "Established solo electrologists.",
  },
  {
    id: "studio",
    name: "Studio",
    priceLabel: STUDIO_PRICE_PUBLISHED ? "CAD $99" : null,
    cadence: STUDIO_PRICE_PUBLISHED ? "/month" : null,
    badge: null,
    bestFor: "Small studios with up to three practitioners.",
    seats: "up to three practitioners",
  },
] as const;

// Assurances, each is evidence-backed in the truth register (§23). No setup
// fee / no contract / cancel anytime / free standard import / founder-led setup.
export const PRICING_ASSURANCES: ReadonlyArray<string> = [
  "Founder-led setup",
  "Free standard client import",
  "No setup fee",
  "No contract, cancel anytime",
] as const;

// Payment qualifier, used wherever payments are mentioned. Never imply
// self-service live-payment activation (§3 payment rule).
export const PAYMENT_QUALIFIER = "Payments are enabled during guided onboarding." as const;

// The only approved "replaces" wording (prompt §16). Conditional, never absolute.
export const REPLACES_STATEMENT =
  "Hone can replace a separate booking calendar, intake tool, treatment-notes system, and client portal for practices that fit Hone's current workflow." as const;

// ---------------------------------------------------------------------------
// Public capability groups (prompt §7), broad, outcome-led, truthful labels.
// ---------------------------------------------------------------------------
export const CAPABILITY_GROUPS: ReadonlyArray<{ label: string; outcome: string }> = [
  { label: "Booking and schedule", outcome: "Get booked" },
  { label: "Client preparation", outcome: "Prepare for the client" },
  { label: "Treatment charting", outcome: "Record the treatment" },
  { label: "Treatment memory", outcome: "Preserve treatment memory" },
  { label: "Photos and records", outcome: "Follow up professionally" },
  { label: "Practice operations", outcome: "Run the practice" },
] as const;

// ---------------------------------------------------------------------------
// Navigation + footer (prompt §9). Every href points at a route shipped in this
// release, NO dead Phase-2 links.
// ---------------------------------------------------------------------------
export type NavLink = { href: string; label: string };

// Product menu links only to shipped routes.
export const PRODUCT_MENU: ReadonlyArray<NavLink> = [
  { href: "/electrolysis-software", label: "Electrolysis software" },
  { href: "/features/treatment-memory", label: "Treatment memory" },
  { href: "/features/booking-calendar", label: "Booking and calendar" },
  { href: "/features/charting-records", label: "Charting and records" },
] as const;

// "Product" is a dropdown (PRODUCT_MENU) that already lists Treatment memory, so
// it is not repeated as a top-level item.
export const PRIMARY_NAV: ReadonlyArray<NavLink> = [
  { href: "/electrolysis-software", label: "Product" },
  { href: "/pricing", label: "Pricing" },
  { href: "/resources", label: "Resources" },
  { href: "/login", label: "Sign in" },
] as const;

export type FooterGroup = { title: string; links: ReadonlyArray<NavLink> };

export const FOOTER_GROUPS: ReadonlyArray<FooterGroup> = [
  {
    title: "Product",
    links: [
      { href: "/electrolysis-software", label: "Electrolysis software" },
      { href: "/pricing", label: "Pricing" },
      { href: "/demo", label: "Request a walkthrough" },
    ],
  },
  {
    title: "Features",
    links: [
      { href: "/features/treatment-memory", label: "Treatment memory" },
      { href: "/features/booking-calendar", label: "Booking and calendar" },
      { href: "/features/charting-records", label: "Charting and records" },
    ],
  },
  {
    title: "Resources",
    links: [
      { href: "/resources", label: "Resources" },
      {
        href: "/resources/electrolysis-treatment-record-checklist",
        label: "Treatment record checklist",
      },
      {
        href: "/resources/moving-an-electrolysis-practice-from-paper-records",
        label: "Moving from paper records",
      },
    ],
  },
  {
    title: "Company",
    links: [
      { href: "/privacy", label: "Privacy" },
      { href: "/terms", label: "Terms" },
      { href: "/login", label: "Sign in" },
      { href: `mailto:${CONTACT_EMAIL}`, label: "Contact" },
    ],
  },
] as const;

// ---------------------------------------------------------------------------
// Page metadata (prompt §22 titles, §21 canonicals/indexation).
// ---------------------------------------------------------------------------
// One entry per indexable public marketing/policy page. Each carries a unique
// title, a unique meta description grounded in verified capability, its
// canonical path, and whether it belongs in the sitemap. Titles for the two
// content-owned policy pages (privacy, terms) are left to those pages; they are
// listed here only so the sitemap can include them.
export type MarketingPage = {
  path: string;
  title: string | null; // null = the page owns its own <title>
  description: string | null;
  indexable: boolean;
};

export const MARKETING_PAGES: ReadonlyArray<MarketingPage> = [
  {
    path: "/",
    title: "Hone | Electrolysis practice software with treatment memory",
    description:
      "Electrolysis practice software that keeps a separate history for every treated area. Last time's settings, probe lot and response come forward before the next appointment.",
    indexable: true,
  },
  {
    path: "/electrolysis-software",
    title: "Electrolysis software built around the treatment record | Hone",
    description:
      "Practice software for electrologists. Modality, settings, probe and lot recorded per treated area, with booking, intake and consent connected to the same record.",
    indexable: true,
  },
  {
    path: "/pricing",
    title: "Pricing | Hone",
    description:
      "Simple plans in Canadian dollars. Every plan includes the full treatment workflow. No client caps, no appointment caps, no setup fee.",
    indexable: true,
  },
  {
    path: "/features/treatment-memory",
    title: "Treatment memory for electrologists | Hone",
    description:
      "Every treated area keeps its own history. Before a returning client sits down, Hone assembles last time's settings, probe lot, response and cautions into one view.",
    indexable: true,
  },
  {
    path: "/features/booking-calendar",
    title: "Booking and calendar, connected to the record | Hone",
    description:
      "Give clients an online booking page with real open times and double-booking protection, and run your day on a calendar built for an electrolysis practice.",
    indexable: true,
  },
  {
    path: "/features/charting-records",
    title: "Electrolysis charting and records | Hone",
    description:
      "Charting built around treatments, not generic notes: mode, modality, energy, frequency, pulses, probe and lot, laterality, tolerance and skin response, per area.",
    indexable: true,
  },
  {
    path: "/demo",
    title: "Request a walkthrough | Hone",
    description:
      "A founder-led walkthrough: open a returning client and watch the Before Today briefing assemble from their history.",
    indexable: true,
  },
  {
    path: "/resources",
    title: "Electrolysis Practice Resources & Record-Keeping Guides | Hone",
    description:
      "Practical guides for running an electrolysis practice, treatment record-keeping and moving from paper records, from the team building Hone.",
    indexable: true,
  },
  {
    path: "/resources/electrolysis-treatment-record-checklist",
    title: "Electrolysis Treatment Record Checklist | Hone",
    description:
      "A practical checklist of what to capture in an electrolysis treatment record, from client details and machine settings to probe lot and aftercare.",
    indexable: true,
  },
  {
    path: "/resources/moving-an-electrolysis-practice-from-paper-records",
    title: "Moving an Electrolysis Practice From Paper Records | Hone",
    description:
      "How to move an electrolysis practice from paper treatment cards to structured digital records without losing client history.",
    indexable: true,
  },
  { path: "/privacy", title: null, description: null, indexable: true },
  { path: "/terms", title: null, description: null, indexable: true },
] as const;

// Convenience: canonical paths that belong in the public sitemap (prompt §21).
export const SITEMAP_PATHS: ReadonlyArray<string> = MARKETING_PAGES.filter(
  (p) => p.indexable,
).map((p) => p.path);

// ---------------------------------------------------------------------------
// Privacy-safe analytics events (prompt §24). Names only, the firing is wired
// in the demo/analytics stage. Payloads must NEVER include name, email, studio,
// free text, tokenized URL, or any client/practitioner data.
// ---------------------------------------------------------------------------
export const ANALYTICS_EVENTS = {
  primaryCtaClick: "marketing:primary_cta_click",
  secondaryCtaClick: "marketing:secondary_cta_click",
  pricingPlanViewed: "marketing:pricing_plan_viewed",
  foundingCtaClick: "marketing:founding_cta_click",
  walkthroughFormStarted: "marketing:walkthrough_form_started",
  walkthroughFormSubmitted: "marketing:walkthrough_form_submitted",
  featureCtaClick: "marketing:feature_cta_click",
  resourceCtaClick: "marketing:resource_cta_click",
  // MKT-02B. Film V1 play. Name only, fired by the same delegator that carries
  // every other marketing event: no timing, no completion, no PII. It records
  // that the film was started, and nothing else.
  filmPlay: "marketing:film_play",
} as const;
export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[keyof typeof ANALYTICS_EVENTS];
