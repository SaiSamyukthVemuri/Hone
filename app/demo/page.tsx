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
  Lede,
} from "../_components/marketing/primitives";
import { Reveal } from "../_components/marketing/Reveal";
import { Breadcrumbs } from "../_components/marketing/JsonLd";
import { ProductFilm } from "../_components/marketing/ProductFilm";
import { DemoForm } from "../_components/DemoForm";
import { WALKTHROUGH } from "@/lib/marketing/content";
import { marketingMetadata } from "@/lib/marketing/metadata";

// /demo, a LEAD-CAPTURE request. The visitor never selects a real appointment
// time; the founder replies within one business day to schedule. Every label
// therefore says "Request", not "Book" (addendum §3). The success state explains
// the real manual follow-up. Analytics events (form started/submitted) carry no
// PII, see DemoForm + MarketingAnalytics.
//
// MKT-02E. Structure and copy follow marketing copy deck v2.2 section 9: the
// film sits ABOVE the "What you'll see" list, with the deck's line beneath it.
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
//   THE PHONE FIELD IS OMITTED. The deck's form lists "Phone (optional)", but
//   tests/app/marketing-demo.test.ts forbids any phone field on this surface.
//   The shipped decision wins, and it is coherent with the point above: while we
//   cannot state what happens to a lead's data, collecting less of it is the
//   right side to err on.

export const metadata: Metadata = marketingMetadata("/demo");

const FILM_SRC = "/film/hone-product-overview-v3-1.mp4";
const FILM_POSTER = "/film/hone-product-overview-v3-1-poster.png";

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
      <main id="main-content" className="scroll-mt-16 overflow-x-hidden">
        <Container className="pb-12 pt-8 lg:pt-10">
          <Reveal immediate>
            <Eyebrow>Walkthrough</Eyebrow>
            <Display className="mt-4 max-w-3xl">{WALKTHROUGH.demoHeading}</Display>
            <Lede className="mt-6 max-w-2xl">
              A walkthrough is a screen share with the person who built Hone. We open a
              returning client and you watch Before Today assemble from their history, then
              chart a treatment together so you can see where the fields go.
            </Lede>
          </Reveal>
        </Container>

        {/* The film sits above the list, per deck section 9. */}
        <Container className="pb-4">
          <Reveal>
            <div className="max-w-3xl">
              <ProductFilm
                src={FILM_SRC}
                poster={FILM_POSTER}
                label="A short walkthrough of Hone, recorded on a demonstration studio."
              />
              <p className="mt-3 text-[0.875rem] leading-[1.6] text-muted">
                This is the short version. The walkthrough is the live one.
              </p>
            </div>
          </Reveal>
        </Container>

        <Section tone="warm">
          <Container size="wide">
            <Eyebrow>What you&rsquo;ll see</Eyebrow>
            <Title className="mt-4 max-w-2xl">The real app, on a returning client.</Title>
            <ul className="mt-8 grid gap-x-10 gap-y-4 sm:grid-cols-2">
              {WHAT_YOU_WILL_SEE.map((item) => (
                <li
                  key={item}
                  className="flex items-start gap-3 text-[0.9375rem] leading-[1.55] text-ink"
                >
                  <span aria-hidden="true" className="mt-[0.45rem] h-1.5 w-1.5 shrink-0 rounded-full bg-mineral" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </Container>
        </Section>

        <Section tone="paper">
          <Container size="prose">
            <Reveal>
              <Eyebrow>What happens after</Eyebrow>
              <Title className="mt-4">If Hone fits, we set your studio up.</Title>
              <Lede className="mt-5">
                If Hone fits, we set up your studio and bring your existing clients across.
                Standard import is included. No setup fee. No contract.
              </Lede>
            </Reveal>
          </Container>
        </Section>

        <Container className="grid gap-12 pb-20 pt-12 lg:grid-cols-[1fr_1fr] lg:gap-16">
          <Reveal>
            <p className="text-[0.75rem] font-semibold uppercase tracking-[0.14em] text-mineral">
              What happens next
            </p>
            <ol className="mt-5 space-y-4">
              {WHAT_HAPPENS.map((s) => (
                <li
                  key={s.step}
                  className="flex items-start gap-4 text-[0.9375rem] leading-[1.55] text-ink"
                >
                  <span aria-hidden="true" className="text-[0.9375rem] font-semibold text-mineral">
                    {s.step}
                  </span>
                  <span>{s.body}</span>
                </li>
              ))}
            </ol>
            <p className="mt-8 max-w-md text-[0.875rem] leading-[1.6] text-muted">
              No sales pressure. The goal is to see whether Hone actually fits your practice.
            </p>
          </Reveal>

          <Reveal delay={80}>
            <div className="rounded-[12px] border border-[color:var(--color-hairline)] bg-white p-6 sm:p-8">
              <p className="text-[0.75rem] font-semibold uppercase tracking-[0.14em] text-muted">
                Tell us about your practice
              </p>
              <p className="mt-2 text-[0.875rem] leading-[1.55] text-muted">
                We use this to tailor the walkthrough. We reply within one business day to set
                up a time.
              </p>
              <div className="mt-7">
                <DemoForm />
              </div>
            </div>
          </Reveal>
        </Container>
      </main>
      <SiteFooter />
      <SafeAnalytics />
    </MarketingSurface>
  );
}
