import { Reveal } from "./_components/Reveal";
import { WaitlistForm } from "./_components/WaitlistForm";
import { MarketingHeader } from "./_components/MarketingHeader";
import { MarketingFooter } from "./_components/MarketingFooter";
import {
  EyebrowCaption,
  Hairline,
} from "./_components/MarketingAtoms";
import { MARKETING_PALETTE as PALETTE } from "./_components/marketingNav";

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
      <OnePageCharting />
      <PlansAndProgress />
      <BookingAndCalendar />
      <DataExportAndBackup />
      <BuiltForTheWork />
      <TrustLine />
      <CaseForTryingIt />
      <MarketingFooter />
    </main>
  );
}

/* Hero ─────────────────────────────────────────────────────────────────── */

function Hero() {
  return (
    <Reveal
      as="section"
      className="px-6 pb-32 pt-24 md:px-12 md:pb-40 md:pt-32 lg:px-16"
    >
      <div className="mx-auto max-w-[1400px]">
        <EyebrowCaption>
          Practice software for electrolysis and laser
        </EyebrowCaption>

        <h1
          className="font-[var(--font-fraunces)] mt-10 max-w-[980px] text-[56px] font-bold leading-[0.92] md:text-[92px]"
          style={{ letterSpacing: "-0.045em" }}
        >
          Never wonder
          <br />
          what you did
          <br />
          last session.
        </h1>

        <p
          className="mt-10 max-w-[580px] text-[18px] leading-[1.55] md:text-[21px]"
          style={{ color: PALETTE.ink }}
        >
          Type a name. See exactly what worked last time: settings, areas, what
          they tolerated, what to avoid. Log this session in under a minute.
          Booking, calendar, treatment plans, and charting, all in one place
          built for electrolysis.
        </p>

        <div id="request-access" className="mt-[72px] max-w-[700px]">
          <EyebrowCaption>Request access</EyebrowCaption>
          <div className="mt-6">
            <WaitlistForm />
          </div>
          <div className="mt-12">
            <EyebrowCaption>
              Works on iPad, laptop, and phone
            </EyebrowCaption>
          </div>
        </div>
      </div>
    </Reveal>
  );
}

/* Practice memory positioning ──────────────────────────────────────────── */

function PracticeMemory() {
  return (
    <Reveal as="section" className="px-6 py-24 md:px-12 md:py-32 lg:px-16">
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
          across every session, for as long as you treat them.
        </p>
        <p className="mt-6 max-w-[680px] text-[18px] leading-[1.65] md:text-[21px]">
          In practice that means electrolysis software for booking, treatment
          plans, and clinical charting, built around that memory rather than
          bolted on beside it.
        </p>
      </div>
    </Reveal>
  );
}

/* Editorial observation ────────────────────────────────────────────────── */

