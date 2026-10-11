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
  FILM,
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
//   2 trust     paper   a thin ruled strip, deliberately not a section
//   3 areas     paper   editorial split, product panel right
//   4 note      warm    a typographic A/B — the sentence against the fields
//   5 workflow  paper   heading across the top, then calendar | ordered steps
//   6 records   BAND    four lines, no image, after three image blocks
//   7 yours     paper   the shared ruled matrix
//   8 pricing   warm    ruled columns sharing one rule, not three floating cards
//   9 CTA       BAND    centred, the film's own closing line as its label
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
const WORKFLOW_STEPS: { n: string; title: string; body: string }[] = [
  { n: "01", title: "Booking", body: "A booking page for your studio and a shared calendar." },
  { n: "02", title: "Intake", body: "Health history before the visit. A pacemaker or an EpiPen is flagged before the appointment." },
  { n: "03", title: "Consent", body: "The exact text the client signed, with signature and timestamp." },
  { n: "04", title: "Treatment", body: "Areas, settings, probe and lot recorded as fields at the point of care." },
  { n: "05", title: "Follow-up", body: "Aftercare and next-treatment notes carried to the next visit." },
  { n: "06", title: "Payment", body: `Take payment at the session, keep a card on file, issue refunds. ${PAYMENT_QUALIFIER}` },
];

// Deck §3.6. Four lines, no image — the band earns its contrast by being the
// one block on the page with nothing to look at.
const RECORD_LINES: string[] = [
  "Probe lots recorded on the treatment and linked to your inventory.",
  "Sterile-item and disinfectant expiry logged.",
  // NARROWED. This read "Edits kept as history, not written over", which
  // promised append-only behaviour for every edit. Treatment and session values
  // are editable IN PLACE — the register is explicit that records "stay
  // editable" and forbids implying immutability. What is genuinely append-only
  // is the clinical note: a correction is a new row (`supersedes_note_id`), and
  // the register lists that among the claims still marketable as written.
  "Clinical note corrections are kept as revisions, not written over.",
  "Record gaps flagged: a missing probe lot, aftercare not marked, a completed appointment not yet charted.",
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
    body: "Clients, sessions, charting, appointments, treatment plans and record-keeping logs. The export names in writing what it does and does not yet include.",
  },
  {
    title: "Each studio's records are isolated",
    body: "Separated from every other studio's with database row-level security.",
  },
  {
    title: "Treatment photos stay private",
    body: "Stored in a private per-studio bucket, camera metadata stripped, opened through short-lived links — never public URLs.",
  },
  {
    title: "No AI training on your records",
    body: "Hone does not train AI models on practitioner or client records. The checks that flag record gaps are rules, not AI.",
  },
  {
    title: "Imported history is always marked as imported",
    body: "History brought over from paper or another system stays labelled, never mixed into what you charted in Hone.",
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
    title: "No setup fee. Cancel anytime.",
    body: "What you can take with you is the export named above — nothing here promises more than that list.",
  },
];

