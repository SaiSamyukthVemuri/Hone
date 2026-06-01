import Link from "next/link";
import { Reveal } from "./_components/Reveal";
import { WaitlistForm } from "./_components/WaitlistForm";
import { MarketingHeader } from "./_components/MarketingHeader";
import { MarketingFooter } from "./_components/MarketingFooter";
import {
  EyebrowCaption,
  Hairline,
} from "./_components/MarketingAtoms";
import { MARKETING_PALETTE as PALETTE } from "./_components/marketingNav";
import {
  ChartingPreview,
  PlanProgressPreview,
  CalendarPreview,
} from "./_components/ProductPreview";

export default function HomePage() {
  return (
    <main
      style={{
        backgroundColor: PALETTE.bg,
        color: PALETTE.ink,
        fontFeatureSettings: '"cv11"',
      }}
      className="min-h-screen font-[var(--font-inter)]"
    >
      <MarketingHeader />
      <Hero />
      <PracticeMemory />
      <EditorialObservation />
      <HowItWorks />
      <CheatSheetPreview />
      <InsideHone />
      <BuiltForTheWork />
      <TrustLine />
      <ClosingNote />
      <MarketingFooter />
    </main>
  );
}

/* Hero ─────────────────────────────────────────────────────────────────── */

function Hero() {
  return (
    <Reveal
      as="section"
      className="px-6 pb-24 pt-20 md:px-12 md:pb-28 md:pt-24 lg:px-16"
    >
      <div className="mx-auto max-w-[1400px]">
        <EyebrowCaption>Electrolysis practice software</EyebrowCaption>

        {/* YC-style positioning headline: category-led, no marketing
            superlatives, no hedged tagline. The previous "Never wonder"
            line still surfaces in the editorial section below; this slot
            is now for the literal product category, indexed first. */}
        <h1
          className="font-[var(--font-fraunces)] mt-10 max-w-[1100px] text-[56px] font-bold leading-[0.94] md:text-[92px]"
          style={{ letterSpacing: "-0.045em" }}
        >
          Electrolysis practice software that remembers the treatment details.
        </h1>

        <p
          className="mt-10 max-w-[640px] text-[18px] leading-[1.55] md:text-[21px]"
          style={{ color: PALETTE.ink }}
        >
          Booking, intake, treatment plans, charting, and postcare for
          electrologists who need more than a generic calendar.
        </p>

        {/* Primary CTA is the inline waitlist email with submit button
            labelled "Get early access". Secondary CTA is a "Request a
            walkthrough" link to /demo, which is a founder-led
            walkthrough request (not a recorded demo). Access-gate copy
            explains why the form is gated, so the gate reads as
            intentional rather than broken. Anchor name kept stable for
            inbound links from the pricing page. */}
        <div id="early-access" className="mt-[56px] max-w-[700px]">
          <EyebrowCaption>Get early access</EyebrowCaption>
          <p
            className="mt-3 max-w-[620px] text-[15px] leading-[1.55]"
            style={{ color: PALETTE.muted }}
          >
            We onboard a few studios at a time. Founder-led setup means
            we help each studio configure booking, services, intake, and
            postcare correctly before you send a real client through.
          </p>
          <div className="mt-6">
            <WaitlistForm />
          </div>
          <div className="mt-6">
            <Link
              href="/demo"
              className="text-[14px] font-medium uppercase hover:opacity-60"
              style={{ letterSpacing: "0.2em", color: PALETTE.ink }}
            >
              Request a walkthrough →
            </Link>
          </div>
          <div className="mt-10">
            <EyebrowCaption>Works on iPad, laptop, and phone</EyebrowCaption>
          </div>
        </div>
      </div>
    </Reveal>
  );
}

/* Practice memory positioning ──────────────────────────────────────────── */

function PracticeMemory() {
  return (
    <Reveal as="section" className="px-6 py-16 md:px-12 md:py-24 lg:px-16">
      <div className="mx-auto max-w-[1400px]">
        <p
          className="font-[var(--font-fraunces)] max-w-[900px] text-[28px] font-bold leading-[1.15] md:text-[36px]"
          style={{ letterSpacing: "-0.025em" }}
        >
          Hone is the practice memory system for permanent hair removal.
        </p>
        <p className="mt-6 max-w-[680px] text-[18px] leading-[1.65] md:text-[21px]">
          Booking and scheduling are table stakes. The real product is the
          thing every practitioner needs but no software has given them: a
          faithful, fast, structured memory of what you did with each client,
          across every session. In practice that means electrolysis software
          for booking, treatment plans, and clinical charting, built around
          that memory rather than bolted on beside it.
        </p>
      </div>
    </Reveal>
  );
}

