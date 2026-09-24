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
  Hairline,
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
  TRUST_STRIP,
  FILM,
  PRICING_PLANS,
  PRICING_ASSURANCES,
  PAYMENT_QUALIFIER,
  ANALYTICS_EVENTS,
} from "@/lib/marketing/content";
import { marketingMetadata } from "@/lib/marketing/metadata";

// Public marketing homepage — copy deck v2.2 §3, the film release (MKT-02B).
//
// WHAT CHANGED, AND WHY IT IS A RESTRUCTURE RATHER THAN A RESKIN.
// The previous homepage argued the case in prose: a calendar-vs-Hone band, a
// six-step how-it-works, a capability matrix, a trust grid. It was a good
// argument and it was all assertion. The film is a DEMONSTRATION of the same
// claim, so the page now leads with it and the prose steps aside — section 1
// drops to two sentences because the 25 seconds underneath carry the proof the
// paragraphs were carrying.
//
// EDITORIAL PACING, NOT A STACK OF EQUAL CARDS. Each block gets the structure
// its content actually wants, and the tones alternate so the page has a rhythm:
//
//   hero        paper   type only, no visual — the film is 300px below it
//   1 film      BAND    the one full-width cinema moment
//   2 trust     paper   a thin ruled strip, deliberately not a section
//   3 areas     paper   editorial split, product panel right
//   4 note      warm    a typographic A/B — the sentence against the fields
//   5 workflow  paper   editorial split + the shared numbered grid
//   6 records   BAND    four lines, no image, after three image blocks
//   7 yours     paper   the shared ruled matrix
//   8 pricing   warm    ruled columns sharing one rule, not three floating cards
//   9 CTA       BAND    centred, the film's own closing line as the eyebrow
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
  "Edits kept as history, not written over.",
  "Record gaps flagged: a missing probe lot, aftercare not marked, a completed appointment not yet charted.",
];

// Deck §3.7. The export line resolves the deck's [VERIFY] the only way it can
// be resolved honestly: by naming the subset. TRUTH-01A established that the
// export is clients, sessions, charting, appointments, plans, clinical notes
// and record-keeping logs — NOT photos, intake forms, signed consents, the
// service menu or payment records. lib/export/resource-registry.ts is the
// authority. "Full studio history" was the claim that had to go.
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
    title: "No contract. Cancel anytime.",
    body: "The person who built Hone answers support, and your records leave with you.",
  },
];