export default function HomePage() {
  // The workflow heading is two sentences, and on a wide screen it reads as
  // two lines that break where the sentences do — not as a five-line column.
  const workflowHeading = POSITIONING.differentiationLine.split(/(?<=\.)\s+/);

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
              <Eyebrow onBand>{POSITIONING.keepPhrase}</Eyebrow>
              <Title className="mt-2 text-paper">Before the client sits down</Title>
              <Lede onBand className="mt-4">
                {`In ${FILM.durationSeconds} silent seconds: the week's calendar, the last treatment area by area, the exact setup used, today's charting and one client record.`}
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

        {/* ── 2. Trust strip ───────────────────────────────────────────────
            Not a Section and not four cards: one ruled row, the width of the
            shell, that a visitor reads in a single pass on the way down. */}
        <Container className="py-[clamp(1.5rem,2.5vw,2.25rem)]">
          <ul className="grid grid-cols-1 divide-y divide-[color:var(--color-hairline)] border-y border-[color:var(--color-hairline)] sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4">
            {POSITIONING.trustStrip.split(" · ").map((line) => (
              <li
                key={line}
                className="py-3.5 text-[0.9375rem] leading-[1.45] text-muted sm:border-b sm:border-[color:var(--color-hairline)] sm:pr-6 lg:border-b-0 lg:[&:not(:first-child)]:border-l lg:[&:not(:first-child)]:border-[color:var(--color-hairline)] lg:[&:not(:first-child)]:pl-6"
              >
                {line}
              </li>
            ))}
          </ul>
        </Container>

        {/* ── 3. Every area keeps its own history ─────────────────────────── */}
        <Section tone="paper">
          <Container className="grid items-center gap-[clamp(2rem,4vw,4.5rem)] lg:grid-cols-[1.02fr_0.98fr]">
            <div>
              <Title className="max-w-[15ch]">Every area keeps its own history</Title>
              <p className="mt-5 max-w-[38ch] text-[1.1875rem] leading-[1.4] text-ink sm:text-[1.25rem]">
                Upper lip, chin, neck and brows don&apos;t share one note.
              </p>
              {/* THE PRODUCT MODEL, NOT A SIMPLIFICATION OF IT. This claimed a
                  four-area appointment is recorded as four separate treatments.
                  It is not: Hone records several areas under ONE machine-settings
                  block when the same setup applies (register: "Multi-area under
                  one settings block + per-area laterality", 0128/0129). The
                  per-area promise that IS true is findability — memory is kept
                  per treatment area — so that is what this says now. */}
              <Lede className="mt-4 max-w-[46ch]">
                Treat several areas at the same settings and Hone records those areas under
                one settings block. Each area still remains findable in its own history.
                When the setup changes, a new block preserves the difference.
              </Lede>
            </div>
            <TreatmentMemoryPanel />
          </Container>
        </Section>

        {/* ── 4. More than a note ──────────────────────────────────────────
            A typographic A/B. The sentence a notes field can hold, set large
            and muted, against the same treatment as fields. The comparison IS
            the layout; neither side is a card. */}
        <Section tone="warm">
          <Container>
            <Title className="max-w-[12ch]">More than a note</Title>
            <div className="mt-[clamp(1.75rem,3vw,3rem)] grid gap-[clamp(2rem,4vw,4rem)] lg:grid-cols-[0.9fr_1.1fr] lg:items-start">
              <div>
                <p className="text-[0.9375rem] font-medium text-muted">A note can say</p>
                <p className="mt-3 border-l border-[color:var(--color-hairline-strong)] pl-5 text-[clamp(1.375rem,1.1rem+1vw,1.75rem)] leading-[1.35] text-muted">
                  &ldquo;Upper lip treated, tolerated well.&rdquo;
                </p>
                <Lede className="mt-6 max-w-[42ch]">
                  Hone records the treatment as fields, not a paragraph: the areas treated,
                  the machine settings, probe and lot, how each area was tolerated, and what
                  to remember next time. Because they&apos;re fields rather than prose, each
                  area stays findable on its own and Hone can tell you when one is missing.
                </Lede>
                <Link
                  href="/features/charting-records"
                  data-event={ANALYTICS_EVENTS.featureCtaClick}
                  className="mt-3 inline-flex min-h-11 items-center text-[0.9375rem] font-medium text-mineral underline underline-offset-4"
                >
                  See every field Hone records
                </Link>
              </div>
              <SessionRecordPreview />
            </div>
          </Container>
        </Section>

        {/* ── 5. The connected workflow ────────────────────────────────────
            The heading runs across the top in two sentences, so it no longer
            stands five lines tall in a narrow column. Under it, the calendar
            and the ordered steps sit side by side at the same height: the steps
            carry no fixed title height and the calendar keeps its natural size.
            On a phone and a tablet the steps stand alone; the calendar is a
            desktop composition. */}
        <Section tone="paper" id="how-hone-works">
          <Container>
            <Title className="max-w-[24ch] lg:max-w-none">
              {/* The trailing space keeps the heading's TEXT one sentence apart
                  ("appointment. Hone") for assistive tech, copy and search; it
                  collapses visually at the line end. */}
              {workflowHeading.map((sentence) => (
                <span key={sentence} className="lg:block">
                  {`${sentence} `}
                </span>
              ))}
            </Title>
            <Lede className="mt-4 max-w-[60ch]">
              One calm workflow, start to finish. Booking, intake, consent, treatment,
              follow-up, payment and the client portal share one record.
            </Lede>
            <div className="mt-[clamp(1.75rem,3vw,3rem)] grid items-start gap-[clamp(2rem,4vw,4rem)] lg:grid-cols-[minmax(18rem,0.75fr)_minmax(0,1.6fr)]">
              <div className="hidden lg:block">
                <CalendarPreview />
              </div>
              <WorkflowGrid steps={WORKFLOW_STEPS} />
            </div>
          </Container>
        </Section>

        {/* ── 6. Know what was used, and when ──────────────────────────────
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
              className="mt-5 inline-flex min-h-11 items-center text-[0.9375rem] font-medium text-[color:var(--color-wash)] underline underline-offset-4"
            >
              More on records and logs
            </Link>
          </Container>
        </Section>

        {/* ── 7. Your client records should stay yours ─────────────────────
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
              <Link href="/privacy" className="font-medium text-mineral underline underline-offset-4">
                privacy policy
              </Link>{" "}
              for the full detail.
            </p>
          </Container>
        </Section>

        {/* ── 8. Simple plans, in Canadian dollars ─────────────────────────
            Three columns sharing ONE top rule and one baseline, divided by
            hairlines. A price list, not three cards competing for a click. */}
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
                      {plan.priceLabel ?? "Talk to us"}
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

            <p className="mt-5 text-[0.9375rem] text-muted">{POSITIONING.assuranceLine}</p>
            {/* An outline, not a second filled button: the filled button is the
                walkthrough request, and the closing band right below carries it. */}
            <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3">
              <CTAButton
                href="/pricing"
                variant="outline"
                event={ANALYTICS_EVENTS.pricingPlanViewed}
                className="max-sm:w-full"
              >
                See pricing details
              </CTAButton>
              <CTAButton
                href={WALKTHROUGH.href}
                variant="secondary"
                event={ANALYTICS_EVENTS.primaryCtaClick}
              >
                {WALKTHROUGH.primaryLabel}
              </CTAButton>
            </div>
          </Container>
        </Section>

        {/* ── 9. Walkthrough CTA ───────────────────────────────────────────
            The film's closing card, reused as the label above the heading, so
            the page ends on the same words the film ends on. */}
        <Section tone="band">
          <Container className="text-center">
            <Eyebrow onBand>{POSITIONING.filmClosingLine}</Eyebrow>
            <Title className="mx-auto mt-3 max-w-[18ch] text-paper">
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