/* Editorial observation (the one big moment; folds in the closing essay) ── */

function EditorialObservation() {
  return (
    <Reveal as="section" className="px-6 py-20 md:px-12 md:py-28 lg:px-16">
      <div className="mx-auto grid max-w-[1400px] grid-cols-1 gap-x-16 gap-y-10 md:grid-cols-12">
        <div className="md:col-span-7">
          <h2
            className="font-[var(--font-fraunces)] text-[44px] font-bold leading-[0.95] md:text-[72px]"
            style={{ letterSpacing: "-0.04em" }}
          >
            <span className="block">
              Most <em>electrolysis</em>
            </span>
            <span className="block">and laser studios</span>
            <em className="block">still</em>
            <span className="block">chart on paper.</span>
          </h2>
        </div>
        <div className="space-y-6 md:col-span-5">
          <p className="text-[18px] leading-[1.55] md:text-[21px]">
            Paper, because every software alternative is worse than paper.
            Generic booking platforms don&rsquo;t understand probe sizes or
            pulse counts. Medical records are built for doctors, not
            practitioners working hair by hair. Spa software handles inventory
            and retail, not the precise log of every needle and every reaction.
          </p>
          <p className="text-[18px] leading-[1.55] md:text-[21px]">
            Charting is the hidden tax: the two or three minutes after every
            client, multiplied across a year. Hone is the first tool that is
            faster than paper instead of slower. It remembers what you did, runs
            your booking and calendar, and does it in the two-minute window
            between clients, because that&rsquo;s the only time you have.
          </p>
        </div>
      </div>
    </Reveal>
  );
}

/* How it works ─────────────────────────────────────────────────────────── */

const HOW_STEPS: ReadonlyArray<{
  numeral: string;
  title: string;
  body: string;
}> = [
  {
    numeral: "01",
    title: "Find your client and see their memory",
    body: "Type the first three letters. The cheat sheet appears with pricing, skin notes, allergies, what they tolerated last time, and the exact settings that worked.",
  },
  {
    numeral: "02",
    title: "Log this session",
    body: "Tap copy from last, edit what changed. Areas as chip-taps. Modes ordered like your machine. Common comments preset. One-tap.",
  },
  {
    numeral: "03",
    title: "Move on",
    body: "Saved. Treatment plan progress updates, total treatment time recalculates, audit history grows. You're already with the next client.",
  },
  {
    numeral: "04",
    title: "Or let them book themselves",
    body: "Share your booking link. Clients pick a service, pick a slot, confirm. You see it on your calendar. They get an email with the date and a one-click cancel.",
  },
];

function HowItWorks() {
  return (
    <Reveal as="section" className="px-6 py-20 md:px-12 md:py-28 lg:px-16">
      <div id="how-it-works" className="mx-auto max-w-[1400px]">
        <h2
          className="font-[var(--font-fraunces)] max-w-[800px] text-[28px] font-bold leading-[1.05] md:text-[36px]"
          style={{ letterSpacing: "-0.025em" }}
        >
          Fast, because charting shouldn&rsquo;t be slow.
        </h2>

        <div className="mt-12 grid grid-cols-1 gap-x-12 gap-y-12 md:grid-cols-2 lg:grid-cols-4">
          {HOW_STEPS.map((step) => (
            <div key={step.numeral}>
              <p
                className="font-[var(--font-fraunces)] mb-4 text-[72px] italic leading-none"
                style={{ color: PALETTE.rule }}
              >
                {step.numeral}
              </p>
              <h3 className="font-[var(--font-fraunces)] text-[22px] font-normal leading-[1.2]">
                {step.title}
              </h3>
              <p
                className="mt-3 text-[16px] leading-[1.6]"
                style={{ color: PALETTE.ink }}
              >
                {step.body}
              </p>
            </div>
          ))}
        </div>
      </div>
    </Reveal>
  );
}

/* Product preview, the cheat sheet (synthetic mock; real screenshot = PR B) */

