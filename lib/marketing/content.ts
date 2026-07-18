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
//     addendum §3). `/demo` is a lead-capture form — the founder replies to
//     schedule; the visitor never selects a real appointment time — so the
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
// Positioning (prompt §5) — the fixed hero and category language.
// ---------------------------------------------------------------------------
export const POSITIONING = {
  category: "Electrolysis practice software",
  differentiator: "Treatment memory",
  corePromise: "Hone carries the important details from one appointment into the next.",
  // "Operating system" is a category metaphor, not a claim that every business
  // function already exists.
  categoryAmbition: "The operating system for a modern electrolysis practice.",
  heroEyebrow: "Electrolysis practice software",
  heroH1: "Electrolysis practice software that remembers every treatment.",
  heroSupporting:
    "Run booking, intake, consent, treatment records, photos, client follow-up, and next-visit preparation in one calm workflow built for electrologists.",
  differentiationLine:
    "Your calendar remembers the appointment. Hone helps you remember the treatment.",
  // Kept in supporting copy, metadata, and footer — but never duplicated as
  // both the eyebrow and the H1 (prompt §5).
  keepPhrase: "Treatment memory for electrologists",
  // Proof line — every clause is evidence-backed in the truth register (§23).
  proofLine:
    "Built around real electrolysis workflows · Founder-led setup · Free standard client import · Cancel anytime",
} as const;

// ---------------------------------------------------------------------------
// Primary conversion — the founder-led walkthrough (prompt §5, §19; addendum §3)
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
  // Header/nav (tight space) — still "Request", never "Book".
  primaryLabelShort: "Request a walkthrough",
  // Hero, pricing, section CTAs.
  primaryLabel: "Request a 15-minute walkthrough",
  secondaryLabel: "See how Hone works",
  // Demo page — heading, submit control, and success state all describe the
  // same lead-capture reality (founder replies to schedule).
  demoHeading: "Request a 15-minute Hone walkthrough.",
  submitLabel: "Request my walkthrough",
  submitPendingLabel: "Sending…",
  successMessage:
    "Thanks — we'll be in touch within one business day to set up your walkthrough.",
} as const;

// ---------------------------------------------------------------------------
// Pricing (prompt §15/§16; addendum §1 CAD, §2 operationally-fulfillable)
// ---------------------------------------------------------------------------
//
// Currency is CAD everywhere. No Stripe Products/Prices are created. No caps,
// quotas, SMS overages, automatic seat billing, annual gimmicks, or fake
// scarcity. Core treatment memory / charting / intake / consent / records are
// NOT crippled to build tiers — tiers differ only by who the plan is for and
// how many practitioners it covers.
//
// STUDIO DECISION: published at CAD $99/month for up to three practitioners.
// Rationale (recorded in the truth register): multi-practitioner studios are
// LIVE_FOR_ALL_ONBOARDED — each practitioner charts under their own name and is
// colour-coded on the shared calendar, and owners invite/manage/remove
// practitioners — and this works for three (and more) practitioners today. The
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

// Assurances — each is evidence-backed in the truth register (§23). No setup
// fee / no contract / cancel anytime / free standard import / founder-led setup.
export const PRICING_ASSURANCES: ReadonlyArray<string> = [
  "Founder-led setup",
  "Free standard client import",
  "No setup fee",
  "No contract — cancel anytime",
] as const;

// Payment qualifier — used wherever payments are mentioned. Never imply
// self-service live-payment activation (§3 payment rule).
export const PAYMENT_QUALIFIER = "Payments are enabled during guided onboarding." as const;

// The only approved "replaces" wording (prompt §16). Conditional, never absolute.
export const REPLACES_STATEMENT =
  "Hone can replace a separate booking calendar, intake tool, treatment-notes system, and client portal for practices that fit Hone's current workflow." as const;

// ---------------------------------------------------------------------------
// Public capability groups (prompt §7) — broad, outcome-led, truthful labels.
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
// release — NO dead Phase-2 links.
// ---------------------------------------------------------------------------
export type NavLink = { href: string; label: string };

// Product menu links only to shipped routes.
export const PRODUCT_MENU: ReadonlyArray<NavLink> = [
  { href: "/electrolysis-software", label: "Electrolysis software" },
  { href: "/features/treatment-memory", label: "Treatment memory" },
  { href: "/features/booking-calendar", label: "Booking and calendar" },
  { href: "/features/charting-records", label: "Charting and records" },
] as const;

export const PRIMARY_NAV: ReadonlyArray<NavLink> = [
  { href: "/electrolysis-software", label: "Product" },
  { href: "/features/treatment-memory", label: "Treatment memory" },
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
    title: "Electrolysis Practice Software That Remembers Every Treatment | Hone",
    description:
      "Hone is electrolysis practice software that remembers every treatment — booking, intake, consent, charting, photos, records, and next-visit prep in one calm workflow built for electrologists.",
    indexable: true,
  },
  {
    path: "/electrolysis-software",
    title: "Electrolysis Software for Booking, Charting & Client Records | Hone",
    description:
      "Electrolysis practice software for booking, intake and consent, treatment charting, client records, and returning-client treatment memory — built for electrologists, not generic salon tools.",
    indexable: true,
  },
  {
    path: "/pricing",
    title: "Hone Pricing | Electrolysis Practice Software",
    description:
      "Simple CAD pricing for Hone electrolysis practice software: Founding Solo, Solo, and Studio plans with founder-led setup, free standard import, and no setup fee. Cancel anytime.",
    indexable: true,
  },
  {
    path: "/features/treatment-memory",
    title: "Treatment Memory Software for Electrologists | Hone",
    description:
      "Before a returning client sits down, Hone shows the last treatment's areas, settings, probe lot, and how the client responded — assembled automatically from what you already charted.",
    indexable: true,
  },
  {
    path: "/features/booking-calendar",
    title: "Electrolysis Booking and Calendar Software | Hone",
    description:
      "Give clients an online booking page with real open times and double-booking protection, and run your day on a calendar built for an electrolysis practice.",
    indexable: true,
  },
  {
    path: "/features/charting-records",
    title: "Electrolysis Charting and Treatment Records | Hone",
    description:
      "Chart electrolysis and laser sessions at the point of care — machine settings, probe lot, treatment areas, and observations — and keep clean, print-ready procedure records.",
    indexable: true,
  },
  {
    path: "/demo",
    title: "Request a Hone Walkthrough | Electrolysis Practice Software",
    description:
      "Request a 15-minute founder-led walkthrough of Hone. We'll show booking, intake, charting, treatment memory, and records using your real workflow, then decide together whether Hone fits.",
    indexable: true,
  },
  {
    path: "/resources",
    title: "Electrolysis Practice Resources & Record-Keeping Guides | Hone",
    description:
      "Practical guides for running an electrolysis practice — treatment record-keeping and moving from paper records — from the team building Hone.",
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
// Privacy-safe analytics events (prompt §24). Names only — the firing is wired
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
} as const;
export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[keyof typeof ANALYTICS_EVENTS];
