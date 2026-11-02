import type { Metadata } from "next";
import Link from "next/link";
import { SafeAnalytics } from "./_components/SafeAnalytics";
import { SkipLink } from "./_components/marketing/SkipLink";
import { SiteHeader } from "./_components/marketing/SiteHeader";
import { SiteFooter } from "./_components/marketing/SiteFooter";
import {
  MarketingSurface,
  Container,
  Section,
  Eyebrow,
  Display,
  Title,
  Subtitle,
  Lede,
  CTAButton,
} from "./_components/marketing/primitives";
import { WorkflowGrid, FeatureMatrix } from "./_components/marketing/sections";
import { JsonLd } from "./_components/marketing/JsonLd";
import { organizationLd, webSiteLd, softwareApplicationLd } from "@/lib/marketing/jsonld";
import { ProductFilm } from "./_components/marketing/ProductFilm";
import { TreatmentMemoryPanel } from "./_components/marketing/visuals/TreatmentMemoryPanel";
import { SessionRecordPreview } from "./_components/marketing/visuals/SessionRecordPreview";
import { CalendarPreview } from "./_components/marketing/visuals/CalendarPreview";
import {
  POSITIONING,
  WALKTHROUGH,
  PRICING_PLANS,
  PAYMENT_QUALIFIER,
  ANALYTICS_EVENTS,
} from "@/lib/marketing/content";
import { marketingMetadata } from "@/lib/marketing/metadata";

// Public marketing homepage — copy deck v2.2 §3, the film release (MKT-02B),
// and the compact opening (MKT-03).
//
// THE FILM IS THE OPENING, NOT THE SECOND SCREEN. MKT-02B led the argument with
// the film but kept a tall type-only hero above it, so at 1440x900 the film
// began about 1,100px down and no first screen anywhere showed the product.
// MKT-03 keeps the opening to one compact row (category and headline beside the
// sub and the one button) and puts the film directly beneath it, at full shell
// width on desktop and edge to edge on a phone, with the band rising behind it;
// it plays on its own, muted, while at least half of it is in view. At
// 1440x900 the film starts about 270px down.
//
// EDITORIAL PACING, NOT A STACK OF EQUAL CARDS. Each block gets the structure
// its content actually wants, and the tones alternate so the page has a rhythm:
//
//   hero        paper   one row: category + headline | sub + the button
//   1 film      BAND    the film first, then its heading and what it shows
//   2 areas     paper   editorial split, product panel right
//   3 fields    warm    a typographic A/B: a free-text note beside the fields
//   4 workflow  paper   heading across the top, then calendar | ordered steps
//   5 records   BAND    four lines, no image, after three image blocks
//   6 kept      paper   the shared ruled matrix
//   7 pricing   warm    ruled columns sharing one rule, not three floating cards
//   8 CTA       BAND    centred, the request and what happens in it
//
// MKT-03 revision 3 (the anti-slop pass) removed the trust strip, whose four
// lines all reappear in sections 6 and 7, and the two slogan labels that sat
// above the film's heading and the close.
//
// ONE RHYTHM. No section here overrides its padding any more: each reads the
// site-wide --mk-section-pad (32px on a phone up to 64px on a wide desktop)
// through the Section primitive. The opening and the film band's top edge are
// the deliberate exceptions, and both are tighter, not looser.
//
// ONE H1 — marketing-integrity counts the Display primitive by source shape, so
// this file must never even NAME that tag outside the hero. Copy-critical
// lines come from lib/marketing/content.ts; nothing here restates a constant.
// Every claim is a truth-register row — see the PR body for the two lines that
// need the operator's own confirmation rather than a code reading.

export const metadata: Metadata = marketingMetadata("/");

// Deck §3.5. The connected workflow, in the order a visit actually happens.
// Rendered through the shared WorkflowGrid so the homepage does not hand-roll a
// second numbered-sequence treatment.
//
// Each body is a full sentence with its actor (MKT-03 revision 3): the
// fragments ("Health history before the visit.") read as a template grid.
const WORKFLOW_STEPS: { n: string; title: string; body: string }[] = [
  { n: "01", title: "Booking", body: "Clients book online from your studio's booking page, and the appointment lands on your calendar." },
  { n: "02", title: "Intake", body: "Clients complete a health history before the visit, and answers such as a pacemaker or an EpiPen are flagged for you to review." },
  { n: "03", title: "Consent", body: "Hone keeps the exact text each client signed, with their signature and the time." },
  { n: "04", title: "Treatment", body: "You chart areas, settings, probe and lot at the point of care." },
  { n: "05", title: "Follow-up", body: "Aftercare and your note for next time come back at the next visit." },
  { n: "06", title: "Payment", body: `Take payment at the session, keep a card on file and issue refunds. ${PAYMENT_QUALIFIER}` },
];