export default function HomePage() {
  return (
    <MarketingSurface>
      <SkipLink />
      <SiteHeader />
      <main id="main-content" className="scroll-mt-16 overflow-x-hidden">
        {/* ── Hero ─────────────────────────────────────────────────────────
            Type only. The old hero put a product panel beside the H1, which
            meant the first product thing a visitor saw was a drawing. It is
            now the film, one scroll down, at full width. */}
        <Container className="pb-[clamp(4rem,7vw,7rem)] pt-[clamp(3.5rem,6vw,6rem)]">
          <Eyebrow>{POSITIONING.heroEyebrow}</Eyebrow>
          <Display className="mt-5 max-w-[19ch]">{POSITIONING.heroH1}</Display>
          <Lede className="mt-7 max-w-[46ch]">{POSITIONING.heroSupporting}</Lede>
          <div className="mt-9 flex flex-wrap items-center gap-x-6 gap-y-3">
            <CTAButton href={WALKTHROUGH.href} event={ANALYTICS_EVENTS.primaryCtaClick}>
              {WALKTHROUGH.primaryLabel}
            </CTAButton>
            <CTAButton
              href="/features/treatment-memory"
              variant="secondary"
              event={ANALYTICS_EVENTS.featureCtaClick}
            >
              See how treatment memory works
            </CTAButton>
          </div>
          <Hairline className="mt-[clamp(3rem,5vw,4.5rem)]" />
          <p className="mt-4 text-[0.8125rem] leading-[1.6] text-muted">
            {POSITIONING.proofLine}
          </p>
        </Container>

        {/* ── 1. Before the client sits down ───────────────────────────────
            The one cinema moment. Two sentences, then 25 seconds at full
            width on near-black, so the film is the section rather than an
            illustration inside it. */}
        <Section tone="band" className="!py-[clamp(4.5rem,7vw,8rem)]">
          <Container>
            <Eyebrow onBand>{POSITIONING.keepPhrase}</Eyebrow>
            <Title className="mt-5 max-w-[16ch] text-paper">
              Before the client sits down
            </Title>
            <Lede onBand className="mt-6 max-w-[50ch]">
              Last treatment shouldn&apos;t be buried in a note. Hone brings forward what
              happened last time, area by area.
            </Lede>
            <ProductFilm className="mt-[clamp(2.5rem,4vw,4rem)]" />
          </Container>
        </Section>

        {/* ── 2. Trust strip ───────────────────────────────────────────────
            Not a Section and not four cards: one ruled row, the width of the
            shell, that a visitor reads in a single pass on the way down. */}
        <Container className="py-[clamp(1.75rem,2.5vw,2.5rem)]">
          <ul className="grid grid-cols-1 divide-y divide-[color:var(--color-hairline)] border-y border-[color:var(--color-hairline)] sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4">
            {TRUST_STRIP.map((line) => (
              <li
                key={line}
                className="py-3.5 text-[0.875rem] leading-[1.45] text-muted sm:border-b sm:border-[color:var(--color-hairline)] sm:pr-6 lg:border-b-0 lg:[&:not(:first-child)]:border-l lg:[&:not(:first-child)]:border-[color:var(--color-hairline)] lg:[&:not(:first-child)]:pl-6"
              >
                {line}
              </li>
            ))}
          </ul>
        </Container>

        {/* ── 3. Every area keeps its own history ─────────────────────────── */}
        <Section tone="paper" className="!py-[clamp(4.5rem,7vw,8rem)]">
          <Container className="grid items-center gap-[clamp(2.5rem,5vw,5rem)] lg:grid-cols-[1.02fr_0.98fr]">
            <div>
              <Title className="max-w-[15ch]">Every area keeps its own history</Title>
              <p className="mt-6 max-w-[38ch] text-[1.25rem] leading-[1.4] text-ink">
                Upper lip, chin, neck and brows don&apos;t share one note.
              </p>
              <Lede className="mt-5 max-w-[46ch]">
                A four-area appointment is recorded as four treatments, each attached to its
                area. Come back for the chin and you see the chin: last settings, last
                response, last note.
              </Lede>
            </div>
            <TreatmentMemoryPanel />
          </Container>
        </Section>

        {/* ── 4. More than a note ──────────────────────────────────────────
            A typographic A/B. The sentence a notes field can hold, set large
            and muted, against the same treatment as fields. The comparison IS
            the layout; neither side is a card. */}
        <Section tone="warm" className="!py-[clamp(4.5rem,7vw,8rem)]">
          <Container>
            <Title className="max-w-[12ch]">More than a note</Title>
            <div className="mt-[clamp(2.5rem,4vw,3.5rem)] grid gap-[clamp(2.5rem,5vw,4.5rem)] lg:grid-cols-[0.9fr_1.1fr] lg:items-start">
              <div>
                <p className="text-[0.75rem] font-semibold uppercase tracking-[0.14em] text-muted">
                  A note can say
                </p>
                <p className="mt-4 border-l border-[color:var(--color-hairline-strong)] pl-5 text-[clamp(1.375rem,1.1rem+1vw,1.75rem)] leading-[1.35] text-muted">
                  &ldquo;Upper lip treated, tolerated well.&rdquo;
                </p>
                <Lede className="mt-8 max-w-[42ch]">
                  Hone records the treatment as fields, not a paragraph: area, settings, probe
                  and lot, tolerance, response and what to remember next time. Because
                  they&apos;re fields, each area&apos;s history stays separate, comes forward
                  on its own, and Hone can tell you when one is missing.
                </Lede>
                <Link
                  href="/features/charting-records"
                  data-event={ANALYTICS_EVENTS.featureCtaClick}
                  className="mt-6 inline-block text-[0.9375rem] font-medium text-mineral underline underline-offset-4"
                >
                  See every field →
                </Link>
              </div>
              <SessionRecordPreview />
            </div>
          </Container>
        </Section>

        {/* ── 5. The connected workflow ────────────────────────────────────
            The editorial split the desktop system defines: a narrow intro
            column, the shared numbered grid beside it. */}
        <Section tone="paper" className="!py-[clamp(4.5rem,7vw,8rem)]" id="how-hone-works">
          <Container>
            <div className="grid gap-10 lg:grid-cols-[minmax(17rem,0.72fr)_minmax(0,1.28fr)] lg:items-start lg:gap-[clamp(4rem,6vw,6.5rem)]">
              <div>
                <Title className="max-w-[18ch]">{POSITIONING.differentiationLine}</Title>
                <Lede className="mt-6 max-w-[30rem]">
                  One calm workflow, start to finish. Booking, intake, consent, treatment,
                  follow-up, payment and the client portal share one record.
                </Lede>
                <div className="mt-9 hidden lg:block">
                  <CalendarPreview />
                </div>
              </div>
              <WorkflowGrid steps={WORKFLOW_STEPS} />
            </div>
          </Container>
        </Section>

        {/* ── 6. Know what was used, and when ──────────────────────────────
            The band with nothing to look at. Four lines, large, ruled. */}
        <Section tone="band" className="!py-[clamp(4.5rem,7vw,8rem)]">
          <Container>
            <div className="grid gap-[clamp(2rem,4vw,4rem)] lg:grid-cols-[0.8fr_1.2fr] lg:items-start">
              <Title className="max-w-[14ch] text-paper">Know what was used, and when</Title>
              <ul className="border-t border-white/15">
                {RECORD_LINES.map((line) => (
                  <li
                    key={line}
                    className="border-b border-white/15 py-5 text-[clamp(1.0625rem,1rem+0.4vw,1.25rem)] leading-[1.45] text-paper"
                  >
                    {line}
                  </li>
                ))}
              </ul>
            </div>
            <Link
              href="/features/charting-records"
              data-event={ANALYTICS_EVENTS.featureCtaClick}
              className="mt-8 inline-block text-[0.9375rem] font-medium text-[color:var(--color-wash)] underline underline-offset-4"
            >
              More on records →
            </Link>
          </Container>
        </Section>

        {/* ── 7. Your client records should stay yours ─────────────────────
            The shared ruled matrix — a designed table, not six floating
            cards. No badges, no hosting-location line. */}
        <Section tone="paper" className="!py-[clamp(4.5rem,7vw,8rem)]">
          <Container>
            <Title className="max-w-[18ch]">Your client records should stay yours.</Title>
            <FeatureMatrix
              items={OWNERSHIP.map((o) => ({ title: o.title, body: o.body }))}
            />
            <p className="mt-8 text-[0.9375rem] text-muted">
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
        <Section tone="warm" id="pricing" className="!py-[clamp(4.5rem,7vw,8rem)]">
          <Container>
            <Title className="max-w-[20ch]">Simple plans, in Canadian dollars.</Title>
            <Lede className="mt-6 max-w-[48ch]">
              Every plan includes the full treatment workflow. No client caps. No appointment
              caps.
            </Lede>
            <p className="mt-4 max-w-[52ch] text-[0.9375rem] leading-[1.6] text-muted">
              Treatment memory, charting, intake, consent, photos, follow-up, payments, a
              client portal and CSV export. On every plan.
            </p>

            <div className="mt-[clamp(2.5rem,4vw,3.5rem)] grid grid-cols-1 border-t border-[color:var(--color-hairline-strong)] sm:grid-cols-3">
              {PRICING_PLANS.map((plan) => (
                <div
                  key={plan.id}
                  className="flex flex-col border-b border-[color:var(--color-hairline)] py-7 sm:px-7 sm:[&:first-child]:pl-0 sm:[&:last-child]:pr-0 sm:[&:not(:first-child)]:border-l sm:[&:not(:first-child)]:border-[color:var(--color-hairline)]"
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
                    <p className="mt-1 text-[0.8125rem] text-muted">For {plan.seats}</p>
                  ) : null}
                  <p className="mt-3 text-[0.9375rem] leading-[1.55] text-muted">
                    {plan.bestFor}
                  </p>
                </div>
              ))}
            </div>

            <p className="mt-6 text-[0.875rem] text-muted">
              {PRICING_ASSURANCES.join(" · ")}
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
              <CTAButton href="/pricing" event={ANALYTICS_EVENTS.pricingPlanViewed}>
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
            The film's closing card, reused as the eyebrow, so the page ends
            on the same words the film ends on. */}
        <Section tone="band" className="!py-[clamp(5rem,8vw,9rem)]">
          <Container className="text-center">
            <Eyebrow onBand>{FILM.closingLine}</Eyebrow>
            <Title className="mx-auto mt-5 max-w-[18ch] text-paper">
              See it with a returning client.
            </Title>
            <Lede onBand className="mx-auto mt-6 max-w-[52ch]">
              In a walkthrough, we open a returning client and you watch Before Today assemble
              from their history. If Hone fits, we set up your studio and bring your existing
              clients across.
            </Lede>
            <div className="mt-9 flex justify-center">
              <CTAButton href={WALKTHROUGH.href} event={ANALYTICS_EVENTS.primaryCtaClick}>
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
