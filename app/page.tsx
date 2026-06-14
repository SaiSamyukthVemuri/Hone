import Link from "next/link";
import { Reveal } from "./_components/Reveal";
import { MarketingHeader } from "./_components/MarketingHeader";
import { MarketingFooter } from "./_components/MarketingFooter";
import { SafeAnalytics } from "./_components/SafeAnalytics";
import { EyebrowCaption } from "./_components/MarketingAtoms";
import { MARKETING_PALETTE as PALETTE } from "./_components/marketingNav";

// Public marketing homepage. PR #244 rewrites the copy in a plainer,
// human, practitioner-first voice (pilot feedback: the site read like
// an AI-generated SaaS homepage). The public category phrase is now
// "Treatment memory for electrologists." AI / agentic language is out
// of the main pitch; treatment memory and records are the lead story.
// Eight sections: Hero, Calendar vs Hone, Before/during/after, What
// Hone remembers, Records and lot traceability, Smarter prep without
// autopilot, Privacy/trust, Pricing/walkthrough. One hero visual;
// the "what it remembers" section leads with a Before Today centerpiece.
// PR #246 added a visual system for Jane-level polish without copying
// Jane: an app-window chrome frame (AppWindow) on the hero and the
// Before Today mockup so they read as real app screens; the calendar-vs-
// Hone contrast shown as two product-style cards (a plain appointment
// card vs a treatment-memory card echoing Before Today); a credible
// proof strip under the hero, a contained, edge-faded marquee ticker of
// pill-shaped signals (real signals only, nothing invented); and faint
// alternating band backgrounds (SectionShell tone="band") for section
// rhythm. PR #248 matured the page further: the calendar-vs-Hone cards
// now sit in AppWindow chrome too, the proof items are pills, the band
// tones strictly alternate, and the privacy section is a two-column
// claim-plus-compact-checklist (replacing the old awkward five-card
// 3+2 grid).
// All visuals are coded mockups with anonymized demo data only (Maya R.
// / Jordan L. / Alex P. / Demo Studio / lot L-204 / Sterex), never real
// clients. The forward-looking section keeps the docs/22 safety boundary
// in plain words (help with prep and drafts; never send, charge,
// diagnose, or change records without you), with no medical, compliance,
// or AI overclaims.
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
      <ProofStrip />
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
  tone = "default",
}: {
  id?: string;
  children: React.ReactNode;
  className?: string;
  // "band" paints a faint full-bleed warm panel behind the section so
  // the page alternates surfaces and reads with rhythm, not as one flat
  // sheet of whitespace.
  tone?: "default" | "band";
}) {
  return (
    <Reveal
      as="section"
      id={id}
      className={`scroll-mt-24 px-6 py-14 md:px-12 md:py-20 lg:px-16 ${className}`}
      style={tone === "band" ? { backgroundColor: PALETTE.band } : undefined}
    >
      <div className="mx-auto max-w-[1400px]">{children}</div>
    </Reveal>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2
      className="font-[var(--font-fraunces)] mt-5 max-w-[860px] text-[30px] font-bold leading-[1.05] md:text-[42px]"
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

// App-window chrome: wraps a mockup so it reads as a real product
// screen (traffic-light dots + a title bar) rather than a floating
// card. Same radius / border / shadow language as MockCard.
function AppWindow({
  title,
  children,
  className = "",
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`overflow-hidden rounded-xl ${className}`}
      style={{
        backgroundColor: PALETTE.card,
        border: `1px solid ${PALETTE.rule}`,
        boxShadow: "0 1px 2px rgba(10,10,10,0.04), 0 16px 40px rgba(10,10,10,0.08)",
      }}
    >
      <div
        className="flex items-center gap-2 px-4 py-2.5"
        style={{ backgroundColor: PALETTE.chrome, borderBottom: `1px solid ${PALETTE.rule}` }}
      >
        <span className="flex gap-1.5" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: PALETTE.rule }}
            />
          ))}
        </span>
        <span
          className="ml-1 text-[11px] font-medium uppercase"
          style={{ letterSpacing: "0.14em", color: PALETTE.muted }}
        >
          {title}
        </span>
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