function EditorialObservation() {
  return (
    <Reveal as="section" className="px-6 py-32 md:px-12 md:py-48 lg:px-16">
      <div className="mx-auto grid max-w-[1400px] grid-cols-1 gap-x-16 gap-y-12 md:grid-cols-12">
        <div className="md:col-span-7">
          <h2
            className="font-[var(--font-fraunces)] text-[56px] font-bold leading-[0.95] md:text-[96px]"
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
            pulse counts. Medical records are built for doctors and dentists,
            not practitioners working hair by hair. Spa software handles
            inventory and retail, not the precise log of every needle and
            every reaction. The chart you actually keep has lived on paper
            because the digital options have all been built for someone else.
          </p>
          <p className="text-[18px] leading-[1.55] md:text-[21px]">
            Hone is the first one built for you. It remembers what you did
            with each client, what worked, what to avoid. It runs your booking
            and calendar so you don&rsquo;t juggle tools. And it does this in
            the two-minute window between clients, because that&rsquo;s the
            only time you actually have.
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
    <Reveal as="section" className="px-6 py-32 md:px-12 md:py-48 lg:px-16">
      <div id="how-it-works" className="mx-auto max-w-[1400px]">
        <h2
          className="font-[var(--font-fraunces)] max-w-[800px] text-[40px] font-bold leading-[0.95] md:text-[56px]"
          style={{ letterSpacing: "-0.03em" }}
        >
          Hone is fast
          <br />
          because charting
          <br />
          shouldn&rsquo;t be slow.
        </h2>

        <div className="mt-20 grid grid-cols-1 gap-x-12 gap-y-16 md:grid-cols-2 lg:grid-cols-4">
          {HOW_STEPS.map((step) => (
            <div key={step.numeral}>
              <p
                className="font-[var(--font-fraunces)] mb-6 text-[120px] italic leading-none"
                style={{ color: PALETTE.rule }}
              >
                {step.numeral}
              </p>
              <h3 className="font-[var(--font-fraunces)] text-[24px] font-normal leading-[1.2]">
                {step.title}
              </h3>
              <p
                className="mt-3 text-[16px] leading-[1.65]"
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

/* Product preview, the cheat sheet ─────────────────────────────────────── */

function CheatSheetPreview() {
  return (
    <Reveal as="section" className="px-6 py-32 md:px-12 md:py-48 lg:px-16">
      <div className="mx-auto max-w-[1400px]">
        <EyebrowCaption>The client cheat sheet</EyebrowCaption>
        <h2
          className="font-[var(--font-fraunces)] mt-10 max-w-[820px] text-[40px] font-bold leading-[0.95] md:text-[56px]"
          style={{ letterSpacing: "-0.03em" }}
        >
          The memory practitioners
          <br />
          actually need.
        </h2>
        <p className="mt-8 max-w-[580px] text-[18px] leading-[1.55] md:text-[21px]">
          One screen per client. Their full memory: pricing, skin notes,
          allergies, every session, every setting, every reaction. Nothing to
          dig for.
        </p>

        <div
          className="mt-20 p-8"
          style={{
            backgroundColor: PALETTE.card,
            border: `1px solid ${PALETTE.rule}`,
          }}
        >
          <CheatSheetMockup />
        </div>
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
            Jane Doe
          </h3>
          <p className="mt-3 text-[14px]" style={{ color: PALETTE.muted }}>
            she/her  ·  416 897 8711  ·  jane@example.com  ·  Birthday Apr 3
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
      <p className="mt-3 text-[15px]">
        Tends to run about ten minutes late. Confirm the day before.
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
        Alex Doe (sister)  ·  416 555 0192
      </p>

      <Hairline className="my-10" />

      <h3 className="font-[var(--font-fraunces)] text-[20px] italic">
        Last session{" "}
        <span
          className="not-italic font-medium text-[12px] uppercase align-middle ml-2"
          style={{ letterSpacing: "0.2em", color: PALETTE.muted }}
        >
          May 14 · Electrolysis · Maya
        </span>
      </h3>

      <div className="mt-5">
        <p className="text-[18px] font-medium">Chin · Upper lip</p>
        <p className="mt-1 text-[14px]" style={{ color: PALETTE.muted }}>
          Thermolysis  ·  Microflash  ·  13.56 MHz  ·  Stainless steel regular  ·  F3
        </p>
        <p className="mt-1 text-[14px]" style={{ color: PALETTE.muted }}>
          Pulse count 2  ·  Intensity 40  ·  Duration 0.08s  ·  15 hairs treated
        </p>
        <p className="font-[var(--font-fraunces)] mt-3 text-[16px] italic">
          Dehydrated follicles, hyperpigmentation. Client tolerated well.
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

/* Built for the work, 10 item grid ─────────────────────────────────────── */

const BUILT_FOR_ITEMS: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: "Designed for permanent hair removal",
    body: "Electrolysis first, laser too. Probe sizes, pulse counts, modes, and treatment plans built around hair-by-hair work, not generic appointments.",
  },
  {
    title: "One-page electrolysis charting",
    body: "Treatment area, machine settings, probe, minutes, and the pass readings on a single screen. One save, no second form.",
  },
  {
    title: "Structured probe picker",
    body: "Pick brand, material, piece type, shank, and size from a real catalog instead of retyping it. Consistent every session.",
  },
  {
    title: "Blend, galvanic, and thermolysis fields",
    body: "Mode-aware readings: intensity and duration, galvanic mA and units of lye, pulse count, hairs treated. The numbers you actually record.",
  },
  {
    title: "Treatment plans and schedules",
    body: "Lay out the stages: how often, how long per visit, for how many weeks. Hone estimates the visit count from the schedule.",
  },
  {
    title: "Total treatment time and progress",
    body: "See the time logged against a plan and what's estimated to remain, so you and the client both know where things stand.",
  },
  {
    title: "Client memory and private warnings",
    body: "Allergies, skin notes, intake, and practitioner-only personal notes and private warnings that never go out in a client-facing export.",
  },
  {
    title: "Birthday reminders",
    body: "See whose birthday is coming up this month, surfaced on the dashboard. A small touch that clients remember.",
  },
  {
    title: "Public booking and calendar",
    body: "Share your studio link. Clients pick a service and a slot. Your calendar respects services, hours, breaks, and blockouts.",
  },
  {
    title: "Self-serve cancel and reschedule",
    body: "Every confirmation has a link to cancel or reschedule. Clients handle it themselves, you get notified, the slot reopens.",
  },
  {
    title: "Data export and backup",
    body: "Download a ZIP of clients, sessions, charting, appointments, and treatment plans any time. Your records are yours.",
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
    <Reveal as="section" className="px-6 py-32 md:px-12 md:py-48 lg:px-16">
      <div className="mx-auto max-w-[1400px]">
        <h2
          className="font-[var(--font-fraunces)] text-[40px] font-bold leading-[0.95] md:text-[56px]"
          style={{ letterSpacing: "-0.03em" }}
        >
          Designed by watching
          <br />a practitioner work.
        </h2>

        <div className="mt-20 grid grid-cols-1 gap-x-12 gap-y-14 md:grid-cols-2">
          {BUILT_FOR_ITEMS.map((item, i) => (
            <div key={item.title}>
              <p
                className="text-[11px] font-medium uppercase"
                style={{ letterSpacing: "0.18em", color: PALETTE.muted }}
              >
                {String(i + 1).padStart(2, "0")}.
              </p>
              <h3 className="mt-4 text-[18px] font-medium leading-[1.3]">
                {item.title}
              </h3>
              <p className="mt-3 text-[16px] leading-[1.65]">{item.body}</p>
            </div>
          ))}
        </div>
      </div>
    </Reveal>
  );
}

/* The case for trying it ───────────────────────────────────────────────── */

function CaseForTryingIt() {
  return (
    <Reveal as="section" className="px-6 py-32 md:px-12 md:py-48 lg:px-16">
      <div className="mx-auto max-w-[1400px]">
        <div className="max-w-[680px]">
          <p className="text-[18px] leading-[1.65] md:text-[21px]">
            <span
              className="font-[var(--font-fraunces)] float-left mr-3 mt-1 text-[88px] italic leading-[0.85]"
              style={{ color: PALETTE.ink }}
              aria-hidden="true"
            >
              C
            </span>
            <span>harting is the hidden tax</span> of running an electrolysis
            or laser clinic. Between every client there are two or three
            minutes where you write down what just happened. Probe size,
            intensity, mode, duration, area, comments. Or zone, fluence,
            pulse width, treatment number, observations. Multiply that across
            a day. Multiply across a year. Hours of your life every week
            that you cannot bill for.
          </p>
          <p className="mt-8 text-[18px] leading-[1.65] md:text-[21px]">
            Software has not fixed this because nobody has built software for
            it. Booking platforms handle bookings. Medical records handle
            diagnoses. Salon software handles inventory. None of them remember
            what you did with each client. None of them treat treatment memory
            as the product. So the chart that a practitioner actually keeps,
            the small precise log of every needle, every pulse, every setting,
            has lived on paper. Because the digital alternatives have been
            worse than paper.
          </p>
          <p className="mt-8 text-[18px] leading-[1.65] md:text-[21px]">
            Hone is the first alternative that is not worse than paper. It is
            faster than writing. It remembers everything. It hands you the
            last session in the time it takes to glance at a clipboard. It
            does this without asking you to learn a new way to chart, change
            your machine, or memorize anyone&rsquo;s interface.
          </p>
          <p className="mt-8 text-[18px] leading-[1.65] md:text-[21px]">
            And because charting alone isn&rsquo;t enough, Hone also runs
            your bookings. Your clients pick their own appointment time on
            your studio&rsquo;s booking link. Confirmations send themselves.
            Cancellations handle themselves. The calendar is one tap away.
            You stop juggling tools and start running your studio from one
            place.
          </p>
          <p className="mt-8 text-[18px] leading-[1.65] md:text-[21px]">
            If you run a clinic and want to be among the first to use it,
            request access at the top of this page or see pricing below.
          </p>
        </div>
      </div>
    </Reveal>
  );
}

/* One-page charting ────────────────────────────────────────────────────── */

const CHARTING_FIELDS: ReadonlyArray<string> = [
  "Treatment area",
  "Machine frequency",
  "Mode and modality",
  "Structured probe",
  "Minutes",
  "Thermolysis / galvanic / blend readings",
  "Pulse count",
  "Hairs treated",
  "Units of lye",
  "Notes",
];

function OnePageCharting() {
  return (
    <Reveal as="section" className="px-6 py-32 md:px-12 md:py-48 lg:px-16">
      <div className="mx-auto max-w-[1400px]">
        <EyebrowCaption>One-page charting</EyebrowCaption>
        <h2
          className="font-[var(--font-fraunces)] mt-10 max-w-[820px] text-[40px] font-bold leading-[0.95] md:text-[56px]"
          style={{ letterSpacing: "-0.03em" }}
        >
          Chart a full session
          <br />
          on one screen.
        </h2>
        <p className="mt-8 max-w-[640px] text-[18px] leading-[1.55] md:text-[21px]">
          Treatment area, machine frequency, mode and modality, probe, and
          minutes, then the readings for the pass, captured on a single page.
          One save. No second form opening after you start. The probe is a
          structured picker, and the readings follow the mode: thermolysis,
          galvanic, or blend.
        </p>
        <div className="mt-12 flex flex-wrap gap-2">
          {CHARTING_FIELDS.map((field) => (
            <Chip key={field}>{field}</Chip>
          ))}
        </div>
      </div>
    </Reveal>
  );
}

/* Treatment plans and progress ─────────────────────────────────────────── */

const PLAN_FIELDS: ReadonlyArray<string> = [
  "Treatment plans",
  "Schedule stages",
  "Estimated visits",
  "Visit cadence",
  "Actual logged time",
  "Estimated remaining",
  "Area linked to the plan",
];

function PlansAndProgress() {
  return (
    <Reveal as="section" className="px-6 py-32 md:px-12 md:py-48 lg:px-16">
      <div className="mx-auto max-w-[1400px]">
        <EyebrowCaption>Plans and progress</EyebrowCaption>
        <h2
          className="font-[var(--font-fraunces)] mt-10 max-w-[820px] text-[40px] font-bold leading-[0.95] md:text-[56px]"
          style={{ letterSpacing: "-0.03em" }}
        >
          See where each client
          <br />
          is headed.
        </h2>
        <p className="mt-8 max-w-[640px] text-[18px] leading-[1.55] md:text-[21px]">
          Build a treatment plan from schedule stages: how often, how long per
          visit, for how many weeks. Hone estimates the visits from the
          schedule, tracks the time you have actually logged against the plan,
          and shows what is estimated to remain. New sessions link to the plan
          area automatically, so progress keeps itself current.
        </p>
        <div className="mt-12 flex flex-wrap gap-2">
          {PLAN_FIELDS.map((field) => (
            <Chip key={field}>{field}</Chip>
          ))}
        </div>
      </div>
    </Reveal>
  );
}

/* Booking and calendar ─────────────────────────────────────────────────── */

function BookingAndCalendar() {
  return (
    <Reveal as="section" className="px-6 py-32 md:px-12 md:py-48 lg:px-16">
      <div className="mx-auto max-w-[1400px]">
        <EyebrowCaption>Booking and calendar</EyebrowCaption>
        <h2
          className="font-[var(--font-fraunces)] mt-10 max-w-[820px] text-[40px] font-bold leading-[0.95] md:text-[56px]"
          style={{ letterSpacing: "-0.03em" }}
        >
          Run your schedule
          <br />
          from one place.
        </h2>
        <p className="mt-8 max-w-[640px] text-[18px] leading-[1.55] md:text-[21px]">
          Share your studio booking link. Clients pick a service and a time,
          get a confirmation with a calendar file, and can cancel or reschedule
          themselves. Your calendar respects your services, hours, breaks, and
          blockouts, so the slots offered are always slots you can actually
          work.
        </p>
      </div>
    </Reveal>
  );
}

/* Data export and backup ───────────────────────────────────────────────── */

function DataExportAndBackup() {
  return (
    <Reveal as="section" className="px-6 py-32 md:px-12 md:py-48 lg:px-16">
      <div className="mx-auto max-w-[1400px]">
        <EyebrowCaption>Your data, exportable</EyebrowCaption>
        <h2
          className="font-[var(--font-fraunces)] mt-10 max-w-[820px] text-[40px] font-bold leading-[0.95] md:text-[56px]"
          style={{ letterSpacing: "-0.03em" }}
        >
          Download a backup
          <br />
          any time.
        </h2>
        <p className="mt-8 max-w-[640px] text-[18px] leading-[1.55] md:text-[21px]">
          Export a ZIP of your studio: clients, sessions, electrolysis and
          laser charting, appointments, treatment plans, and schedule stages.
          Personal notes and private warnings are intentionally left out of
          this general export. If you ever leave, your records leave with you.
        </p>
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
    <Reveal as="section" className="px-6 py-32 md:px-12 md:py-48 lg:px-16">
      <div className="mx-auto max-w-[1400px]">
        <EyebrowCaption>Handled with care</EyebrowCaption>
        <h2
          className="font-[var(--font-fraunces)] mt-10 max-w-[820px] text-[40px] font-bold leading-[0.95] md:text-[56px]"
          style={{ letterSpacing: "-0.03em" }}
        >
          Your data,
          <br />
          in plain terms.
        </h2>
        <ul className="mt-10 flex max-w-[680px] list-disc flex-col gap-3 pl-5 text-[16px] leading-[1.6]">
          {TRUST_POINTS.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>
      </div>
    </Reveal>
  );
}