// Deck §3.6. Four lines, no image — the band earns its contrast by being the
// one block on the page with nothing to look at.
const RECORD_LINES: string[] = [
  "Probe lots are recorded on each treatment and linked to your inventory.",
  "Sterile items and disinfectants are logged with their expiry dates.",
  // NARROWED. This read "Edits kept as history, not written over", which
  // promised append-only behaviour for every edit. Treatment and session values
  // are editable IN PLACE — the register is explicit that records "stay
  // editable" and forbids implying immutability. What is genuinely append-only
  // is the clinical note: a correction is a new row (`supersedes_note_id`), and
  // the register lists that among the claims still marketable as written.
  "A corrected clinical note is saved as a new revision, and the original stays readable.",
  "Hone flags gaps such as a missing probe lot, aftercare not marked or a completed appointment not yet charted.",
];

// Deck §3.7. The export line resolves the deck's [VERIFY] the only way it can
// be resolved honestly: by naming the subset. TRUTH-01A established that the
// export is clients, sessions, charting, appointments, plans, clinical notes
// and record-keeping logs — NOT photos, intake forms, signed consents, the
// service menu or payment records. lib/export/resource-registry.ts is the
// authority. The unbounded whole-history phrasing is the claim that had to go.
const OWNERSHIP: { title: string; body: string }[] = [
  {
    title: "Export your records as CSV, on every plan",
    body: "Clients, sessions, charting, appointments, treatment plans and record-keeping logs. The export page lists what it does and does not yet include.",
  },
  {
    // Plain words for the mechanism (MKT-03 revision 3). "Row-level security"
    // is the database's term; what a practitioner needs is where the line is.
    title: "Each studio's records are kept apart",
    body: "Hone separates each studio's records from every other studio's in the database itself.",
  },
  {
    // Register: private per-studio bucket, EXIF/GPS stripped on upload, 60s
    // path-bound signed URLs. Said as what a practitioner would notice.
    title: "Treatment photos stay private",
    body: "Photos are stored privately for your studio, with location and camera data removed on upload. They open only through links that expire within a minute.",
  },
  {
    title: "No AI training on your records",
    body: "Hone does not train AI models on practitioner or client records. The checks that flag record gaps follow fixed rules and use no AI.",
  },
  {
    title: "Imported history stays labelled",
    body: "History brought over from paper or another system keeps an imported label, separate from what you chart in Hone.",
  },
  {
    // THE RETIRED LINE IS DESCRIBED, NEVER REPRODUCED — MKT-02A's rule, and it
    // is load-bearing: the guard for this defect scans this file, so quoting the
    // sentence back would trip the assertion that forbids it. (It did, once.)
    //
    // What was here was a cancellation promise that the studio's records leave
    // with them in full. It was an overclaim and it contradicted the very first
    // item in this list. The self-service export does NOT carry treatment
    // photos, intake forms, signed consents, the service menu or payment
    // records — /settings/data names them "Not included yet" — and there is no
    // documented route for obtaining the rest, so naming one here would be a
    // second overclaim stacked on the first. The line now bounds itself to the
    // list above and promises nothing beyond it.
    // "No contract" and "no minimum term" are both gone: the pricing truth work
    // retired the contract claim, and neither is verifiable from anything in
    // this repository. What remains are the two terms the operator actually
    // publishes. The bounded export wording below is unchanged.
    title: "No setup fee, and you can cancel anytime",
    body: "If you leave, the CSV export described above is what you take with you.",
  },
];