/* Section 1: Hero ──────────────────────────────────────────────────────── */

function Hero() {
  return (
    <Reveal as="section" className="px-6 pb-16 pt-14 md:px-12 md:pb-20 md:pt-18 lg:px-16">
      <div className="mx-auto grid max-w-[1400px] grid-cols-1 gap-x-14 gap-y-12 lg:grid-cols-12">
        <div className="lg:col-span-6">
          <EyebrowCaption>Treatment memory for electrologists</EyebrowCaption>

          <h1
            className="font-[var(--font-fraunces)] mt-8 max-w-[760px] text-[44px] font-bold leading-[0.98] md:text-[64px]"
            style={{ letterSpacing: "-0.04em" }}
          >
            Treatment memory for electrologists.
          </h1>

          <p
            className="mt-8 max-w-[560px] text-[18px] leading-[1.5] md:text-[21px]"
            style={{ color: PALETTE.ink }}
          >
            Hone helps electrologists prepare for returning clients, chart
            treatment details, and keep cleaner procedure records.
          </p>

          <p
            className="mt-5 max-w-[560px] text-[16px] leading-[1.55]"
            style={{ color: PALETTE.muted }}
          >
            Your calendar knows who is coming. Hone helps you remember what
            matters.
          </p>

          <div className="mt-9 flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-5">
            <PrimaryCta href="/demo">Book a walkthrough</PrimaryCta>
            <SecondaryCta href="#product">See how it works</SecondaryCta>
          </div>

          <p className="mt-7 text-[13px]" style={{ color: PALETTE.muted }}>
            Built with electrologists who do this every day.
          </p>
        </div>

        <div className="lg:col-span-6">
          <HeroVisual />
        </div>
      </div>
    </Reveal>
  );
}

// Hero visual: the main Today card (the Before Today memory, chips, and
// a record reminder) plus two compact proof tiles so the column reads as
// a real product surface and balances the taller copy column on desktop.
function HeroVisual() {
  return (
    <div className="flex flex-col">
      <AppWindow title="Demo Studio · Today">
        <div className="flex items-center justify-between">
          <MockLabel>Today</MockLabel>
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
      </AppWindow>

      <div className="mt-4 grid grid-cols-2 gap-4">
        <MiniTile label="Before Today">Last treatment and what to watch.</MiniTile>
        <MiniTile label="Procedure record">Print-ready, per client.</MiniTile>
      </div>
      <DemoTag />
    </div>
  );
}

// Small two-line proof tile used under the hero card.
function MiniTile({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="rounded-lg p-4"
      style={{ backgroundColor: PALETTE.card, border: `1px solid ${PALETTE.rule}` }}
    >
      <MockLabel>{label}</MockLabel>
      <p className="mt-1.5 text-[13px] leading-[1.4]">{children}</p>
    </div>
  );
}

/* Proof strip: credible, non-fake signals right under the hero ─────────── */

const PROOF_ITEMS: ReadonlyArray<string> = [
  "Built with working electrologists",
  "Mobile-tested treatment workflows",
  "Browser-tested treatment-memory loop",
  "Lot traceability built in",
  "Founder-led setup",
];

function ProofStrip() {
  // The track holds the items twice so the -50% translate loops with no
  // visible seam. The second copy is aria-hidden so assistive tech reads
  // the proof list once. overflow-hidden (on .hone-marquee) contains the
  // wide track, so the strip never widens the page.
  const track = [...PROOF_ITEMS, ...PROOF_ITEMS];
  return (
    <Reveal
      as="section"
      className="overflow-hidden py-4"
      style={{
        backgroundColor: PALETTE.band,
        borderTop: `1px solid ${PALETTE.rule}`,
        borderBottom: `1px solid ${PALETTE.rule}`,
      }}
    >
      <div className="hone-marquee">
        <div className="hone-marquee__track">
          {track.map((item, i) => (
            <span
              key={i}
              aria-hidden={i >= PROOF_ITEMS.length ? "true" : undefined}
              className="mx-2 inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-4 py-1.5 text-[12px] font-medium"
              style={{
                backgroundColor: PALETTE.card,
                border: `1px solid ${PALETTE.rule}`,
                color: PALETTE.ink,
                letterSpacing: "0.01em",
              }}
            >
              {item}
            </span>
          ))}
        </div>
      </div>
    </Reveal>
  );
}

