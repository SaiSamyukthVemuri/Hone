import type { Metadata } from "next";
import { SafeAnalytics } from "../_components/SafeAnalytics";
import { SiteHeader } from "../_components/marketing/SiteHeader";
import { SiteFooter } from "../_components/marketing/SiteFooter";
import {
  MarketingSurface,
  Container,
  Eyebrow,
  Display,
  Lede,
} from "../_components/marketing/primitives";
import { Reveal } from "../_components/marketing/Reveal";
import { Breadcrumbs } from "../_components/marketing/JsonLd";
import { DemoForm } from "../_components/DemoForm";
import { WALKTHROUGH } from "@/lib/marketing/content";
import { marketingMetadata } from "@/lib/marketing/metadata";

// /demo, a LEAD-CAPTURE request. The visitor never selects a real appointment
// time; the founder replies within one business day to schedule. Every label
// therefore says "Request", not "Book" (addendum §3). The success state explains
// the real manual follow-up. Analytics events (form started/submitted) carry no
// PII, see DemoForm + MarketingAnalytics.

export const metadata: Metadata = marketingMetadata("/demo");

const WHAT_HAPPENS: { step: string; body: string }[] = [
  { step: "1", body: "Tell us a little about your practice using the form." },
  { step: "2", body: "We reply by email within one business day to set up a time, there is no automatic booking." },
  { step: "3", body: "On a short call we walk through your workflow in the real app: booking, charting, treatment memory, and records." },
  { step: "4", body: "We decide together whether Hone fits your practice. If it doesn't, we'll say so." },
];

export default function DemoPage() {
  return (
    <MarketingSurface>
      <SiteHeader />
      <Breadcrumbs
        items={[
          { name: "Home", path: "/" },
          { name: "Walkthrough", path: "/demo" },
        ]}
      />
      <main className="overflow-x-hidden">
        <Container className="grid gap-12 pb-20 pt-8 lg:grid-cols-[1fr_1fr] lg:gap-16 lg:pt-10">
          <Reveal immediate>
            <Eyebrow>Walkthrough</Eyebrow>
            <Display className="mt-4">{WALKTHROUGH.demoHeading}</Display>
            <Lede className="mt-6 max-w-xl">
              A short, founder-led walkthrough of the real app, no slides, no recorded demo.
              Bring one or two of your typical client scenarios so we can walk through them
              together.
            </Lede>

            <div className="mt-10">
              <p className="text-[0.75rem] font-semibold uppercase tracking-[0.14em] text-mineral">
                What happens next
              </p>
              <ol className="mt-5 space-y-4">
                {WHAT_HAPPENS.map((s) => (
                  <li key={s.step} className="flex items-start gap-4 text-[0.9375rem] leading-[1.55] text-ink">
                    <span aria-hidden="true" className="text-[0.9375rem] font-semibold text-mineral">
                      {s.step}
                    </span>
                    <span>{s.body}</span>
                  </li>
                ))}
              </ol>
            </div>

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
