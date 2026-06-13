import Link from "next/link";
import { Reveal } from "./_components/Reveal";
import { MarketingHeader } from "./_components/MarketingHeader";
import { MarketingFooter } from "./_components/MarketingFooter";
import { SafeAnalytics } from "./_components/SafeAnalytics";
import { EyebrowCaption } from "./_components/MarketingAtoms";
import { MARKETING_PALETTE as PALETTE } from "./_components/marketingNav";

// Public marketing homepage. PR #242 repositioned the site around
// treatment memory; PR #243 tightens it to a YC-style landing page:
// say what it is, who it is for, the pain, the product solving it,
// one primary CTA, fewer sections, less repetition. Eight sections:
// Hero, Problem/comparison, How Hone works, Product proof, Record
// keeping, Agentic support (support + safety merged), Privacy/trust,
// Pricing/CTA. One hero visual; product proof uses compact cards
// instead of a full section per surface. All visuals are coded
// mockups with anonymized demo data only (Maya R. / Demo Studio /
// lot L-204 / Sterex), never real clients. Copy stays inside the
// docs/22 safety boundary (assistant not decider, draft not send,
// flag not diagnose) with no medical, compliance, or AI overclaims.
export default function HomePage() {
  return (
    <main
      style={{
        backgroundColor: PALETTE.bg,
        color: PALETTE.ink,
        fontFeatureSettings: '"cv11"',
      }}
      className="min-h-screen overflow-x-hidden font-[var(--font-inter)]"
    >
      <MarketingHeader />
      <Hero />
      <ProblemSection />
      <HowHoneWorks />
      <ProductProof />
      <RecordKeepingSection />
      <AgenticSection />
      <TrustSection />
      <PricingCTA />
      <MarketingFooter />
      {/* PR #142. Safe marketing page (no token in URL). */}
      <SafeAnalytics />
    </main>
  );
}

/* Shared section + visual atoms ────────────────────────────────────────── */

function SectionShell({
  id,
  children,
  className = "",
}: {
  id?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Reveal
      as="section"
      id={id}
      className={`scroll-mt-24 px-6 py-18 md:px-12 md:py-24 lg:px-16 ${className}`}
    >
      <div className="mx-auto max-w-[1400px]">{children}</div>
    </Reveal>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2
      className="font-[var(--font-fraunces)] mt-8 max-w-[860px] text-[30px] font-bold leading-[1.05] md:text-[42px]"
      style={{ letterSpacing: "-0.03em" }}
    >
      {children}
    </h2>
  );
}

function Chip({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "blue" | "amber" | "green";
}) {
  const tones = {
    neutral: { bg: PALETTE.chip, border: PALETTE.rule, ink: PALETTE.ink },
    blue: { bg: PALETTE.blueBg, border: PALETTE.blueRule, ink: PALETTE.blueInk },
    amber: {
      bg: PALETTE.amberBg,
      border: PALETTE.amberRule,
      ink: PALETTE.amberInk,
    },
    green: {
      bg: PALETTE.greenBg,
      border: PALETTE.greenRule,
      ink: PALETTE.greenInk,
    },
  }[tone];
  return (
    <span
      className="inline-flex items-center rounded-full border px-2.5 py-1 text-[12px] leading-none"
      style={{
        backgroundColor: tones.bg,
        borderColor: tones.border,
        color: tones.ink,
      }}
    >
      {children}
    </span>
  );
}