/* Section 2: Problem / comparison ──────────────────────────────────────── */

function ProblemSection() {
  return (
    <SectionShell>
      <EyebrowCaption>Calendar vs Hone</EyebrowCaption>
      <SectionTitle>
        Your calendar shows the appointment. Hone shows what to remember.
      </SectionTitle>
      <p className="mt-6 max-w-[720px] text-[17px] leading-[1.6] md:text-[19px]">
        Most tools stop at the appointment. Hone shows the details that matter
        when a client comes back.
      </p>

      <div className="mt-10 grid grid-cols-1 items-start gap-6 md:grid-cols-2">
        {/* Left: a plain appointment screen — all a calendar carries. */}
        <AppWindow title="Calendar-only">
          <MockLabel>Appointment data</MockLabel>
          <p
            className="mt-3 font-[var(--font-fraunces)] text-[26px] font-bold tabular-nums leading-none"
            style={{ letterSpacing: "-0.02em" }}
          >
            10:00 AM
          </p>
          <p className="mt-3 text-[15px] font-medium">Maya R.</p>
          <p className="text-[13px]" style={{ color: PALETTE.muted }}>
            Electrolysis
          </p>
          <div className="mt-4 flex items-center gap-2">
            <span className="text-[12px]" style={{ color: PALETTE.muted }}>
              Status
            </span>
            <Chip tone="green">Confirmed</Chip>
          </div>
        </AppWindow>

        {/* Right: a treatment-memory screen echoing the real Before Today
            and hero surfaces — chips, a remember band, a record reminder. */}
        <AppWindow title="Hone">
          <div className="flex items-baseline justify-between gap-3">
            <MockLabel>Treatment memory</MockLabel>
            <span className="text-[11px]" style={{ color: PALETTE.muted }}>
              Returning client
            </span>
          </div>
          <p className="mt-3 text-[15px] font-medium">Maya R.</p>
          <div className="mt-3">
            <RememberBand>
              For next visit: review upper lip sensitivity note.
            </RememberBand>
          </div>
          <div className="mt-3">
            <MockLabel>Last recorded</MockLabel>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              <Chip>Upper lip</Chip>
              <Chip>Sterex</Chip>
              <Chip>Lot L-204</Chip>
            </div>
          </div>
          <div className="mt-3">
            <MockLabel>Client response</MockLabel>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              <Chip tone="green">Tolerance 4/5</Chip>
              <Chip>Mild redness</Chip>
            </div>
          </div>
          <div className="mt-3">
            <Chip tone="amber">Aftercare not marked last session</Chip>
          </div>
        </AppWindow>
      </div>
    </SectionShell>
  );
}

/* Section 3: How Hone works (before / during / after) ──────────────────── */

const WORKFLOW: ReadonlyArray<{
  kicker: string;
  body: string;
  items: string[];
}> = [
  {
    kicker: "Before the appointment",
    body: "Open the client before they sit down. Hone shows the last treatment, what to watch, and what you wrote for next time.",
    items: ["Daily prep", "Before Today", "intake status", "last treatment"],
  },
  {
    kicker: "During the appointment",
    body: "Chart the treatment area, probe, lot, tolerance, reaction, and aftercare while it is fresh.",
    items: ["area", "probe and lot", "tolerance", "reaction", "aftercare"],
  },
  {
    kicker: "After the appointment",
    body: "Keep the procedure record, lot history, and follow-up notes in one place.",
    items: ["procedure record", "lot traceability", "follow-up notes", "print and export"],
  },
];