function CheatSheetPreview() {
  return (
    <Reveal as="section" className="px-6 py-20 md:px-12 md:py-28 lg:px-16">
      <div className="mx-auto max-w-[1400px]">
        <EyebrowCaption>The client cheat sheet</EyebrowCaption>
        <h2
          className="font-[var(--font-fraunces)] mt-8 max-w-[820px] text-[28px] font-bold leading-[1.05] md:text-[36px]"
          style={{ letterSpacing: "-0.025em" }}
        >
          The memory practitioners actually need.
        </h2>
        <p className="mt-6 max-w-[580px] text-[18px] leading-[1.55] md:text-[21px]">
          One screen per client. Their full memory: pricing, skin notes,
          allergies, every session, every setting, every reaction. Nothing to
          dig for.
        </p>

        <div
          className="mt-12 p-8"
          style={{
            backgroundColor: PALETTE.card,
            border: `1px solid ${PALETTE.rule}`,
          }}
        >
          <CheatSheetMockup />
        </div>
        <p className="mt-3 text-[11px]" style={{ color: PALETTE.muted }}>
          Product preview with demo data, not a real client.
        </p>
      </div>
    </Reveal>
  );
}

function CheatSheetMockup() {
  return (
    <div className="flex flex-col">
      <p
        className="text-[12px] font-medium uppercase"
        style={{ letterSpacing: "0.2em", color: PALETTE.muted }}
      >
        ← Clients
      </p>

      <div className="mt-8 flex flex-wrap items-end justify-between gap-6">
        <div>
          <h3
            className="font-[var(--font-fraunces)] text-[36px] font-bold leading-[0.95]"
            style={{ letterSpacing: "-0.025em" }}
          >
            Demo Client Alpha
          </h3>
          <p className="mt-3 text-[14px]" style={{ color: PALETTE.muted }}>
            she/her  ·  Birthday Apr 3
          </p>
        </div>
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          className="px-[18px] py-[10px] text-[13px] font-medium"
          style={{
            backgroundColor: PALETTE.ink,
            color: PALETTE.bg,
          }}
        >
          + Log session
        </button>
      </div>

      <Hairline className="my-10" />

      <SectionLabel>Allergies</SectionLabel>
      <p className="mt-3 text-[15px]">
        Nickel  ·  Topical anesthetic (lidocaine, benzocaine)
      </p>

      <Hairline className="my-10" />

      <SectionLabel>Private warnings (practitioner-only)</SectionLabel>
      <p className="mt-3 text-[15px]" style={{ color: PALETTE.muted }}>
        Practitioner-only. Hidden on the public site.
      </p>

      <Hairline className="my-10" />

      <SectionLabel>Tags</SectionLabel>
      <div className="mt-4 flex flex-wrap gap-2">
        <Chip>Low pain tolerance</Chip>
        <Chip>Sensitive on chin</Chip>
        <Chip>Afternoon appointments preferred</Chip>
      </div>

      <Hairline className="my-10" />

      <div className="grid grid-cols-1 gap-10 md:grid-cols-2 md:gap-16">
        <div>
          <SectionLabel>Pricing</SectionLabel>
          <div className="mt-4 flex flex-col gap-3">
            <PriceRow label="Full face electrolysis (30 min)" amount="$45.00" />
            <PriceRow label="Underarm laser" amount="$60.00" />
          </div>
        </div>
        <div>
          <SectionLabel>Skin</SectionLabel>
          <div className="mt-4 flex flex-col gap-3">
            <SkinRow label="Fitzpatrick" value="III" />
            <SkinRow label="Notes" value="Prone to follicular erythema" />
          </div>
        </div>
      </div>

      <Hairline className="my-10" />

      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <SectionLabel>Health intake</SectionLabel>
          <span
            className="rounded-full px-2.5 py-0.5 text-[11px] font-medium uppercase"
            style={{
              letterSpacing: "0.1em",
              backgroundColor: "#E4EFE3",
              color: "#2B5A2B",
            }}
          >
            Reviewed
          </span>
          <span className="text-[14px]" style={{ color: PALETTE.muted }}>
            May 14, 2026  ·  11:08 PM
          </span>
        </div>
        <span
          className="text-[13px] font-medium"
          style={{ color: PALETTE.ink }}
        >
          View intake →
        </span>
      </div>

      <Hairline className="my-10" />

      <SectionLabel>Emergency contact</SectionLabel>
      <p className="mt-3 text-[15px]">
        Demo Contact
      </p>

      <Hairline className="my-10" />

      <h3 className="font-[var(--font-fraunces)] text-[20px] italic">
        Last session{" "}
        <span
          className="not-italic font-medium text-[12px] uppercase align-middle ml-2"
          style={{ letterSpacing: "0.2em", color: PALETTE.muted }}
        >
          Electrolysis · Demo Electrologist
        </span>
      </h3>

      <div className="mt-5">
        <p className="text-[18px] font-medium">Upper lip</p>
        <p className="mt-1 text-[14px]" style={{ color: PALETTE.muted }}>
          Thermolysis  ·  MeloFlash  ·  27.12 MHz  ·  Ballet · Gold · One-piece · F4
        </p>
        <p className="mt-1 text-[14px]" style={{ color: PALETTE.muted }}>
          120 hairs treated
        </p>
        <p className="font-[var(--font-fraunces)] mt-3 text-[16px] italic">
          Demo note only.
        </p>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="text-[12px] font-medium uppercase"
      style={{ letterSpacing: "0.2em", color: PALETTE.muted }}
    >
      {children}
    </p>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="rounded-full px-3 py-1 text-[13px]"
      style={{
        backgroundColor: PALETTE.bg,
        border: `1px solid ${PALETTE.rule}`,
        color: PALETTE.ink,
      }}
    >
      {children}
    </span>
  );
}