function MockCard({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-xl p-5 ${className}`}
      style={{
        backgroundColor: PALETTE.card,
        border: `1px solid ${PALETTE.rule}`,
        boxShadow: "0 1px 2px rgba(10,10,10,0.04), 0 8px 24px rgba(10,10,10,0.05)",
      }}
    >
      {children}
    </div>
  );
}

function MockLabel({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="text-[10px] font-medium uppercase"
      style={{ letterSpacing: "0.16em", color: PALETTE.muted }}
    >
      {children}
    </p>
  );
}

function RememberBand({ children }: { children: React.ReactNode }) {
  // Echoes the app's blue treatment-memory band.
  return (
    <div
      className="rounded-md px-3.5 py-3"
      style={{
        backgroundColor: PALETTE.blueBg,
        border: `1px solid ${PALETTE.blueRule}`,
      }}
    >
      <p
        className="text-[10px] font-semibold uppercase"
        style={{ letterSpacing: "0.16em", color: PALETTE.blueInk }}
      >
        Remember today
      </p>
      <div className="mt-1.5 text-[13px]" style={{ color: PALETTE.blueInk }}>
        {children}
      </div>
    </div>
  );
}

function DemoTag() {
  return (
    <p className="mt-3 text-[11px]" style={{ color: PALETTE.muted }}>
      Product preview with demo data. No real client data.
    </p>
  );
}

/* Section 1: Hero ──────────────────────────────────────────────────────── */

function Hero() {
  return (
    <Reveal as="section" className="px-6 pb-16 pt-14 md:px-12 md:pb-20 md:pt-18 lg:px-16">
      <div className="mx-auto grid max-w-[1400px] grid-cols-1 gap-x-14 gap-y-12 lg:grid-cols-12">
        <div className="lg:col-span-6">
          <EyebrowCaption>
            Treatment memory for permanent hair removal studios
          </EyebrowCaption>

          <h1
            className="font-[var(--font-fraunces)] mt-8 max-w-[760px] text-[44px] font-bold leading-[0.98] md:text-[64px]"
            style={{ letterSpacing: "-0.04em" }}
          >
            Treatment memory for permanent hair removal studios.
          </h1>

          <p
            className="mt-8 max-w-[560px] text-[18px] leading-[1.5] md:text-[21px]"
            style={{ color: PALETTE.ink }}
          >
            Hone helps electrologists see what happened last time, chart what
            matters today, and keep procedure records clean.
          </p>

          <p
            className="mt-5 max-w-[560px] text-[16px] leading-[1.55]"
            style={{ color: PALETTE.muted }}
          >
            Your calendar tells you who is coming. Hone tells you what to
            remember.
          </p>

          <div className="mt-9 flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-5">
            <PrimaryCta href="/demo">Book a walkthrough</PrimaryCta>
            <SecondaryCta href="#product">See how it works</SecondaryCta>
          </div>

          <p className="mt-7 text-[13px]" style={{ color: PALETTE.muted }}>
            Built for practitioner-controlled workflows. No autonomous treatment
            decisions.
          </p>
        </div>

        <div className="lg:col-span-6">
          <HeroVisual />
        </div>
      </div>
    </Reveal>
  );
}

// One hero card: a Today appointment, the Before Today memory, a
// record reminder, and the Daily Prep Brief in a single readable view.
function HeroVisual() {
  return (
    <div className="flex flex-col">
      <MockCard>
        <div className="flex items-center justify-between">
          <MockLabel>Today · Demo Studio</MockLabel>
          <span className="text-[11px]" style={{ color: PALETTE.muted }}>
            Daily prep brief · 3 to review
          </span>
        </div>
        <div className="mt-3 flex items-baseline justify-between gap-3">
          <p className="text-[15px] font-medium">Maya R.</p>
          <span className="text-[12px] tabular-nums" style={{ color: PALETTE.muted }}>
            10:00 AM
          </span>
        </div>
        <p className="mt-0.5 text-[12px]" style={{ color: PALETTE.muted }}>
          Returning client · Electrolysis
        </p>
        <div className="mt-3">
          <RememberBand>
            For next visit: review upper lip sensitivity note.
          </RememberBand>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <Chip>Upper lip</Chip>
          <Chip>Sterex probe</Chip>
          <Chip>Lot L-204</Chip>
          <Chip tone="green">Tolerance 4/5</Chip>
          <Chip>Mild redness</Chip>
        </div>
        <div className="mt-3">
          <Chip tone="amber">Aftercare not marked last session</Chip>
        </div>
      </MockCard>
      <DemoTag />
    </div>
  );
}

/* Section 2: Problem / comparison ──────────────────────────────────────── */

function ProblemSection() {
  return (
    <SectionShell>
      <EyebrowCaption>The gap</EyebrowCaption>
      <SectionTitle>Your calendar does not remember the treatment.</SectionTitle>

      <div className="mt-10 grid grid-cols-1 gap-6 md:grid-cols-2">
        <MockCard>
          <MockLabel>Calendar-only</MockLabel>
          <ul className="mt-4 flex flex-col gap-3 text-[15px]">
            {["client", "time", "service"].map((row) => (
              <li
                key={row}
                className="border-b pb-3 capitalize"
                style={{ borderColor: PALETTE.rule }}
              >
                {row}
              </li>
            ))}
          </ul>
        </MockCard>
        <MockCard>
          <MockLabel>Hone</MockLabel>
          <ul className="mt-4 flex flex-col gap-3 text-[15px]">
            {[
              "last area",
              "probe and lot",
              "tolerance and reaction",
              "caution note",
              "next-session note",
              "record reminders",
            ].map((row) => (
              <li
                key={row}
                className="border-b pb-3"
                style={{ borderColor: PALETTE.rule }}
              >
                {row}
              </li>
            ))}
          </ul>
        </MockCard>
      </div>
    </SectionShell>
  );
}

/* Section 3: How Hone works (before / during / after) ──────────────────── */

const WORKFLOW: ReadonlyArray<{
  kicker: string;
  title: string;
  items: string[];
}> = [
  {
    kicker: "Before",
    title: "Review the memory.",
    items: ["Daily Prep Brief", "Before Today", "intake status", "last treatment context"],
  },
  {
    kicker: "During",
    title: "Chart the details.",
    items: ["area", "probe and lot", "tolerance and reaction", "caution", "aftercare"],
  },
  {
    kicker: "After",
    title: "Keep the record.",
    items: ["procedure records", "lot traceability", "audit history", "print and export"],
  },
];

function HowHoneWorks() {
  return (
    <SectionShell>
      <EyebrowCaption>How it works</EyebrowCaption>
      <SectionTitle>How Hone fits into the treatment day.</SectionTitle>
      <div className="mt-10 grid grid-cols-1 gap-6 md:grid-cols-3">
        {WORKFLOW.map((card) => (
          <MockCard key={card.kicker} className="flex flex-col">
            <p
              className="text-[11px] font-medium uppercase"
              style={{ letterSpacing: "0.2em", color: PALETTE.muted }}
            >
              {card.kicker}
            </p>
            <h3 className="font-[var(--font-fraunces)] mt-3 text-[20px] font-normal leading-[1.25]">
              {card.title}
            </h3>
            <div className="mt-4 flex flex-wrap gap-1.5">
              {card.items.map((i) => (
                <Chip key={i}>{i}</Chip>
              ))}
            </div>
          </MockCard>
        ))}
      </div>
    </SectionShell>
  );
}

/* Section 4: Product proof ─────────────────────────────────────────────── */

function ProductProof() {
  return (
    <SectionShell id="product">
      <EyebrowCaption>Product</EyebrowCaption>
      <SectionTitle>
        Built around the details electrologists actually need.
      </SectionTitle>

      <div className="mt-10 grid grid-cols-1 gap-6 md:grid-cols-2">
        {/* Before Today */}
        <MockCard className="flex flex-col">
          <MockLabel>Before Today</MockLabel>
          <p className="mt-2 text-[15px] leading-[1.5]">
            Before the client sits down, Hone shows the last treatment, caution
            notes, and what to record today.
          </p>
          <div className="mt-4">
            <RememberBand>
              <p>
                <span className="font-medium">Watch:</span> sensitive on upper
                lip.
              </p>
              <p className="mt-1">
                <span className="font-medium">For next visit:</span> shorter
                passes.
              </p>
            </RememberBand>
          </div>
        </MockCard>

        {/* Charting */}
        <MockCard className="flex flex-col">
          <MockLabel>Charting</MockLabel>
          <p className="mt-2 text-[15px] leading-[1.5]">
            Chart the area, probe, lot, tolerance, reaction, and next-session
            note once. Hone brings it back next time.
          </p>
          <div className="mt-4 flex flex-col gap-2 text-[14px]">
            <ChartRow label="Area" value="Upper lip" />
            <ChartRow label="Probe / lot" value="Sterex · L-204" />
            <ChartRow label="Tolerance / reaction" value="4/5 · Mild redness" />
          </div>
          <div className="mt-3">
            <Chip tone="green">Risks explained and aftercare provided</Chip>
          </div>
        </MockCard>

        {/* Procedure records */}
        <MockCard className="flex flex-col">
          <MockLabel>Procedure records</MockLabel>
          <p className="mt-2 text-[15px] leading-[1.5]">
            Pull one client&apos;s procedure record without digging through
            notebooks.
          </p>
          <div className="mt-4 flex flex-wrap gap-1.5">
            <Chip>Per-client record</Chip>
            <Chip>Lot L-204</Chip>
            <Chip>Audit history</Chip>
            <Chip>Print and export</Chip>
          </div>
        </MockCard>

        {/* Daily Prep Brief */}
        <MockCard className="flex flex-col">
          <MockLabel>Daily Prep Brief · Live</MockLabel>
          <p className="mt-2 text-[15px] leading-[1.5]">
            Daily Prep Brief surfaces today&apos;s memory, intake gaps, and
            record reminders, ordered by what needs attention. Rules-based
            today, no AI model call.
          </p>
          <div
            className="mt-4 rounded-md p-3"
            style={{ backgroundColor: PALETTE.bg, border: `1px solid ${PALETTE.rule}` }}
          >
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-[13px] font-medium">Maya R.</p>
              <span className="text-[11px] tabular-nums" style={{ color: PALETTE.muted }}>
                10:00 AM
              </span>
            </div>
            <p className="mt-1 text-[12px]" style={{ color: PALETTE.amberInk }}>
              Record reminder: aftercare not marked last session
            </p>
          </div>
        </MockCard>
      </div>
      <DemoTag />
    </SectionShell>
  );
}

function ChartRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-6">
      <span style={{ color: PALETTE.muted }}>{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}

/* Section 5: Record keeping ────────────────────────────────────────────── */

function RecordKeepingSection() {
  return (
    <SectionShell id="records">
      <EyebrowCaption>Record keeping</EyebrowCaption>
      <SectionTitle>
        Procedure records without scrambling before inspection.
      </SectionTitle>
      <p className="mt-6 max-w-[680px] text-[17px] leading-[1.6] md:text-[19px]">
        Hone keeps procedure records, sterile item logs, disinfectants, exposure
        incident reporting, audit history, and lot traceability in one place.
      </p>
      <p
        className="mt-6 max-w-[680px] text-[14px] leading-[1.6]"
        style={{ color: PALETTE.muted }}
      >
        Hone supports record keeping workflows, but studios remain responsible
        for meeting local public-health requirements.
      </p>
    </SectionShell>
  );
}

/* Section 6: Agentic support (support + safety merged) ─────────────────── */

const AGENTIC_BULLETS: ReadonlyArray<string> = [
  "Assistant, not decider",
  "Draft, not send",
  "Flag, not diagnose",
  "Summarize recorded history, do not invent",
  "Human confirmation before external actions",
];

function AgenticSection() {
  return (
    <SectionShell id="agentic">
      <EyebrowCaption>Practitioner control</EyebrowCaption>
      <SectionTitle>Agentic support, but practitioner-controlled.</SectionTitle>
      <p className="mt-6 max-w-[760px] text-[17px] leading-[1.6] md:text-[19px]">
        Hone structures treatment history first. That makes safe agentic
        workflows possible: daily prep, missing-record reminders, and draft-only
        follow-ups. Hone does not make clinical decisions, recommend treatment
        settings, send messages, charge cards, or change records without
        confirmation.
      </p>
      <div className="mt-9 grid grid-cols-1 gap-x-10 gap-y-3 md:grid-cols-2">
        {AGENTIC_BULLETS.map((b) => (
          <p
            key={b}
            className="border-b pb-3 text-[16px] leading-[1.45]"
            style={{ borderColor: PALETTE.rule }}
          >
            {b}
          </p>
        ))}
      </div>
      <p className="mt-7 text-[15px] font-medium">No autonomous clinical decisions.</p>
    </SectionShell>
  );
}

/* Section 7: Privacy / trust ───────────────────────────────────────────── */

const TRUST_POINTS: ReadonlyArray<string> = [
  "Studio data stays isolated.",
  "Records stay exportable.",
  "No advertising use of health records.",
  "No AI training on practitioner or client records.",
  "Secure sign-in.",
];

function TrustSection() {
  return (
    <SectionShell>
      <EyebrowCaption>Privacy and trust</EyebrowCaption>
      <SectionTitle>Built carefully for sensitive client records.</SectionTitle>
      <div className="mt-9 grid grid-cols-1 gap-x-12 gap-y-4 md:grid-cols-2">
        {TRUST_POINTS.map((t) => (
          <p
            key={t}
            className="border-b pb-4 text-[16px] leading-[1.45]"
            style={{ borderColor: PALETTE.rule }}
          >
            {t}
          </p>
        ))}
      </div>
      <p className="mt-8 text-[14px]" style={{ color: PALETTE.muted }}>
        Full detail in the{" "}
        <Link href="/privacy" className="underline">
          privacy policy
        </Link>
        .
      </p>
    </SectionShell>
  );
}

/* Section 8: Pricing / CTA ─────────────────────────────────────────────── */

const PRICING_CHIPS: ReadonlyArray<string> = [
  "Founder-led setup",
  "Cancel anytime",
  "Full data export",
  "Limited pilot availability",
];

function PricingCTA() {
  return (
    <SectionShell id="pricing">
      <EyebrowCaption>Founding pilot</EyebrowCaption>
      <SectionTitle>Founding pilot.</SectionTitle>

      <div
        className="mt-10 grid grid-cols-1 gap-10 p-8 md:grid-cols-12 md:p-10"
        style={{ border: `2px solid ${PALETTE.ink}` }}
      >
        <div className="md:col-span-5">
          <p
            className="font-[var(--font-fraunces)] text-[56px] font-bold leading-none"
            style={{ letterSpacing: "-0.03em" }}
          >
            $19
            <span
              className="ml-2 align-baseline text-[18px] font-normal"
              style={{ color: PALETTE.muted, letterSpacing: 0 }}
            >
              /month
            </span>
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            {PRICING_CHIPS.map((p) => (
              <Chip key={p}>{p}</Chip>
            ))}
          </div>
        </div>
        <div className="md:col-span-7">
          <p className="text-[18px] leading-[1.55] md:text-[20px]">
            Bring one real treatment workflow. We will show how Hone handles the
            appointment, charting, treatment memory, and records.
          </p>
          <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
            <PrimaryCta href="/demo">Book a 15-minute walkthrough</PrimaryCta>
            <SecondaryCta href="/pricing">See pricing</SecondaryCta>
          </div>
        </div>
      </div>
    </SectionShell>
  );
}

/* Shared CTAs ──────────────────────────────────────────────────────────── */

function PrimaryCta({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="inline-flex items-center justify-center px-7 py-3.5 text-[14px] font-medium uppercase transition-opacity hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
      style={{
        backgroundColor: PALETTE.ink,
        color: PALETTE.bg,
        letterSpacing: "0.18em",
      }}
    >
      {children}
    </Link>
  );
}

function SecondaryCta({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="inline-flex items-center justify-center px-1 py-3.5 text-[14px] font-medium uppercase hover:opacity-60 focus:outline-none focus-visible:underline"
      style={{
        color: PALETTE.ink,
        letterSpacing: "0.18em",
        borderBottom: `1px solid ${PALETTE.ink}`,
      }}
    >
      {children}
    </Link>
  );
}