export default function HomePage() {
  return (
    <MarketingSurface>
      <SkipLink />
      {/* The opening carries the walkthrough request itself, a few hundred
          pixels below the header, so the header drops its copy on this page. */}
      <SiteHeader cta={false} />
      <main id="main-content" className="scroll-mt-16">
        {/* ── Hero ─────────────────────────────────────────────────────────
            ONE ROW ON A DESKTOP (MKT-03 revision 3): the category and the
            headline on the left; the sentence that explains it and the one
            button together on the right, the two sides sharing a bottom edge.
            Revision 2 stacked all four in one left column, which left the
            right half of the first screen empty and pushed the film 506px
            down at 1440x900. The row is about 145px tall, so the film now
            starts inside 280px with the product showing. Revision 1 also used
            two columns, but under a header that carried a second copy of the
            same button; the header drops its request on this page, so this is
            the only "Request a walkthrough" in the opening.

            On a phone and a tablet the same four parts stack in reading order
            with tight, even gaps, and the film follows. */}
        <Container className="grid gap-x-[clamp(2.5rem,6vw,6.5rem)] gap-y-5 pb-[clamp(1.25rem,1rem+0.75vw,1.75rem)] pt-[clamp(1.25rem,0.75rem+1.25vw,2rem)] lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] lg:items-end">
          <div>
            <Eyebrow>{POSITIONING.heroEyebrow}</Eyebrow>
            <Display className="mt-2.5">{POSITIONING.heroH1}</Display>
          </div>
          <div>
            <Lede>{POSITIONING.heroSub}</Lede>
            <CTAButton
              href={WALKTHROUGH.href}
              event={ANALYTICS_EVENTS.primaryCtaClick}
              className="mt-5 max-sm:w-full"
            >
              {WALKTHROUGH.primaryLabel}
            </CTAButton>
          </div>
        </Container>

        {/* ── 1. Before the client sits down ───────────────────────────────
            The one cinema moment, and the first thing on the band: the film
            at full width, then its heading and a plain list of what it
            actually shows, taken from its own transcript.

            NO STRIP OF BAND ABOVE THE FILM. The band used to open with its own
            padding, so between the button and the picture sat a strip of
            paper and then a strip of band. Now the band has no top padding
            and starts behind the film, halfway down (`mk-film-rise`, in
            app/globals.css). The film's top half sits on paper, so it draws
            its own hairline edge (`framed`). */}
        <Section tone="band" className="mk-film-rise !pt-0">
          <Container>
            <ProductFilm autoplay bleed framed />
            {/* What the film shows, as one column under it, not a second
                split beside it: the opening row already spends that move. */}
            <div className="mt-[clamp(1.75rem,1rem+2vw,3rem)] max-w-[44rem]">
              {/* No label above the heading: the category line it carried is
                  the footer's, and here it only repeated the film's own title
                  card a few hundred pixels up. */}
              <Title className="text-paper">Before the client sits down</Title>
              <Lede onBand className="mt-4">
                Review the last treatment, check the settings used and chart today&rsquo;s
                session.
              </Lede>
              {/* Label and destination move together: MKT-02A repointed this
                  at the treatment-memory page, and a control may only promise
                  what its destination delivers. Here it follows the film it
                  explains, instead of crowding the opening. */}
              <Link
                href={WALKTHROUGH.secondaryHref}
                data-event={ANALYTICS_EVENTS.featureCtaClick}
                className="mt-3 inline-flex min-h-11 items-center text-[0.9375rem] font-medium text-paper underline decoration-[color:var(--color-onband-muted)] underline-offset-[6px] hover:decoration-paper focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-paper)]"
              >
                {WALKTHROUGH.secondaryLabel}
              </Link>
            </div>
          </Container>
        </Section>

        {/* THE TRUST STRIP IS GONE (MKT-03 revision 3). Each of its four
            lines was said again in full lower on this page, in the records
            section and at pricing, so the strip was a repeat, not a block. */}

        {/* ── 2. Every area keeps its own history ─────────────────────────── */}
        <Section tone="paper">
          <Container className="grid items-center gap-[clamp(2rem,4vw,4.5rem)] lg:grid-cols-[1.02fr_0.98fr]">
            <div>
              <Title className="max-w-[15ch]">Every area keeps its own history</Title>
              <p className="mt-5 max-w-[38ch] text-[1.1875rem] leading-[1.4] text-ink sm:text-[1.25rem]">
                Upper lip, chin, neck and brows each keep their own record.
              </p>
              {/* THE PRODUCT MODEL, NOT A SIMPLIFICATION OF IT. This claimed a
                  four-area appointment is recorded as four separate treatments.
                  It is not: Hone records several areas under ONE machine-settings
                  block when the same setup applies (register: "Multi-area under
                  one settings block + per-area laterality", 0128/0129). The
                  per-area promise that IS true is findability — memory is kept
                  per treatment area — so that is what this says now. */}
              <Lede className="mt-4 max-w-[46ch]">
                Treat several areas at the same settings and Hone records them under
                one settings block. Each area stays findable in its own history, and areas
                treated at different settings get a block of their own.
              </Lede>
            </div>
            <TreatmentMemoryPanel />
          </Container>
        </Section>

        {/* ── 3. Each detail in its own field ──────────────────────────────
            A typographic A/B: a real free-text note, set large and muted,
            beside the same treatment recorded as fields. The comparison is the
            layout; neither side is a card. The heading names what Hone does
            rather than setting it against a note. */}
        <Section tone="warm">
          <Container>
            <Title className="max-w-[16ch]">Each detail in its own field</Title>
            <div className="mt-[clamp(1.75rem,3vw,3rem)] grid gap-[clamp(2rem,4vw,4rem)] lg:grid-cols-[0.9fr_1.1fr] lg:items-start">
              <div>
                <p className="text-[0.9375rem] font-medium text-muted">A free-text note</p>
                <p className="mt-3 border-l border-[color:var(--color-hairline-strong)] pl-5 text-[clamp(1.375rem,1.1rem+1vw,1.75rem)] leading-[1.35] text-muted">
                  &ldquo;Upper lip treated, tolerated well.&rdquo;
                </p>
                <Lede className="mt-6 max-w-[42ch]">
                  Hone records the areas treated, the machine settings, probe and lot, how
                  each area was tolerated and the note for next time, each in its own field.
                  That keeps every area findable on its own, and lets Hone tell you when
                  something is missing.
                </Lede>
                <Link
                  href="/features/charting-records"
                  data-event={ANALYTICS_EVENTS.featureCtaClick}
                  className="mt-3 inline-flex min-h-11 items-center text-[0.9375rem] font-medium text-mineral underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-mineral)]"
                >
                  See every field Hone records
                </Link>
              </div>
              <SessionRecordPreview />
            </div>
          </Container>
        </Section>

        {/* ── 4. The connected workflow ────────────────────────────────────
            The heading runs across the top, so it never stands tall in a
            narrow column. Under it, the calendar and the ordered steps sit side
            by side at the same height: the steps carry no fixed title height
            and the calendar keeps its natural size. On a phone and a tablet the
            steps stand alone; the calendar is a desktop composition. The lede
            that restated the six steps is gone: the steps say it. */}
        <Section tone="paper" id="how-hone-works">
          <Container>
            <Title className="max-w-[24ch] lg:max-w-none">{POSITIONING.differentiationLine}</Title>
            <div className="mt-[clamp(1.75rem,3vw,3rem)] grid items-start gap-[clamp(2rem,4vw,4rem)] lg:grid-cols-[minmax(18rem,0.75fr)_minmax(0,1.6fr)]">
              <div className="hidden lg:block">
                <CalendarPreview />
              </div>
              <WorkflowGrid steps={WORKFLOW_STEPS} />
            </div>
          </Container>
        </Section>

        {/* ── 5. Know what was used, and when ──────────────────────────────
            The band with nothing to look at. Four lines, large, ruled. */}
        <Section tone="band">
          <Container>
            <div className="grid gap-[clamp(1.5rem,3vw,3.5rem)] lg:grid-cols-[0.8fr_1.2fr] lg:items-start">
              <Title className="max-w-[14ch] text-paper">Know what was used, and when</Title>
              <ul className="border-t border-white/15">
                {RECORD_LINES.map((line) => (
                  <li
                    key={line}
                    className="border-b border-white/15 py-4 text-[clamp(1.0625rem,1rem+0.4vw,1.25rem)] leading-[1.45] text-paper"
                  >
                    {line}
                  </li>
                ))}
              </ul>
            </div>
            <Link
              href="/features/charting-records"
              data-event={ANALYTICS_EVENTS.featureCtaClick}
              className="mt-5 inline-flex min-h-11 items-center text-[0.9375rem] font-medium text-[color:var(--color-wash)] underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-paper)]"
            >
              More on records and logs
            </Link>
          </Container>
        </Section>

        {/* ── 6. How your records are kept ─────────────────────────────────
            The shared ruled matrix — a designed table, not six floating
            cards. No badges, no hosting-location line. */}
        <Section tone="paper">
          <Container>
            <Title className="max-w-[18ch]">{POSITIONING.recordsHeading}</Title>
            <FeatureMatrix
              items={OWNERSHIP.map((o) => ({ title: o.title, body: o.body }))}
            />
            <p className="mt-6 text-[0.9375rem] text-muted">
              Read the{" "}
              <Link href="/privacy" className="font-medium text-mineral underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-mineral)]">
                privacy policy
              </Link>{" "}
              for the full detail.
            </p>
          </Container>
        </Section>

        {/* ── 7. Plans in US dollars (USD) ──────────────────────────────────
            Three columns because Hone shows three tiers, sharing ONE top rule
            and one baseline, divided by hairlines. A price list, not three
            cards competing for a click, and no plan is marked as recommended. */}
        <Section tone="warm" id="pricing">
          <Container>
            <Title className="max-w-[20ch]">{POSITIONING.pricingHeading}</Title>
            <Lede className="mt-5 max-w-[48ch]">{POSITIONING.noCapsLine}</Lede>
            {/* everyPlanIncludes NAMES PAYMENTS, so the qualifier is not
                optional — card-on-file is LIVE_WITH_GUIDED_SETUP, not live for
                everyone, and MKT-02A pins the pairing obligation. */}
            <p className="mt-3 max-w-[52ch] text-[0.9375rem] leading-[1.6] text-muted">
              {POSITIONING.everyPlanIncludes} {PAYMENT_QUALIFIER}
            </p>

            <div className="mt-[clamp(1.75rem,3vw,3rem)] grid grid-cols-1 border-t border-[color:var(--color-hairline-strong)] sm:grid-cols-3">
              {PRICING_PLANS.map((plan) => (
                <div
                  key={plan.id}
                  className="flex flex-col border-b border-[color:var(--color-hairline)] py-6 sm:px-7 sm:[&:first-child]:pl-0 sm:[&:last-child]:pr-0 sm:[&:not(:first-child)]:border-l sm:[&:not(:first-child)]:border-[color:var(--color-hairline)]"
                >
                  <Subtitle as="h3">{plan.name}</Subtitle>
                  <p className="mt-3">
                    <span className="text-[1.75rem] font-semibold text-ink">
                      {plan.priceLabel ?? "Contact us"}
                    </span>
                    {plan.cadence ? (
                      <span className="text-[0.9375rem] text-muted">{plan.cadence}</span>
                    ) : null}
                  </p>
                  {plan.seats ? (
                    <p className="mt-1 text-[0.875rem] text-muted">For {plan.seats}</p>
                  ) : null}
                  <p className="mt-3 text-[0.9375rem] leading-[1.55] text-muted">
                    {plan.bestFor}
                  </p>
                </div>
              ))}
            </div>

            <p className="mt-5 max-w-[60ch] text-[0.9375rem] text-muted">{POSITIONING.assuranceLine}</p>
            {/* One action here, an outline. The walkthrough request that sat
                beside it is the closing band's own button, directly below, so
                the two read as the same link twice. */}
            <div className="mt-6">
              <CTAButton
                href="/pricing"
                variant="outline"
                event={ANALYTICS_EVENTS.pricingPlanViewed}
                className="max-sm:w-full"
              >
                See pricing details
              </CTAButton>
            </div>
          </Container>
        </Section>

        {/* ── 8. Walkthrough CTA ───────────────────────────────────────────
            No label above the heading. It used to carry the film's end-card
            line, which repeated a slogan the visitor had already seen. */}
        <Section tone="band">
          <Container className="text-center">
            <Title className="mx-auto max-w-[18ch] text-paper">
              {POSITIONING.walkthroughHeading}
            </Title>
            <Lede onBand className="mx-auto mt-5 max-w-[52ch]">
              In a walkthrough, we open a returning client and you watch Before Today assemble
              from their history. If Hone fits, we set up your studio and bring your existing
              clients across.
            </Lede>
            <div className="mt-8 flex justify-center">
              <CTAButton
                href={WALKTHROUGH.href}
                onBand
                event={ANALYTICS_EVENTS.primaryCtaClick}
                className="max-sm:w-full"
              >
                {WALKTHROUGH.primaryLabel}
              </CTAButton>
            </div>
          </Container>
        </Section>
      </main>
      <SiteFooter />
      <SafeAnalytics />
      <JsonLd data={organizationLd()} />
      <JsonLd data={webSiteLd()} />
      <JsonLd data={softwareApplicationLd()} />
    </MarketingSurface>
  );
}
