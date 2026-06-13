import Link from "next/link";
import { Reveal } from "./_components/Reveal";
import { MarketingHeader } from "./_components/MarketingHeader";
import { MarketingFooter } from "./_components/MarketingFooter";
import { SafeAnalytics } from "./_components/SafeAnalytics";
import { EyebrowCaption } from "./_components/MarketingAtoms";
import { MARKETING_PALETTE as PALETTE } from "./_components/marketingNav";

// Public marketing homepage. PR #242: repositioned around the product
// thesis: Hone is the treatment memory system for permanent hair
// removal studios, not booking software, not generic practice
// management, not AI treatment advice. The page follows the arc:
// calendar knows the appointment -> Hone remembers the treatment ->
// before the appointment Hone prepares the practitioner -> during it
// captures the right details -> after it keeps the record clean ->
// over time structured memory enables safe, practitioner-controlled
// agentic support. All product visuals are coded mockups with
// anonymized demo data only (Maya R. / Jordan L. / Alex P. / Demo
// Studio / lot L-204 / Sterex), never real clients or studios. Copy
// stays within the docs/22 safety boundary: assistant not decider,
// draft not send, flag not diagnose; no medical or compliance
// overclaims. Primary CTA is "Book a walkthrough" -> /demo.
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
      <BeforeDuringAfter />
      <BeforeTodaySection />
      <DailyPrepBriefSection />
      <ChartingSection />
      <RecordKeepingSection />
      <DevicesSection />
      <AgenticSupportSection />
      <AgenticSafetySection />
      <TrustSection />
      <PricingSection />
      <FinalCTA />
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
      className={`scroll-mt-24 px-6 py-20 md:px-12 md:py-28 lg:px-16 ${className}`}
    >
      <div className="mx-auto max-w-[1400px]">{children}</div>
    </Reveal>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2
      className="font-[var(--font-fraunces)] mt-8 max-w-[860px] text-[32px] font-bold leading-[1.05] md:text-[44px]"
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

