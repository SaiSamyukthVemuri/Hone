import type { Metadata } from "next";
import { SafeAnalytics } from "../_components/SafeAnalytics";
import { SiteHeader } from "../_components/marketing/SiteHeader";
import { SkipLink } from "@/app/_components/marketing/SkipLink";
import { SiteFooter } from "../_components/marketing/SiteFooter";
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
} from "../_components/marketing/primitives";
import { Breadcrumbs } from "../_components/marketing/JsonLd";
import { ProductFilm } from "../_components/marketing/ProductFilm";
import { DemoForm } from "../_components/DemoForm";
import { ANALYTICS_EVENTS, WALKTHROUGH } from "@/lib/marketing/content";
import { marketingMetadata } from "@/lib/marketing/metadata";

// /demo, a LEAD-CAPTURE request. The visitor never selects a real appointment
// time; the founder replies within one business day to schedule. Every label
// therefore says "Request", not "Book" (addendum §3). The success state explains
// the real manual follow-up. Analytics events (form started/submitted) carry no
// PII, see DemoForm + MarketingAnalytics.
//
// MKT-02E. Structure and copy follow marketing copy deck v2.2 section 9: the
// film sits ABOVE the "What you'll see" list, with the deck's line beside it.
// MKT-03 revision 2 moves the FORM to the top: the request is in the first
// screen, and the film and the explanation below it support it.
//
// TWO DECK ITEMS ARE DELIBERATELY NOT SHIPPED, AND BOTH ARE TRUTH DECISIONS.
//
//   THE LEAD-DATA LINE IS OMITTED. The deck's line under the button is "We use
//   this to arrange your walkthrough and for nothing else", marked
//   [VERIFY against the privacy policy's stated use of lead data]. Checked: the
//   privacy policy's "prospective clients" are a STUDIO's waitlist prospects,
//   submitting through that studio's public booking page — /app/privacy names
//   them as people the studio is the controller for. It says nothing about
//   people who ask Hone for a walkthrough. So the claim has no stated basis and
//   is not written. A sentence about data use is exactly the kind that must be
//   verifiable, and this one is not yet.
//
//   THE PERSONAL GUARANTEE IS GONE. The sub read "A walkthrough is a screen share
//   with the person who built Hone." True today, but it makes the marketing
//   contract depend on one person staying available, which is not a promise a
//   public page should carry. "A live screen share" says the same thing about what
//   the visitor gets. `founder-led` survives elsewhere as POSITIONING-level
//   language about how setup and walkthroughs are run; what is removed is the
//   commitment that a specific individual will be on the call.
//
//   "NO CONTRACT" IS GONE. MKT-02D rejected the contract claim as unverified, so
//   it is not written here. Not softened to "no minimum term" either -- that is
//   the same unverified claim in weaker words. NOTE FOR THE OWNER: the claim is
//   still live on /pricing (twice), on the homepage, and in PRICING_ASSURANCES
//   ("No contract, cancel anytime"), none of which is this lane's page. The
//   rejection did not propagate.
//
//   THE 15-MINUTE PROMISE IS GONE from WALKTHROUGH.demoHeading, which is this
//   page's H1. v2.2 promises no duration anywhere; #762 removed it from every
//   constant it owned and parked this one for the /demo lane. The heading is now
//   the deck's own, and content-v22's duration guard covers the key.
//
//   THE PHONE FIELD IS OMITTED. The deck's form lists "Phone (optional)", but
//   tests/app/marketing-demo.test.ts forbids any phone field on this surface.
//   The shipped decision wins, and it is coherent with the point above: while we
//   cannot state what happens to a lead's data, collecting less of it is the
//   right side to err on.

export const metadata: Metadata = marketingMetadata("/demo");

/** Deck section 9, "What you'll see", verbatim. */
const WHAT_YOU_WILL_SEE: readonly string[] = [
  "The Before Today briefing for a returning client",
  "One client, several areas, each with its own history",
  "The treatment form, field by field",
  "Probe lot, sterile-item and expiry logging",
  "The booking page and the studio calendar",
  "Where your records live and how you export them",
];

const WHAT_HAPPENS: { step: string; body: string }[] = [
  { step: "1", body: "Tell us a little about your practice using the form." },
  { step: "2", body: "We reply by email within one business day to set up a time, there is no automatic booking." },
  { step: "3", body: "On a short call we walk through your workflow in the real app: booking, charting, treatment memory, and records." },
  { step: "4", body: "We decide together whether Hone fits your practice. If it doesn't, we'll say so." },
];