function PriceRow({ label, amount }: { label: string; amount: string }) {
  return (
    <div className="flex items-baseline justify-between gap-6 text-[15px]">
      <span>{label}</span>
      <span className="tabular-nums">{amount}</span>
    </div>
  );
}

function SkinRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-6 text-[15px]">
      <span style={{ color: PALETTE.muted }}>{label}</span>
      <span className="text-right">{value}</span>
    </div>
  );
}

/* Inside Hone: the four product pillars, consolidated into compact cards ── */

const INSIDE_CARDS: ReadonlyArray<{ title: string; bullets: ReadonlyArray<string> }> = [
  {
    title: "Chart faster",
    bullets: [
      "One-page charting: area, machine settings, probe, minutes, and the pass readings, one save",
      "Structured probe picker (brand, material, piece type, shank, size)",
      "Thermolysis, galvanic, and blend readings, mode-aware",
      "Pulse count, hairs treated, units of lye",
    ],
  },
  {
    title: "Plan the full treatment journey",
    bullets: [
      "Treatment plans with schedule stages",
      "Estimated visits and visit cadence",
      "Total treatment time logged versus estimated remaining",
      "New sessions link to the plan's area automatically",
    ],
  },
  {
    title: "Run booking and calendar",
    bullets: [
      "Public booking page on your studio link",
      "Services, availability, breaks, and blockouts",
      "Self-serve cancel and reschedule",
      "Email confirmations with a calendar file",
    ],
  },
  {
    title: "Keep your data portable",
    bullets: [
      "Export a ZIP of your studio any time",
      "Clients, sessions, charting, appointments, plans, and stages",
      "Private notes and warnings excluded from the general export",
    ],
  },
];

