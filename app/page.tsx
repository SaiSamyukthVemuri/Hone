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
      <EditorialObservation />
      <HowItWorks />
      <CheatSheetPreview />
      <BuiltForTheWork />
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
          Charting software for electrolysis and laser practitioners
        </EyebrowCaption>

        <h1
          className="font-[var(--font-fraunces)] mt-10 max-w-[980px] text-[56px] font-bold leading-[0.92] md:text-[92px]"
          style={{ letterSpacing: "-0.045em" }}
        >
          Software <em>for</em> the
          <br />
          two minute window
          <br />
          between clients.
        </h1>

        <p
          className="mt-10 max-w-[580px] text-[18px] leading-[1.55] md:text-[21px]"
          style={{ color: PALETTE.ink }}
        >
          Type a name. See last session&rsquo;s settings. Log this one. Move on.
          Built for the way electrolysis and laser practitioners actually chart.
        </p>
        <p
          className="mt-6 max-w-[580px] text-[18px] leading-[1.55] md:text-[21px]"
          style={{ color: PALETTE.ink }}
        >
          Booking, scheduling, and charting in one place. No more juggling tools.
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
            Hone is the first one built for you. Booking, scheduling,
            charting, and client management. One tool, designed for how you
            actually work.
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
    title: "Find your client",
    body: "Type the first three letters. The cheat sheet appears with pricing, skin notes, allergies, and the exact settings from last session.",
  },
  {
    numeral: "02",
    title: "Log this session",
    body: "Tap copy from last, edit what changed. Areas as chip-taps. Modes ordered like your machine. Common comments preset. One-tap.",
  },
  {
    numeral: "03",
    title: "Move on",
    body: "Saved. Treatment counts increment. Audit history grows. You're already with the next client.",
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
          className="font-[var(--font-fraunces)] mt-10 max-w-[720px] text-[40px] font-bold leading-[0.95] md:text-[56px]"
          style={{ letterSpacing: "-0.03em" }}
        >
          Everything you need,
          <br />
          where you need it.
        </h2>
        <p className="mt-8 max-w-[580px] text-[18px] leading-[1.55] md:text-[21px]">
          One screen per client. Pricing, skin notes, allergies, last
          session&rsquo;s exact settings, full treatment history. Nothing to
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
            she/her  ·  416 897 8711  ·  jane@example.com
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

      <div className="grid grid-cols-1 gap-10 md:grid-cols-2 md:gap-16">
        <div>
          <p
            className="text-[12px] font-medium uppercase"
            style={{ letterSpacing: "0.2em", color: PALETTE.muted }}
          >
            Pricing
          </p>
          <div className="mt-4 flex flex-col gap-3">
            <PriceRow label="Full face electrolysis (30 min)" amount="$45.00" />
            <PriceRow label="Underarm laser" amount="$60.00" />
          </div>
        </div>
        <div>
          <p
            className="text-[12px] font-medium uppercase"
            style={{ letterSpacing: "0.2em", color: PALETTE.muted }}
          >
            Skin
          </p>
          <div className="mt-4 flex flex-col gap-3">
            <SkinRow label="Fitzpatrick" value="III" />
            <SkinRow
              label="Notes"
              value="Sensitive on chin · prone to follicular erythema"
            />
          </div>
        </div>
      </div>

      <Hairline className="my-10" />

      <h3 className="font-[var(--font-fraunces)] text-[20px] italic">
        Last session{" "}
        <span
          className="not-italic font-medium text-[12px] uppercase align-middle ml-2"
          style={{ letterSpacing: "0.2em", color: PALETTE.muted }}
        >
          May 14 · Electrolysis · Sam
        </span>
      </h3>

      <div className="mt-5">
        <p className="text-[18px] font-medium">Chin</p>
        <p className="mt-1 text-[14px]" style={{ color: PALETTE.muted }}>
          F3 · Blend · Pulse count 2 · Intensity 40 · Duration 0.08s
        </p>
        <p className="font-[var(--font-fraunces)] mt-3 text-[16px] italic">
          Dehydrated follicles, hyperpigmentation. Client tolerated well.
        </p>
      </div>
    </div>
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
    title: "Areas as taps, not menus",
    body: "Upper lip, chin, full face, Brazilian. Visible at a glance, one tap to select.",
  },
  {
    title: "Match your machine",
    body: "Thermolysis, Blend, Galvanic, ordered the way your machine is. Probe sizes you actually use. Laser parameters that match what's on your screen.",
  },
  {
    title: "Pulse counts and probe lots",
    body: "Track exactly what was used on whom. Audit-ready when the health unit asks.",
  },
  {
    title: "Copy from last session",
    body: "Same client, same approach. Pre-fill, edit, save. Under five seconds.",
  },
  {
    title: "Built for both modalities",
    body: "Electrolysis charting with probe, mode, pulses, intensity. Laser charting with zone, fluence, pulse width, treatment number. One tool for studios that do both.",
  },
  {
    title: "Multi-practitioner studios",
    body: "Owner sees everything. Practitioners see the studio's clients and their own work.",
  },
  {
    title: "Your data, your studio",
    body: "Export anytime. Cancel anytime. Your client records are yours.",
  },
  {
    title: "Works on what you have",
    body: "iPad in the treatment room. Laptop at the front desk. Phone for the solo practitioner. No app to install.",
  },
  {
    title: "Book directly from your studio link",
    body: "Clients book themselves. Share hone.care/book/your-studio. They pick a service, pick a time, get an email. You get the calendar entry.",
  },
  {
    title: "Calendar that knows your hours",
    body: "Set Tuesday 10 to 6 once. Override one Wednesday for a long day. Block out vacation. Slots respect everything, automatically.",
  },
  {
    title: "Email confirmations that import to their calendar",
    body: "Every booking sends a confirmation with a calendar file. Apple, Google, Outlook. They click once, it's in their calendar.",
  },
  {
    title: "One-click cancellation",
    body: "Every confirmation email has a cancel link. Clients can cancel themselves. You get a notification. The slot opens up.",
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
            medical records. Salon and spa software handles inventory and
            retail. The chart that a practitioner actually keeps, the small
            precise log of every needle, every pulse, every setting, has
            lived on paper because the alternatives have been worse than
            paper.
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