export default function DemoPage() {
  return (
    <MarketingSurface>
      <SkipLink />
      <SiteHeader />
      <Breadcrumbs
        items={[
          { name: "Home", path: "/" },
          { name: "Walkthrough", path: "/demo" },
        ]}
      />
      <main id="main-content" className="scroll-mt-16">
        {/* ── The request, first ───────────────────────────────────────────
            THE FORM IS THE PAGE'S JOB, SO IT IS IN THE FIRST SCREEN. It used
            to come after the film and three explanatory sections, about 1,200px
            down on a desktop; a visitor who arrived to ask for a walkthrough
            had to scroll past the case for one first. Now the heading and the
            form share the opening: side by side on a desktop, and on a narrow
            screen the order is heading, form, then what happens next.
            One grid, placed by row and column, so each part is rendered once
            and the reading order is the DOM order at every width. */}
        {/* `grid-rows-[auto_1fr]`: the form spans both rows, and without it the
            form's extra height was shared between them, leaving a gap under the
            introduction. The first row is the introduction's own height; the
            second takes the rest. */}
        <Container className="grid gap-x-[clamp(2.5rem,5vw,5rem)] gap-y-8 pb-[var(--mk-section-pad)] pt-[clamp(1rem,0.5rem+1.25vw,1.75rem)] lg:grid-cols-[minmax(0,1fr)_minmax(26rem,34rem)] lg:grid-rows-[auto_1fr] lg:items-start">
          <div className="lg:col-start-1 lg:row-start-1">
            <Display className="max-w-[16ch]">{WALKTHROUGH.demoHeading}</Display>
            <Lede className="mt-5 max-w-[38rem]">
              A walkthrough is a live screen share. We open a returning client and you watch
              Before Today assemble from their history, then chart a treatment together so you
              can see where the fields go.
            </Lede>
          </div>

          <section
            id="request"
            aria-labelledby="request-title"
            className="rounded-[12px] border border-[color:var(--color-hairline)] bg-white p-5 sm:p-8 lg:col-start-2 lg:row-span-2 lg:row-start-1"
          >
            <Subtitle as="h2" className="text-ink">
              <span id="request-title">Tell us about your practice</span>
            </Subtitle>
            <p className="mt-2 text-[0.9375rem] leading-[1.55] text-muted">
              We use this to tailor the walkthrough. We reply within one business day to set
              up a time.
            </p>
            <div className="mt-6">
              <DemoForm />
            </div>
          </section>

          <div className="lg:col-start-1 lg:row-start-2">
            <Subtitle as="h2">What happens next</Subtitle>
            <ol className="mt-4 space-y-3.5">
              {WHAT_HAPPENS.map((s) => (
                <li
                  key={s.step}
                  className="grid grid-cols-[1.5rem_minmax(0,1fr)] text-[1rem] leading-[1.55] text-ink"
                >
                  <span aria-hidden="true" className="font-semibold tabular-nums text-mineral">
                    {s.step}
                  </span>
                  <span>{s.body}</span>
                </li>
              ))}
            </ol>
            <p className="mt-6 max-w-md text-[0.9375rem] leading-[1.6] text-muted">
              No sales pressure. The goal is to see whether Hone actually fits your practice.
            </p>
          </div>
        </Container>

        {/* The film, now in support of the request rather than in front of it.
            ON THE BAND, BECAUSE THE PLAYER IS BUILT FOR IT. #764's ProductFilm is
            the canonical player and this page adopted it wholesale rather than
            keeping a second copy. It styles its own box `bg-band` and its caption
            `--color-onband-muted` (#9fb3ad), which is legible on near-black and
            almost invisible on paper — so the call site moves to `tone="band"`
            rather than the component growing a theme prop for one page. It stays
            MANUAL here (no `autoplay`): a lead form's visitors did not come for
            3.6 MB of video. */}
        <Section tone="band">
          <Container>
            <Lede onBand className="mb-6 max-w-[50ch]">
              This is the short version. The walkthrough is the live one.
            </Lede>
            <ProductFilm />
          </Container>
        </Section>

        <Section tone="paper">
          <Container className="grid gap-x-[clamp(2.5rem,5vw,5rem)] gap-y-10 lg:grid-cols-2">
            <div>
              <Eyebrow>What you&rsquo;ll see</Eyebrow>
              <Title className="mt-3 max-w-[22ch]">The real app, on a returning client.</Title>
              <ul className="mt-6 border-t border-[color:var(--color-hairline)]">
                {WHAT_YOU_WILL_SEE.map((item) => (
                  <li
                    key={item}
                    className="border-b border-[color:var(--color-hairline)] py-3 text-[1rem] leading-[1.5] text-ink"
                  >
                    {item}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <Eyebrow>What happens after</Eyebrow>
              <Title className="mt-3 max-w-[22ch]">If Hone fits, we set your studio up.</Title>
              <Lede className="mt-4">
                We bring your existing clients across as part of setup. Standard import is
                included. No setup fee.
              </Lede>
              <CTAButton
                href="#request"
                event={ANALYTICS_EVENTS.primaryCtaClick}
                className="mt-7 max-sm:w-full"
              >
                {WALKTHROUGH.primaryLabel}
              </CTAButton>
            </div>
          </Container>
        </Section>
      </main>
      <SiteFooter />
      <SafeAnalytics />
    </MarketingSurface>
  );
}
