# Public-Site Baseline Audit — before the flagship rebuild

**Status:** internal. Captured at production head `325b124` (branch cut point for
`feat/marketing-site-category-seo-pricing`). This is the "before" snapshot the final
report (§32) rates the rebuild against. Source: read-only inspection of the live route
tree, `app/layout.tsx`, `app/page.tsx`, `app/pricing/page.tsx`, `app/demo/*`, marketing
components, and `docs/production/current-state.md` (reconciled 2026-07-17).

## Current public routes (the entire public surface)

Indexable marketing/policy pages that **exist today**: `/`, `/pricing`, `/demo`,
`/privacy`, `/terms`. **Nothing else.** Every category/feature/resource page in the
binding scope is greenfield:

- MISSING: `/electrolysis-software`, `/features/treatment-memory`,
  `/features/booking-calendar`, `/features/charting-records`, `/resources`,
  `/resources/electrolysis-treatment-record-checklist`,
  `/resources/moving-an-electrolysis-practice-from-paper-records`.

Public token/flow routes (must never enter the sitemap): `/book/[slug]`,
`/cancel/[token]`, `/reschedule/[token]`, `/manage/[token]`, `/intake/[token]`,
`/intake/thank-you`, `/calendar-feed/[token]`, `/portal`, `/portal/login`,
`/portal/verify/[token]`, `/login`, `/no-access`, `/auth/callback`, all `app/(app)/*`,
all `app/admin/*`, all `app/api/*`.

## Live titles & meta descriptions

| Route | Title | Description |
|---|---|---|
| `/` | `Hone \| Treatment Memory for Electrologists` (layout default) | Hone helps electrologists prepare for returning clients, chart treatment details, and keep cleaner procedure records. |
| `/pricing` | `Hone Pricing \| Electrolysis Practice Software` | Founding pilot pricing… one plan covers booking, intake, treatment plans, session charting, postcare, and client history. |
| `/demo` | `Hone Walkthrough \| Electrolysis Booking, Intake, and Charting` | Book a 15-minute founder-led walkthrough… |
| `/privacy`, `/terms` | own titles | own descriptions |

- Root metadata (`app/layout.tsx`): `metadataBase = https://hone.care`, template `%s · Hone`,
  OG `locale en_CA`, `twitter summary_large_image`, `robots { index:true, follow:true }`,
  keywords array. `<html lang="en">`. OG image via `app/opengraph-image.tsx` (edge, 1200×630).

## Current navigation & CTA language

- Desktop nav (`app/_components/marketingNav.ts`): Product (`/#product`), Records
  (`/#records`), Pricing (`/pricing`), Sign in (`/login`).
- Primary CTA everywhere: **"Book walkthrough" / "Book a walkthrough" → `/demo`**.
- Footer: single stacked group — brand, "Treatment memory, made carefully.", category
  line, © 2026, Privacy · Terms · privacy@hone.care · Sign in.
- Fonts: **`next/font/google` (Fraunces + Inter)** — a network-dependent build (must move
  to `next/font/local` per §11).

## Current pricing

- Single plan: **"Founding Pilot" $19/month** (currency shown only as `$`, no CAD/USD
  code). "$149/year founding annual for the first 25 studios" in the FAQ. "Unlimited
  clients and sessions." FAQ: absolute "You do not need Calendly, Jane, or Square
  Appointments on top"; "more than five practitioners → contact us."

## Current `/demo` workflow

- **Lead-capture form** (confirmed): inserts a `demo_requests` row; the founder replies
  within one business day to schedule. No calendar, no slot selection, no appointment
  received during submission. Fields: name + email required; practice name, location,
  practice type, practitioner count, current tool, notes optional. **No phone field.**
  Submit reads **"Book the walkthrough"**; success: "…we will be in touch within one
  business day to book your walkthrough." Rate-limited (5/h IP + 2/day email, hashed,
  fail-open). → **CTA verb must become "Request"** (addendum §3).

## SEO / technical infrastructure inventory

| Primitive | State |
|---|---|
| `app/sitemap.ts` | **MISSING** (greenfield) |
| `app/robots.ts` | **MISSING** — robots only via `metadata.robots` in layout |
| Canonical tags / `alternates.canonical` | **NONE anywhere** |
| Per-page metadata | present for `/pricing`, `/demo`, `/privacy`, `/terms`; home uses layout default |
| JSON-LD / structured data | **NONE** (no Organization/WebSite/SoftwareApplication/Breadcrumb/Article) |
| Breadcrumbs | none |
| Page-specific OG images | only the sitewide `app/opengraph-image.tsx` |
| Preview `noindex` protection | **NONE** — no env-gated noindex for preview deployments |
| Resource infrastructure | none |

## Analytics baseline

- Only `app/_components/SafeAnalytics.tsx` → Vercel `<Analytics/>` + `<SpeedInsights/>`
  (automatic pageviews + Web Vitals). **No custom/named events, no `track()` calls, no
  custom payloads** anywhere. Mounted per-page (opt-in) on `/`, `/demo`, `/pricing`,
  policy pages, `/book`, app, admin — deliberately **not** in the root layout so
  bearer-token URLs never reach the analytics provider. Two documented-but-unimplemented
  marketing tracking plans exist (`docs/22`, `docs/23`); no Meta Pixel code is present.
- Privacy-safe custom events (§24) are new work for the demo/analytics stage.

## Metrics availability (honesty — "do not claim metrics that cannot be obtained")

- **Google Search Console** query/page data: not accessible from this environment →
  no baseline impressions/clicks/query claims will be made.
- **Field / CrUX Core Web Vitals**: not accessible here → performance will be reported as
  **lab (Lighthouse)** only, clearly labelled, never presented as field data.
- **Existing CTA / demo-form conversion analytics**: none captured (no custom events) →
  no historical conversion baseline exists to cite.

## Current-site rating by category (the "before")

Scored 1–5 (5 = flagship). This is the baseline the final report improves on.

| Category | Score | Why |
|---|---|---|
| Product truth | 4 | Honest, disciplined, demo-data-only, no AI overclaim. But `$19 pilot` and "Book" on a lead-capture form are truthfulness gaps; absolute "replaces Jane/Square." |
| Positioning / 5-second test | 3 | Plain and practitioner-first, but eyebrow == H1, category ("electrolysis practice software") is under-owned, and "treatment memory" isn't framed as the category-defining advantage. |
| YC conversion | 2 | One CTA but weak ("Book" on a request flow), thin proof, no pricing clarity above the fold, no comparison/objection handling. |
| Design | 3 | Calm warm palette and restrained, but single-file homepage, generic-ish sections, no signature product-memory visual, network Google Fonts. |
| Motion | 2 | Minimal `Reveal` only; no purposeful signature animation; no documented reduced-motion story. |
| SEO / technical | 1 | No sitemap, robots.ts, canonicals, JSON-LD, breadcrumbs, or per-page OG; only 5 public pages; no category/feature/resource coverage. |
| Trust | 4 | Strong, evidence-backed privacy/trust posture; needs the trust claims surfaced with recorded evidence and a payment qualifier. |
| Pricing | 2 | Single `$19` pilot, no CAD label, unsupported annual + multi-location statements. |

**Headline gaps the rebuild must close:** (1) no technical-SEO foundation at all; (2)
no category/feature/resource pages; (3) CTA-verb truthfulness on the lead-capture flow;
(4) CAD pricing structure; (5) a signature product-memory visual + design system; (6)
privacy-safe conversion analytics.