function RememberBand({
  heading = "Remember today",
  children,
}: {
  heading?: string;
  children: React.ReactNode;
}) {
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
        {heading}
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

/* Section: Hero ────────────────────────────────────────────────────────── */

function Hero() {
  return (
    <Reveal as="section" className="px-6 pb-20 pt-16 md:px-12 md:pb-24 md:pt-20 lg:px-16">
      <div className="mx-auto grid max-w-[1400px] grid-cols-1 gap-x-14 gap-y-14 lg:grid-cols-12">
        <div className="lg:col-span-6">
          <EyebrowCaption>
            Treatment memory for permanent hair removal studios
          </EyebrowCaption>

          <h1
            className="font-[var(--font-fraunces)] mt-8 max-w-[760px] text-[44px] font-bold leading-[0.98] md:text-[68px]"
            style={{ letterSpacing: "-0.04em" }}
          >
            Treatment memory for permanent hair removal studios.
          </h1>

          <p
            className="mt-8 max-w-[600px] text-[18px] leading-[1.55] md:text-[20px]"
            style={{ color: PALETTE.ink }}
          >
            Hone helps electrologists prepare for each appointment, chart what
            happened, and keep procedure records clean. It is the operating
            memory layer for your studio, built for safe, practitioner-controlled
            agentic support over time.
          </p>

          <p
            className="mt-6 max-w-[600px] text-[16px] leading-[1.6]"
            style={{ color: PALETTE.muted }}
          >
            Before the client sits down, Hone shows what happened last time: last
            setup, tolerance, reaction, caution notes, next-session plan, and
            record reminders.
          </p>

          <div className="mt-10 flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-5">
            <PrimaryCta href="/demo">Book a walkthrough</PrimaryCta>
            <SecondaryCta href="#product">
              See how treatment memory works
            </SecondaryCta>
          </div>

          <p className="mt-7 text-[13px]" style={{ color: PALETTE.muted }}>
            Built for practitioner-controlled workflows. No autonomous treatment
            decisions.
          </p>
        </div>

        <div className="lg:col-span-6">
          <HeroComposition />
        </div>
      </div>
    </Reveal>
  );
}

// A realistic anonymized composition: a Today appointment, a Daily
// Prep Brief item, the Before Today "Remember today" band, treatment
// memory chips, a record reminder, and the next-action chip.
function HeroComposition() {
  return (
    <div className="flex flex-col gap-4">
      <MockCard>
        <div className="flex items-center justify-between">
          <MockLabel>Today · Demo Studio</MockLabel>
          <span className="text-[11px]" style={{ color: PALETTE.muted }}>
            Tue
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
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <Chip tone="amber">Aftercare not marked last session</Chip>
          <Chip tone="blue">Review Before Today</Chip>
        </div>
      </MockCard>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <MockCard>
          <MockLabel>Daily prep brief</MockLabel>
          <p className="mt-2 text-[13px] font-medium">3 to review</p>
          <p className="mt-1 text-[12px]" style={{ color: PALETTE.muted }}>
            Recorded memory and follow-up items, ordered by what needs attention.
          </p>
        </MockCard>
        <MockCard>
          <MockLabel>Charted within 24h</MockLabel>
          <p className="mt-2 text-[22px] font-semibold tabular-nums">92%</p>
          <p className="mt-1 text-[12px]" style={{ color: PALETTE.muted }}>
            Recorded sessions charted on time.
          </p>
        </MockCard>
      </div>
      <DemoTag />
    </div>
  );
}

/* Section: Problem (calendar does not remember) ────────────────────────── */

function ProblemSection() {
  return (
    <SectionShell>
      <EyebrowCaption>The gap</EyebrowCaption>
      <SectionTitle>
        Your calendar does not remember what happened last time.
      </SectionTitle>
      <p className="mt-6 max-w-[680px] text-[17px] leading-[1.65] md:text-[19px]">
        Generic booking tools know when the client is coming. Hone remembers
        what you did, what they tolerated, what needs caution, and what should
        happen next.
      </p>

      <div className="mt-12 grid grid-cols-1 gap-6 md:grid-cols-2">
        <MockCard>
          <MockLabel>Calendar-only</MockLabel>
          <ul className="mt-4 flex flex-col gap-3 text-[15px]">
            {["Time", "Client", "Service"].map((row) => (
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
        <MockCard>
          <MockLabel>Hone</MockLabel>
          <ul className="mt-4 flex flex-col gap-3 text-[15px]">
            {[
              "Last treatment area",
              "Probe and lot",
              "Tolerance and reaction",
              "Caution note",
              "Next-session plan",
              "Record reminders",
              "Daily prep item",
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
      <p
        className="mt-8 font-[var(--font-fraunces)] text-[20px] italic"
        style={{ color: PALETTE.ink }}
      >
        Calendar-only gives you the appointment. Hone gives you the memory.
      </p>
    </SectionShell>
  );
}

/* Section: Before / During / After ─────────────────────────────────────── */

const WORKFLOW: ReadonlyArray<{ kicker: string; title: string; items: string[] }> = [
  {
    kicker: "Before",
    title: "Review the client before they sit down.",
    items: [
      "Daily Prep Brief",
      "Before Today",
      "last treatment",
      "watch notes",
      "next-session plan",
      "intake status",
    ],
  },
  {
    kicker: "During",
    title: "Chart the details that matter.",
    items: [
      "treatment area",
      "settings",
      "probe and lot",
      "tolerance and reaction",
      "caution",
      "aftercare",
    ],
  },
  {
    kicker: "After",
    title: "Keep the record ready.",
    items: [
      "procedure record",
      "lot traceability",
      "audit history",
      "print and export",
      "charted within 24h",
    ],
  },
];

function BeforeDuringAfter() {
  return (
    <SectionShell id="how-it-works">
      <EyebrowCaption>How it works</EyebrowCaption>
      <SectionTitle>Before, during, and after every appointment.</SectionTitle>
      <div className="mt-12 grid grid-cols-1 gap-6 md:grid-cols-3">
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

/* Section: Before Today ────────────────────────────────────────────────── */

function BeforeTodaySection() {
  return (
    <SectionShell id="product">
      <div className="grid grid-cols-1 gap-x-14 gap-y-10 md:grid-cols-12">
        <div className="md:col-span-6">
          <EyebrowCaption>Before Today</EyebrowCaption>
          <SectionTitle>
            Start every returning appointment with context.
          </SectionTitle>
          <p className="mt-6 max-w-[520px] text-[17px] leading-[1.65] md:text-[19px]">
            Before Today turns recorded history into a pre-treatment briefing:
            what to remember, what was done last time, how the client responded,
            and what is missing from the record.
          </p>
          <div className="mt-6 flex flex-wrap gap-1.5">
            <Chip>recorded</Chip>
            <Chip>last recorded</Chip>
            <Chip>for next visit</Chip>
            <Chip>caution noted</Chip>
            <Chip>not recorded</Chip>
          </div>
        </div>
        <div className="md:col-span-6">
          <MockCard>
            <MockLabel>Before today · Maya R.</MockLabel>
            <div className="mt-3">
              <RememberBand>
                <p>
                  <span className="font-medium">Watch:</span> sensitive on upper
                  lip, start lower.
                </p>
                <p className="mt-1">
                  <span className="font-medium">For next visit:</span> shorter
                  passes near upper lip.
                </p>
              </RememberBand>
            </div>
            <div className="mt-4">
              <MockLabel>Last treatment</MockLabel>
              <p className="mt-1.5 text-[14px]">Upper lip · Jun 2</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Chip>Electrolysis</Chip>
                <Chip>Sterex probe</Chip>
                <Chip>Lot L-204</Chip>
                <Chip>15 min</Chip>
              </div>
            </div>
            <div className="mt-4">
              <MockLabel>Client response (last recorded)</MockLabel>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Chip tone="green">Tolerance 4/5</Chip>
                <Chip>Mild redness</Chip>
              </div>
            </div>
            <div className="mt-4">
              <MockLabel>Record reminders</MockLabel>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Chip tone="amber">Aftercare not marked</Chip>
              </div>
            </div>
          </MockCard>
          <DemoTag />
        </div>
      </div>
    </SectionShell>
  );
}

/* Section: Daily Prep Brief (live, rules-based) ────────────────────────── */

function DailyPrepBriefSection() {
  return (
    <SectionShell>
      <div className="grid grid-cols-1 gap-x-14 gap-y-10 md:grid-cols-12">
        <div className="md:col-span-6">
          <EyebrowCaption>Daily Prep Brief · Live</EyebrowCaption>
          <SectionTitle>
            Know what needs attention before the day starts.
          </SectionTitle>
          <p className="mt-6 max-w-[520px] text-[17px] leading-[1.65] md:text-[19px]">
            Daily Prep Brief uses recorded Hone data to surface today&apos;s
            appointments, treatment memory, intake gaps, charting gaps, and
            record reminders before the day begins.
          </p>
          <ul className="mt-6 flex flex-col gap-2 text-[15px]" style={{ color: PALETTE.muted }}>
            <li>Rules-based today: no AI model call required for V1.</li>
            <li>Built only from recorded studio data.</li>
            <li>Ordered by what needs attention first.</li>
          </ul>
        </div>
        <div className="md:col-span-6">
          <MockCard>
            <MockLabel>Daily prep brief</MockLabel>
            <div
              className="mt-3 rounded-md p-3.5"
              style={{ backgroundColor: PALETTE.bg, border: `1px solid ${PALETTE.rule}` }}
            >
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-[14px] font-medium">Maya R.</p>
                <span className="text-[12px] tabular-nums" style={{ color: PALETTE.muted }}>
                  10:00 AM
                </span>
              </div>
              <ul className="mt-2 flex flex-col gap-1 text-[13px]">
                <li>For next visit: review upper lip sensitivity note</li>
                <li>Last recorded: upper lip · Sterex probe · lot L-204</li>
                <li style={{ color: PALETTE.amberInk }}>
                  Record reminder: aftercare not marked last session
                </li>
              </ul>
              <div className="mt-2.5">
                <Chip tone="blue">Action: Review Before Today</Chip>
              </div>
            </div>
          </MockCard>
          <DemoTag />
        </div>
      </div>
    </SectionShell>
  );
}

/* Section: Charting ────────────────────────────────────────────────────── */

const CHARTING_BULLETS: ReadonlyArray<string> = [
  "treatment areas and session blocks",
  "electrolysis and laser entries",
  "probe and lot number",
  "tolerance and reaction",
  "caution and next-session note",
  "risks explained and aftercare provided stamp",
];

function ChartingSection() {
  return (
    <SectionShell>
      <div className="grid grid-cols-1 gap-x-14 gap-y-10 md:grid-cols-12">
        <div className="md:col-span-6">
          <EyebrowCaption>Charting</EyebrowCaption>
          <SectionTitle>Chart once. Reuse the memory next time.</SectionTitle>
          <p className="mt-6 max-w-[520px] text-[17px] leading-[1.65] md:text-[19px]">
            Hone captures the details that matter across repeated treatment
            visits, then brings them back when the client returns.
          </p>
          <ul className="mt-6 flex flex-col gap-2.5 text-[15px]">
            {CHARTING_BULLETS.map((b) => (
              <li
                key={b}
                className="border-b pb-2.5"
                style={{ borderColor: PALETTE.rule }}
              >
                {b}
              </li>
            ))}
          </ul>
        </div>
        <div className="md:col-span-6">
          <MockCard>
            <MockLabel>New treatment area</MockLabel>
            <p className="mt-2 text-[16px] font-medium">Upper lip</p>
            <div className="mt-3 flex flex-col gap-2 text-[14px]">
              <ChartRow label="Probe" value="Sterex" />
              <ChartRow label="Lot" value="L-204" />
              <ChartRow label="Tolerance" value="4/5" />
              <ChartRow label="Reaction" value="Mild redness" />
            </div>
            <div className="mt-3">
              <MockLabel>For next visit</MockLabel>
              <p className="mt-1.5 text-[14px]">Shorter passes near upper lip.</p>
            </div>
            <div className="mt-4">
              <Chip tone="green">Risks explained and aftercare provided</Chip>
            </div>
          </MockCard>
          <DemoTag />
        </div>
      </div>
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

/* Section: Record Keeping ──────────────────────────────────────────────── */

const RECORDS_BULLETS: ReadonlyArray<string> = [
  "sterile items",
  "disinfectants",
  "exposure incident records",
  "audit history",
  "per-client procedure records",
  "lot traceability",
  "print and export",
];

function RecordKeepingSection() {
  return (
    <SectionShell id="records">
      <EyebrowCaption>Record keeping</EyebrowCaption>
      <SectionTitle>
        Procedure records without scrambling before inspection.
      </SectionTitle>
      <p className="mt-6 max-w-[680px] text-[17px] leading-[1.65] md:text-[19px]">
        Hone keeps treatment records, sterile item logs, disinfectant records,
        exposure incident reporting, lot traceability, and audit history
        together.
      </p>
      <div className="mt-10 flex flex-wrap gap-2">
        {RECORDS_BULLETS.map((b) => (
          <Chip key={b}>{b}</Chip>
        ))}
      </div>
      <p
        className="mt-8 max-w-[680px] text-[14px] leading-[1.6]"
        style={{ color: PALETTE.muted }}
      >
        Hone supports record keeping workflows, but studios remain responsible
        for meeting local public-health requirements.
      </p>
    </SectionShell>
  );
}

/* Section: Mobile / iPad ───────────────────────────────────────────────── */

const DEVICES: ReadonlyArray<{ label: string; title: string; chips: string[] }> = [
  {
    label: "Phone",
    title: "Search and prep on the go.",
    chips: ["Search", "Daily prep brief", "Client page"],
  },
  {
    label: "iPad",
    title: "Chart at the chair.",
    chips: ["Calendar", "Charting", "Before Today"],
  },
  {
    label: "Desktop",
    title: "Run the day from the dashboard.",
    chips: ["Today", "Records", "Audit history"],
  },
];

function DevicesSection() {
  return (
    <SectionShell>
      <EyebrowCaption>Built for the device in your hand</EyebrowCaption>
      <SectionTitle>Built for the device in your hand.</SectionTitle>
      <p className="mt-6 max-w-[680px] text-[17px] leading-[1.65] md:text-[19px]">
        Hone works on phone, iPad, and desktop, with mobile-safe calendar,
        search, client pages, charting, and record views.
      </p>
      <div className="mt-10 grid grid-cols-1 gap-6 md:grid-cols-3">
        {DEVICES.map((d) => (
          <MockCard key={d.label} className="flex flex-col">
            <MockLabel>{d.label}</MockLabel>
            <h3 className="font-[var(--font-fraunces)] mt-3 text-[20px] font-normal leading-[1.25]">
              {d.title}
            </h3>
            <div className="mt-4 flex flex-wrap gap-1.5">
              {d.chips.map((c) => (
                <Chip key={c}>{c}</Chip>
              ))}
            </div>
          </MockCard>
        ))}
      </div>
    </SectionShell>
  );
}

/* Section: Agentic practice support ────────────────────────────────────── */

const AGENTIC_SUPPORT: ReadonlyArray<string> = [
  "Daily prep from recorded treatment history",
  "Follow-up reminders from missing records and next-session notes",
  "Draft-only client communication, reviewed before sending",
  "Human confirmation before any external action",
  "No treatment recommendations as medical advice",
  "No auto-sending, auto-charging, or silent record changes",
];

function AgenticSupportSection() {
  return (
    <SectionShell id="agentic">
      <EyebrowCaption>Agentic support</EyebrowCaption>
      <SectionTitle>Built for agentic practice support.</SectionTitle>
      <p className="mt-6 max-w-[760px] text-[17px] leading-[1.65] md:text-[19px]">
        Hone is not adding a chatbot on top of a calendar. Hone structures
        treatment memory first: areas treated, probe lots, tolerance, reaction,
        caution notes, next-session plans, and record reminders. That structured
        memory creates the foundation for safe agentic workflows that prepare the
        practitioner, flag missing records, and draft follow-ups without making
        clinical decisions.
      </p>
      <div className="mt-10 grid grid-cols-1 gap-x-10 gap-y-4 md:grid-cols-2">
        {AGENTIC_SUPPORT.map((b) => (
          <p
            key={b}
            className="border-b pb-4 text-[16px] leading-[1.5]"
            style={{ borderColor: PALETTE.rule }}
          >
            {b}
          </p>
        ))}
      </div>
      <p className="mt-8 text-[15px] font-medium">
        Practitioner-controlled. Record-based. No autonomous clinical decisions.
      </p>
    </SectionShell>
  );
}

/* Section: Agentic safety ──────────────────────────────────────────────── */

const AGENTIC_SAFETY: ReadonlyArray<string> = [
  "Assistant, not decider",
  "Draft, not send",
  "Flag, not diagnose",
  "Summarize recorded history, do not invent",
  "Human confirmation before messages, exports, appointments, or payments",
  "Sensitive surfaces like exposure incidents, payment internals, and raw tokens are excluded from V1 agentic workflows",
];

function AgenticSafetySection() {
  return (
    <SectionShell>
      <EyebrowCaption>Agentic safety</EyebrowCaption>
      <SectionTitle>Agentic, but controlled.</SectionTitle>
      <p className="mt-6 max-w-[760px] text-[17px] leading-[1.65] md:text-[19px]">
        Hone&apos;s agentic roadmap is designed around practitioner control.
        Future AI-assisted workflows should summarize recorded history, flag
        missing information, and draft messages for review. They should not
        diagnose, recommend treatment settings, send messages, charge cards, or
        modify clinical records without human confirmation.
      </p>
      <div className="mt-10 grid grid-cols-1 gap-x-10 gap-y-4 md:grid-cols-2">
        {AGENTIC_SAFETY.map((b) => (
          <p
            key={b}
            className="border-b pb-4 text-[16px] leading-[1.5]"
            style={{ borderColor: PALETTE.rule }}
          >
            {b}
          </p>
        ))}
      </div>
    </SectionShell>
  );
}

/* Section: Trust / privacy ─────────────────────────────────────────────── */

const TRUST_POINTS: ReadonlyArray<{ headline: string; body: string }> = [
  {
    headline: "Your client records stay yours.",
    body: "Export the full history of your studio at any time. If you cancel, your data goes with you.",
  },
  {
    headline: "No advertising use of health records.",
    body: "Client health, intake, and treatment records are never used for advertising or behavioral tracking.",
  },
  {
    headline: "No AI training on your records.",
    body: "Hone does not train machine learning models on practitioner or client records.",
  },
  {
    headline: "Studio data is isolated.",
    body: "Row-level security keeps each studio's data scoped to its own studio. One studio never sees another's records.",
  },
  {
    headline: "Secure sign in.",
    body: "Magic link or Google sign in. No shared passwords floating around the studio.",
  },
  {
    headline: "Export available.",
    body: "Export a ZIP of your studio any time. Private practitioner notes are excluded from the general export.",
  },
];

function TrustSection() {
  return (
    <SectionShell>
      <EyebrowCaption>Privacy and trust</EyebrowCaption>
      <SectionTitle>Built carefully for sensitive client records.</SectionTitle>
      <div className="mt-12 grid grid-cols-1 gap-x-12 gap-y-9 md:grid-cols-2">
        {TRUST_POINTS.map((t) => (
          <div key={t.headline} className="flex flex-col">
            <h3 className="text-[17px] font-medium leading-[1.35]">
              {t.headline}
            </h3>
            <p
              className="mt-2 text-[15px] leading-[1.6]"
              style={{ color: PALETTE.muted }}
            >
              {t.body}
            </p>
          </div>
        ))}
      </div>
      <p
        className="mt-10 text-[14px] leading-[1.55]"
        style={{ color: PALETTE.muted }}
      >
        Full detail in the{" "}
        <Link href="/privacy" className="underline">
          privacy policy
        </Link>
        .
      </p>
    </SectionShell>
  );
}

/* Section: Pricing ─────────────────────────────────────────────────────── */

const PRICING_INCLUDES: ReadonlyArray<string> = [
  "Founder-led setup",
  "Cancel anytime",
  "Full data export",
];

function PricingSection() {
  return (
    <SectionShell id="pricing">
      <EyebrowCaption>Founding pilot</EyebrowCaption>
      <SectionTitle>One price for the whole workflow.</SectionTitle>

      <div
        className="mt-12 grid grid-cols-1 gap-10 p-8 md:grid-cols-12 md:p-10"
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
            {PRICING_INCLUDES.map((p) => (
              <Chip key={p}>{p}</Chip>
            ))}
          </div>
          <p
            className="mt-5 text-[15px] leading-[1.6]"
            style={{ color: PALETTE.muted }}
          >
            Founding pilot pricing while we onboard the first wave of studios.
            Early pilot onboarding is limited. Pricing may change later.
          </p>
        </div>
        <div className="md:col-span-7">
          <p className="text-[17px] leading-[1.65]">
            Treatment memory, Before Today, Daily Prep Brief, charting, procedure
            records, and lot traceability. Founder-led setup and onboarding. The
            product claim is the memory layer, not payment processing.
          </p>
          <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
            <PrimaryCta href="/demo">Book a walkthrough</PrimaryCta>
            <SecondaryCta href="/pricing">See pricing</SecondaryCta>
          </div>
        </div>
      </div>
    </SectionShell>
  );
}

/* Section: Final CTA ───────────────────────────────────────────────────── */

function FinalCTA() {
  return (
    <Reveal as="section" className="px-6 py-20 md:px-12 md:py-28 lg:px-16">
      <div className="mx-auto max-w-[820px]">
        <h2
          className="font-[var(--font-fraunces)] text-[34px] font-bold leading-[1.05] md:text-[48px]"
          style={{ letterSpacing: "-0.03em" }}
        >
          See if Hone fits your studio.
        </h2>
        <p className="mt-6 text-[18px] leading-[1.65] md:text-[21px]">
          Bring one real treatment workflow. We will walk through how Hone would
          handle the appointment, charting, treatment memory, and records.
        </p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-5">
          <PrimaryCta href="/demo">Book a 15-minute walkthrough</PrimaryCta>
          <SecondaryCta href="/pricing">See pricing</SecondaryCta>
        </div>
      </div>
    </Reveal>
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