function HowHoneWorks() {
  return (
    <SectionShell tone="band">
      <EyebrowCaption>How it works</EyebrowCaption>
      <SectionTitle>Before, during, and after the appointment.</SectionTitle>
      <div className="mt-10 grid grid-cols-1 gap-6 md:grid-cols-3">
        {WORKFLOW.map((card) => (
          <MockCard key={card.kicker} className="flex flex-col">
            <p
              className="text-[11px] font-medium uppercase"
              style={{ letterSpacing: "0.2em", color: PALETTE.muted }}
            >
              {card.kicker}
            </p>
            <p className="mt-3 text-[15px] leading-[1.5]">{card.body}</p>
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
      <EyebrowCaption>What it remembers</EyebrowCaption>
      <SectionTitle>What Hone remembers.</SectionTitle>
      <p className="mt-6 max-w-[680px] text-[17px] leading-[1.6] md:text-[19px]">
        Before the client sits down, Hone shows the last treatment, caution
        notes, and what to record today.
      </p>

      {/* Before Today centerpiece: Hone's core pre-treatment surface. */}
      <div className="mt-10">
        <BeforeTodayMockup />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-3">
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

        {/* Procedure record */}
        <MockCard className="flex flex-col">
          <MockLabel>Procedure record</MockLabel>
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

        {/* Daily prep */}
        <MockCard className="flex flex-col">
          <MockLabel>Daily prep</MockLabel>
          <p className="mt-2 text-[15px] leading-[1.5]">
            Daily Prep Brief is simple on purpose. It looks at today&apos;s
            appointments and shows recorded notes, missing intake, charting
            gaps, and record reminders.
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

// Before Today centerpiece: the pre-treatment briefing as a real app
// screen. Remember-today band on top, then the three recorded panels
// (last treatment, client response, record reminders). Recorded-history
// wording only (recorded / last recorded / for next visit / caution
// noted / not recorded) — never recommended / caused / diagnosis.
function BeforeTodayMockup() {
  return (
    <div className="flex flex-col">
      <AppWindow title="Before Today · Maya R.">
        <RememberBand>
          <p>
            <span className="font-medium">Watch:</span> recorded sensitivity on
            upper lip.
          </p>
          <p className="mt-1">
            <span className="font-medium">For next visit:</span> shorter passes.
          </p>
        </RememberBand>

        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div
            className="rounded-md p-3.5"
            style={{ backgroundColor: PALETTE.bg, border: `1px solid ${PALETTE.rule}` }}
          >
            <MockLabel>Last treatment</MockLabel>
            <p className="mt-2 text-[13px]" style={{ color: PALETTE.muted }}>
              Last recorded Jun 12
            </p>
            <div className="mt-2 flex flex-col gap-1.5 text-[13px]">
              <span>Upper lip</span>
              <span>Sterex · L-204</span>
            </div>
          </div>
          <div
            className="rounded-md p-3.5"
            style={{ backgroundColor: PALETTE.bg, border: `1px solid ${PALETTE.rule}` }}
          >
            <MockLabel>Client response</MockLabel>
            <p className="mt-2 text-[13px]" style={{ color: PALETTE.muted }}>
              Last recorded
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Chip tone="green">Tolerance 4/5</Chip>
              <Chip>Mild redness</Chip>
            </div>
          </div>
          <div
            className="rounded-md p-3.5"
            style={{ backgroundColor: PALETTE.bg, border: `1px solid ${PALETTE.rule}` }}
          >
            <MockLabel>Record reminders</MockLabel>
            <div className="mt-2 flex flex-col gap-1.5">
              <Chip tone="amber">Caution noted</Chip>
              <Chip tone="amber">Aftercare not recorded</Chip>
            </div>
          </div>
        </div>
      </AppWindow>
      <DemoTag />
    </div>
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
    <SectionShell id="records" tone="band">
      <div className="grid grid-cols-1 items-start gap-x-14 gap-y-10 lg:grid-cols-12">
        <div className="lg:col-span-6">
          <EyebrowCaption>Record keeping</EyebrowCaption>
          <SectionTitle>Pull the record when you need it.</SectionTitle>
          <p className="mt-6 max-w-[520px] text-[17px] leading-[1.6] md:text-[19px]">
            If someone asks for one client&apos;s procedure record, you should not
            have to dig through notes. Choose the client, review the record, and
            print it.
          </p>
          <div className="mt-6 flex flex-wrap gap-2">
            <Chip>Lot traceability</Chip>
            <Chip>Sterile items</Chip>
            <Chip>Disinfectants</Chip>
            <Chip>Audit history</Chip>
          </div>
          <div
            className="mt-7 max-w-[520px] rounded-md px-4 py-3"
            style={{ backgroundColor: PALETTE.card, border: `1px solid ${PALETTE.rule}` }}
          >
            <p className="text-[13px] leading-[1.55]" style={{ color: PALETTE.muted }}>
              Hone supports record keeping workflows, but studios remain
              responsible for meeting local public-health requirements.
            </p>
          </div>
        </div>
        <div className="lg:col-span-6">
          <ProcedureRecordVisual />
        </div>
      </div>
    </SectionShell>
  );
}

// Procedure-record mockup: one client's printable record with demo data,
// the proof that "pull the record" is a real product surface.
function ProcedureRecordVisual() {
  return (
    <div className="flex flex-col">
      <MockCard>
        <div className="flex items-center justify-between">
          <MockLabel>Procedure record</MockLabel>
          <span className="text-[11px]" style={{ color: PALETTE.muted }}>
            Demo Studio
          </span>
        </div>
        <div className="mt-3 flex items-baseline justify-between gap-3">
          <p className="text-[15px] font-medium">Maya R.</p>
          <span className="text-[12px] tabular-nums" style={{ color: PALETTE.muted }}>
            Jun 12
          </span>
        </div>
        <div className="mt-4 flex flex-col gap-2 text-[14px]">
          <ChartRow label="Area" value="Upper lip" />
          <ChartRow label="Probe / lot" value="Sterex · L-204" />
          <ChartRow label="Tolerance / reaction" value="4/5 · Mild redness" />
          <ChartRow label="Aftercare" value="Marked" />
        </div>
        <div
          className="mt-4 flex items-center justify-between rounded-md px-3 py-2.5"
          style={{ backgroundColor: PALETTE.bg, border: `1px solid ${PALETTE.rule}` }}
        >
          <span className="text-[12px] font-medium">
            Print this client&apos;s procedure record
          </span>
          <span className="text-[11px]" style={{ color: PALETTE.muted }}>
            PDF
          </span>
        </div>
      </MockCard>
      <DemoTag />
    </div>
  );
}

/* Section 6: Smarter prep, without autopilot ───────────────────────────── */

const PREP_ROWS: ReadonlyArray<{ name: string; note: string; tone: "blue" | "amber" }> = [
  { name: "Maya R.", note: "Review upper lip sensitivity note", tone: "blue" },
  { name: "Jordan L.", note: "Intake not reviewed", tone: "amber" },
  { name: "Alex P.", note: "Probe lot missing from last session", tone: "amber" },
];

function AgenticSection() {
  return (
    <SectionShell id="prep">
      <div className="grid grid-cols-1 items-start gap-x-14 gap-y-10 lg:grid-cols-12">
        <div className="lg:col-span-6">
          <EyebrowCaption>Looking ahead</EyebrowCaption>
          <SectionTitle>Smarter prep, without autopilot.</SectionTitle>
          <p className="mt-6 max-w-[520px] text-[17px] leading-[1.6] md:text-[19px]">
            Better records come first. Once the treatment history is there, Hone
            can help pull together the day: who needs review, what is missing, and
            what you wrote for next time.
          </p>
          <div
            className="mt-7 max-w-[520px] rounded-md px-4 py-3"
            style={{ backgroundColor: PALETTE.chip, border: `1px solid ${PALETTE.rule}` }}
          >
            <p className="text-[13px] leading-[1.55]" style={{ color: PALETTE.muted }}>
              Future smart features should help with prep and drafts. They should
              not diagnose, recommend treatment settings, send messages, charge
              cards, or change records without you.
            </p>
          </div>
        </div>
        <div className="lg:col-span-6">
          <DailyPrepVisual />
        </div>
      </div>
    </SectionShell>
  );
}

// Daily prep mockup (Option A): the live, rules-based Daily Prep Brief
// surfacing what to review tomorrow from recorded Hone data.
function DailyPrepVisual() {
  return (
    <div className="flex flex-col">
      <MockCard>
        <div className="flex items-center justify-between">
          <MockLabel>Daily prep</MockLabel>
          <span className="text-[11px]" style={{ color: PALETTE.muted }}>
            Demo Studio
          </span>
        </div>
        <p className="mt-2 text-[15px] font-medium">Tomorrow morning</p>
        <div className="mt-3 flex flex-col gap-2.5">
          {PREP_ROWS.map((row) => {
            const tone =
              row.tone === "blue"
                ? { bg: PALETTE.blueBg, border: PALETTE.blueRule, ink: PALETTE.blueInk }
                : { bg: PALETTE.amberBg, border: PALETTE.amberRule, ink: PALETTE.amberInk };
            return (
              <div
                key={row.name}
                className="rounded-md px-3 py-2.5"
                style={{ backgroundColor: tone.bg, border: `1px solid ${tone.border}` }}
              >
                <p className="text-[13px] font-medium" style={{ color: tone.ink }}>
                  {row.name}
                </p>
                <p className="mt-0.5 text-[12px]" style={{ color: tone.ink }}>
                  {row.note}
                </p>
              </div>
            );
          })}
        </div>
        <div
          className="mt-3 flex items-center justify-between rounded-md px-3 py-2.5"
          style={{ backgroundColor: PALETTE.bg, border: `1px solid ${PALETTE.rule}` }}
        >
          <span className="text-[12px] font-medium">Review Before Today</span>
          <span className="text-[13px]" style={{ color: PALETTE.muted }} aria-hidden="true">
            →
          </span>
        </div>
        <p className="mt-3 text-[11px]" style={{ color: PALETTE.muted }}>
          Based on recorded Hone data.
        </p>
      </MockCard>
      <DemoTag />
    </div>
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
  // Two columns: the claim on the left, one compact checklist card on the
  // right. Replaces the old five-card 3+2 grid (awkward half-empty row).
  return (
    <SectionShell tone="band">
      <div className="grid grid-cols-1 items-start gap-x-14 gap-y-10 lg:grid-cols-12">
        <div className="lg:col-span-6">
          <EyebrowCaption>Privacy and trust</EyebrowCaption>
          <SectionTitle>Your client records should stay yours.</SectionTitle>
          <p className="mt-6 max-w-[480px] text-[17px] leading-[1.6] md:text-[19px]">
            Hone is built for sensitive client records. Your studio&apos;s data
            stays separate, exportable, and never used for advertising.
          </p>
          <p className="mt-6 text-[14px]" style={{ color: PALETTE.muted }}>
            Full details in the{" "}
            <Link href="/privacy" className="underline">
              privacy policy
            </Link>
            .
          </p>
        </div>
        <div className="lg:col-span-6">
          <MockCard className="flex flex-col gap-3.5">
            {TRUST_POINTS.map((t) => (
              <div key={t} className="flex items-start gap-3">
                <span
                  className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold"
                  style={{ backgroundColor: PALETTE.greenBg, color: PALETTE.greenInk }}
                  aria-hidden="true"
                >
                  ✓
                </span>
                <p className="text-[15px] leading-[1.4]">{t}</p>
              </div>
            ))}
          </MockCard>
        </div>
      </div>
    </SectionShell>
  );
}

/* Section 8: Pricing / CTA ─────────────────────────────────────────────── */

const PRICING_CHIPS: ReadonlyArray<string> = [
  "Founder-led setup",
  "Cancel anytime",
  "Export your data",
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
          <h3
            className="font-[var(--font-fraunces)] text-[24px] font-bold leading-[1.1] md:text-[28px]"
            style={{ letterSpacing: "-0.02em" }}
          >
            See if Hone fits your studio.
          </h3>
          <p className="mt-4 text-[18px] leading-[1.55] md:text-[20px]">
            Bring one real treatment workflow. We will walk through how Hone
            handles the appointment, charting, treatment memory, and records.
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