function InsideHone() {
  return (
    <Reveal as="section" className="px-6 py-20 md:px-12 md:py-28 lg:px-16">
      <div className="mx-auto max-w-[1400px]">
        <EyebrowCaption>Inside Hone</EyebrowCaption>
        <h2
          className="font-[var(--font-fraunces)] mt-8 max-w-[820px] text-[34px] font-bold leading-[1.02] md:text-[44px]"
          style={{ letterSpacing: "-0.03em" }}
        >
          From booking to charting, in one place.
        </h2>

        <div className="mt-12 grid grid-cols-1 gap-4 md:grid-cols-2">
          {INSIDE_CARDS.map((card) => (
            <div
              key={card.title}
              className="flex flex-col gap-4 p-8"
              style={{ border: `1px solid ${PALETTE.rule}` }}
            >
              <h3 className="font-[var(--font-fraunces)] text-[22px] font-normal leading-[1.2]">
                {card.title}
              </h3>
              <ul className="flex flex-col gap-2 text-[15px] leading-[1.55]">
                {card.bullets.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Coded product previews (illustrations with demo data, not
            screenshots). One per pillar; honest label on each card. */}
        <p
          className="mt-12 text-[11px] font-medium uppercase"
          style={{ letterSpacing: "0.18em", color: PALETTE.muted }}
        >
          A glimpse inside Hone · product preview, demo data
        </p>
        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
          <ChartingPreview />
          <PlanProgressPreview />
          <CalendarPreview />
        </div>
      </div>
    </Reveal>
  );
}

/* Built for the work: a prominent positioning lead + a tightened grid ───── */

const BUILT_FOR_ITEMS: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: "Client memory and private warnings",
    body: "Allergies, skin notes, intake, and practitioner-only personal notes and private warnings that never go out in a client-facing export.",
  },
  {
    title: "Birthday reminders",
    body: "See whose birthday is coming up this month, surfaced on the dashboard. A small touch that clients remember.",
  },
  {
    title: "Built for both modalities",
    body: "Electrolysis charting with probe, mode, pulses, intensity. Laser charting with zone, fluence, pulse width, treatment number.",
  },
  {
    title: "Works on what you have",
    body: "iPad in the treatment room. Laptop at the front desk. Phone for the solo practitioner. No app to install.",
  },
];

function BuiltForTheWork() {
  return (
    <Reveal as="section" className="px-6 py-20 md:px-12 md:py-28 lg:px-16">
      <div className="mx-auto max-w-[1400px]">
        <h2
          className="font-[var(--font-fraunces)] text-[28px] font-bold leading-[1.05] md:text-[36px]"
          style={{ letterSpacing: "-0.025em" }}
        >
          Built for the way you work.
        </h2>

        {/* Prominent positioning lead: the one differentiator that frames
            everything else. Heavier ink border so the eye lands here first. */}
        <div
          className="mt-10 p-8 md:p-10"
          style={{ border: `2px solid ${PALETTE.ink}` }}
        >
          <p
            className="text-[11px] font-medium uppercase"
            style={{ letterSpacing: "0.2em", color: PALETTE.muted }}
          >
            Designed for permanent hair removal
          </p>
          <p className="mt-4 max-w-[760px] text-[20px] leading-[1.4] md:text-[24px]">
            Electrolysis first, laser too. Probe sizes, pulse counts, modes, and
            treatment plans built around hair-by-hair work, not generic
            appointments.
          </p>
        </div>

        <div className="mt-12 grid grid-cols-1 gap-x-12 gap-y-12 md:grid-cols-2">
          {BUILT_FOR_ITEMS.map((item) => (
            <div key={item.title}>
              <h3 className="text-[18px] font-medium leading-[1.3]">
                {item.title}
              </h3>
              <p className="mt-3 text-[16px] leading-[1.6]">{item.body}</p>
            </div>
          ))}
        </div>
      </div>
    </Reveal>
  );
}

/* Trust line (measured) ────────────────────────────────────────────────── */

const TRUST_POINTS: ReadonlyArray<string> = [
  "Secure sign-in for every studio account.",
  "The public booking page is rate-limited to curb abuse.",
  "Personal notes and private warnings are practitioner-only and are left out of the general data export.",
  "You can export your full studio data any time.",
  "No card collection or payments unless you explicitly turn them on later.",
];

function TrustLine() {
  return (
    <Reveal as="section" className="px-6 py-20 md:px-12 md:py-28 lg:px-16">
      <div className="mx-auto max-w-[1400px]">
        <EyebrowCaption>Handled with care</EyebrowCaption>
        <h2
          className="font-[var(--font-fraunces)] mt-8 max-w-[820px] text-[26px] font-bold leading-[1.1] md:text-[32px]"
          style={{ letterSpacing: "-0.02em" }}
        >
          Your data, in plain terms.
        </h2>
        <ul className="mt-8 flex max-w-[680px] list-disc flex-col gap-3 pl-5 text-[16px] leading-[1.6]">
          {TRUST_POINTS.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>
      </div>
    </Reveal>
  );
}

/* Closing note (short; replaces the long essay) ────────────────────────── */

function ClosingNote() {
  return (
    <Reveal as="section" className="px-6 py-20 md:px-12 md:py-28 lg:px-16">
      <div className="mx-auto max-w-[680px]">
        <p className="font-[var(--font-fraunces)] text-[24px] italic leading-[1.3] md:text-[28px]">
          The first charting tool that is faster than paper, not slower.
        </p>
        <p className="mt-6 text-[18px] leading-[1.65] md:text-[21px]">
          If you run an electrolysis or laser clinic and want to be among the
          first to use it, get early access at the top of this page or see
          pricing.
        </p>
      </div>
    </Reveal>
  );
}
