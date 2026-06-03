import Link from "next/link";
import { Reveal } from "./_components/Reveal";
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

// Public marketing homepage. Rewritten as a 9-section buyer path
// (Hero, How Hone fits, What generic booking misses, Product preview,
// Features, Trust, Pilot, Pricing teaser, Final CTA). Primary CTA
// across every page is "Book a 15-minute walkthrough" and routes to
// /demo. Secondary CTA points to the in-page product preview anchor.
// The previous waitlist email form has been removed from the hero on
// purpose: the primary action is to book a walkthrough, not leave an
// email; the WaitlistForm component and its server action are
// preserved for possible future reuse.
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
      <HowHoneFits />
      <WhatGenericMisses />
      <ProductPreviewSection />
      <FeaturesByWorkflow />
      <TrustSection />
      <PilotSection />
      <PricingTeaser />
      <FinalCTA />
      <MarketingFooter />
    </main>
  );
}

/* Section: Hero ────────────────────────────────────────────────────────── */

function Hero() {
  return (
    <Reveal
      as="section"
      className="px-6 pb-24 pt-20 md:px-12 md:pb-28 md:pt-24 lg:px-16"
    >
      <div className="mx-auto max-w-[1400px]">
        <EyebrowCaption>
          Electrolysis practice software. Laser support included.
        </EyebrowCaption>

        <h1
          className="font-[var(--font-fraunces)] mt-10 max-w-[1100px] text-[52px] font-bold leading-[0.96] md:text-[88px]"
          style={{ letterSpacing: "-0.045em" }}
        >
          Electrolysis practice software that remembers the treatment details.
        </h1>

        <p
          className="mt-10 max-w-[680px] text-[18px] leading-[1.55] md:text-[21px]"
          style={{ color: PALETTE.ink }}
        >
          Booking, intake, treatment plans, session charting, client history,
          and postcare in one calm workflow built for permanent hair removal
          studios.
        </p>

        {/* Two consistent CTAs. Primary is a real link to /demo where
            the walkthrough form lives. Secondary jumps to the in-page
            charting workflow anchor below the fold. */}
        <div className="mt-12 flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-5">
          <PrimaryCta href="/demo">Book a 15-minute walkthrough</PrimaryCta>
          <SecondaryCta href="#charting-workflow">
            See the charting workflow
          </SecondaryCta>
        </div>

        <p
          className="mt-8 max-w-[640px] text-[14px] leading-[1.6]"
          style={{ color: PALETTE.muted }}
        >
          Built with independent electrolysis studios. Early pilot
          onboarding is limited so each studio gets founder-led setup.
        </p>
      </div>
    </Reveal>
  );
}

/* Section: How Hone fits into your appointment ───────────────────────── */

const FIT_STEPS: ReadonlyArray<{ kicker: string; title: string; body: string }> = [
  {
    kicker: "Before the appointment",
    title: "Client books. Intake lands attached.",
    body: "The client books online from your studio link, fills the health intake, and the appointment shows up on your calendar with the intake response attached.",
  },
  {
    kicker: "During the session",
    title: "Open the client. Chart what changed.",
    body: "The cheat sheet shows last settings, what they tolerated, what to avoid, and the active treatment plan. Chart what changed on one screen, including probe, mode, intensity, and reaction.",
  },
  {
    kicker: "After the session",
    title: "Save. Plan updates. Send postcare.",
    body: "Treatment plan progress and total treatment time recalculate automatically. Send postcare with one click. You are already with the next client.",
  },
];

function HowHoneFits() {
  return (
    <Reveal as="section" className="px-6 py-20 md:px-12 md:py-28 lg:px-16">
      <div className="mx-auto max-w-[1400px]">
        <EyebrowCaption>How Hone fits into your appointment</EyebrowCaption>
        <h2
          className="font-[var(--font-fraunces)] mt-8 max-w-[820px] text-[32px] font-bold leading-[1.05] md:text-[44px]"
          style={{ letterSpacing: "-0.03em" }}
        >
          One calm flow, before, during, and after.
        </h2>

        <div className="mt-12 grid grid-cols-1 gap-x-10 gap-y-12 md:grid-cols-3">
          {FIT_STEPS.map((s) => (
            <div key={s.kicker} className="flex flex-col">
              <p
                className="text-[11px] font-medium uppercase"
                style={{ letterSpacing: "0.2em", color: PALETTE.muted }}
              >
                {s.kicker}
              </p>
              <h3 className="font-[var(--font-fraunces)] mt-3 text-[22px] font-normal leading-[1.25]">
                {s.title}
              </h3>
              <p className="mt-3 text-[16px] leading-[1.6]">{s.body}</p>
            </div>
          ))}
        </div>
      </div>
    </Reveal>
  );
}

/* Section: The part generic booking tools miss ─────────────────────────── */

const ELECTROLYSIS_DETAILS: ReadonlyArray<string> = [
  "Treatment area, hair by hair",
  "Modality: thermolysis, blend, galvanic, or laser",
  "Probe brand, material, piece type, shank, and size",
  "Timing and intensity settings, mode-aware",
  "Reaction and tolerance notes from the chair",
  "Contraindication and caution notes that follow the client",
  "Progress over time, not just the last visit",
  "Next-session instructions for your future self",
];

function WhatGenericMisses() {
  return (
    <Reveal as="section" className="px-6 py-20 md:px-12 md:py-28 lg:px-16">
      <div className="mx-auto grid max-w-[1400px] grid-cols-1 gap-x-16 gap-y-10 md:grid-cols-12">
        <div className="md:col-span-6">
          <EyebrowCaption>Built for the work, not just the calendar</EyebrowCaption>
          <h2
            className="font-[var(--font-fraunces)] mt-8 text-[34px] font-bold leading-[1.05] md:text-[48px]"
            style={{ letterSpacing: "-0.03em" }}
          >
            Never wonder what you did last session.
          </h2>
          <p className="mt-6 max-w-[520px] text-[17px] leading-[1.65] md:text-[19px]">
            Generic booking and scheduling tools handle appointments. They
            do not remember what you did to a client&rsquo;s chin last week,
            what intensity setting worked, what probe you liked, or what you
            planned to try next.
          </p>
          <p className="mt-5 max-w-[520px] text-[17px] leading-[1.65] md:text-[19px]">
            Electrolysis is detail work. Hone keeps those details close so
            every appointment starts with the right context.
          </p>
        </div>
        <div className="md:col-span-6">
          <ul className="flex flex-col gap-3 text-[16px] leading-[1.55]">
            {ELECTROLYSIS_DETAILS.map((d) => (
              <li
                key={d}
                className="flex items-baseline gap-3 border-b pb-3"
                style={{ borderColor: PALETTE.rule }}
              >
                <span
                  aria-hidden
                  className="text-[12px]"
                  style={{ color: PALETTE.muted }}
                >
                  ·
                </span>
                <span>{d}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Reveal>
  );
}

/* Section: Product preview ─────────────────────────────────────────────── */

function ProductPreviewSection() {
  return (
    <Reveal
      as="section"
      id="charting-workflow"
      className="scroll-mt-24 px-6 py-20 md:px-12 md:py-28 lg:px-16"
    >
      <div className="mx-auto max-w-[1400px]">
        <EyebrowCaption>A glimpse inside Hone</EyebrowCaption>
        <h2
          className="font-[var(--font-fraunces)] mt-8 max-w-[820px] text-[32px] font-bold leading-[1.05] md:text-[44px]"
          style={{ letterSpacing: "-0.03em" }}
        >
          What one client looks like in Hone.
        </h2>
        <p className="mt-5 max-w-[640px] text-[17px] leading-[1.65] md:text-[19px]">
          Realistic anonymized example. No real client data. The cheat
          sheet, treatment plan, and last-session readings show in one
          place, the way an electrologist actually scans before a chair
          appointment.
        </p>

        <div
          className="mt-12 p-6 md:p-10"
          style={{
            backgroundColor: PALETTE.card,
            border: `1px solid ${PALETTE.rule}`,
          }}
        >
          <CheatSheetMockup />
        </div>
        <p className="mt-3 text-[11px]" style={{ color: PALETTE.muted }}>
          Product preview with demo data.
        </p>

        {/* Three smaller product previews so the reader sees more
            than one screen. ChartingPreview / PlanProgressPreview /
            CalendarPreview are coded illustrations in
            ProductPreview.tsx with anonymized demo values inside; the
            visitor-facing disclaimer above ("Product preview with
            anonymized example data. Initials only.") covers both this
            cluster and the cheat sheet, so we do not repeat a
            screenshots-vs-illustrations caption here. */}
        <div className="mt-12 grid grid-cols-1 gap-4 md:grid-cols-3">
          <ChartingPreview />
          <PlanProgressPreview />
          <CalendarPreview />
        </div>
      </div>
    </Reveal>
  );
}

// Anonymized client cheat sheet mockup. Realistic enough to read like
// a working studio (probe, mode, area, plan progress, cautions) but
// the client is initials only, has no DOB, no contact, no address.
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
            Maya R.
          </h3>
          <p className="mt-3 text-[14px]" style={{ color: PALETTE.muted }}>
            she/her  ·  Pronouns saved on profile
          </p>
        </div>
        <span
          className="px-[18px] py-[10px] text-[13px] font-medium"
          aria-hidden
          style={{
            backgroundColor: PALETTE.ink,
            color: PALETTE.bg,
          }}
        >
          + Log session
        </span>
      </div>

      <Hairline className="my-10" />

      <SectionLabel>Cautions and allergies</SectionLabel>
      <p className="mt-3 text-[15px]">
        Nickel  ·  Topical anesthetic (lidocaine, benzocaine)
      </p>

      <Hairline className="my-10" />

      <SectionLabel>Practitioner-only notes</SectionLabel>
      <p className="mt-3 text-[15px]" style={{ color: PALETTE.muted }}>
        Low pain tolerance. Sensitive on chin. Prefers afternoon sessions.
        Practitioner-only; never visible to the client.
      </p>

      <Hairline className="my-10" />

      <div className="grid grid-cols-1 gap-10 md:grid-cols-2 md:gap-16">
        <div>
          <SectionLabel>Treatment plan</SectionLabel>
          <div className="mt-4 flex flex-col gap-3 text-[15px]">
            <PlanRow label="Area" value="Upper lip and chin" />
            <PlanRow label="Stage" value="Clearing, session 7 of 12" />
            <PlanRow label="Logged" value="2h 15m" />
            <PlanRow label="Est. remaining" value="~6h" />
          </div>
        </div>
        <div>
          <SectionLabel>Skin</SectionLabel>
          <div className="mt-4 flex flex-col gap-3 text-[15px]">
            <PlanRow label="Fitzpatrick" value="III" />
            <PlanRow label="Notes" value="Prone to follicular erythema" />
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
        </div>
        <span
          className="text-[13px] font-medium"
          style={{ color: PALETTE.ink }}
        >
          View intake →
        </span>
      </div>

      <Hairline className="my-10" />

      <h3 className="font-[var(--font-fraunces)] text-[20px] italic">
        Last session{" "}
        <span
          className="not-italic font-medium text-[12px] uppercase align-middle ml-2"
          style={{ letterSpacing: "0.2em", color: PALETTE.muted }}
        >
          Electrolysis
        </span>
      </h3>

      <div className="mt-5">
        <p className="text-[18px] font-medium">Upper lip</p>
        <p className="mt-1 text-[14px]" style={{ color: PALETTE.muted }}>
          Thermolysis  ·  27.12 MHz  ·  Ballet · Gold · One-piece · F2
        </p>
        <p className="mt-1 text-[14px]" style={{ color: PALETTE.muted }}>
          120 hairs treated  ·  cleared, mild redness, settled fast
        </p>
        <p className="font-[var(--font-fraunces)] mt-3 text-[16px] italic">
          Postcare sent same day.
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

function PlanRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-6">
      <span style={{ color: PALETTE.muted }}>{label}</span>
      <span className="text-right">{value}</span>
    </div>
  );
}

/* Section: Features grouped by practitioner workflow ────────────────── */

const FEATURE_GROUPS: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: "Bookings and reminders",
    body: "Public booking page on your studio link. Services, availability, breaks, blockouts. Email confirmations with a calendar file. Self-serve cancel and reschedule.",
  },
  {
    title: "Intake and consent",
    body: "Health intake link sent with every booking. Review responses in the practitioner view. Reissue intake before a new chapter of treatment.",
  },
  {
    title: "Treatment plans",
    body: "Plans with schedule stages (clearing, control, maintenance). Estimated visits, cadence, total treatment time logged versus remaining.",
  },
  {
    title: "Session charting",
    body: "One-page charting per area. Probe brand, material, piece type, shank, size. Thermolysis, blend, and galvanic readings mode-aware. Pulse count, hairs treated.",
  },
  {
    title: "Client history",
    body: "Cheat sheet per client. Cautions, intake, every session, every reading, every reaction. Tags and pronouns. Skin and Fitzpatrick on the same screen.",
  },
  {
    title: "Postcare and follow-up",
    body: "Write postcare once in your voice. Send manually per appointment. Optional review-prompt wording. Never auto-sent.",
  },
  {
    title: "Cautions and private warnings",
    body: "Practitioner-only personal notes and private warnings. Visible in the cheat sheet, never in a client-facing export.",
  },
  {
    title: "Export and ownership",
    body: "Export a ZIP of your studio any time. Clients, sessions, charting, appointments, plans, stages. Private notes excluded from the general export.",
  },
];

function FeaturesByWorkflow() {
  return (
    <Reveal as="section" className="px-6 py-20 md:px-12 md:py-28 lg:px-16">
      <div className="mx-auto max-w-[1400px]">
        <EyebrowCaption>What is inside Hone</EyebrowCaption>
        <h2
          className="font-[var(--font-fraunces)] mt-8 max-w-[820px] text-[32px] font-bold leading-[1.05] md:text-[44px]"
          style={{ letterSpacing: "-0.03em" }}
        >
          Built around how an electrologist actually works a session.
        </h2>

        <div className="mt-12 grid grid-cols-1 gap-x-10 gap-y-10 md:grid-cols-2 lg:grid-cols-4">
          {FEATURE_GROUPS.map((f) => (
            <div key={f.title} className="flex flex-col">
              <h3 className="font-[var(--font-fraunces)] text-[18px] font-normal leading-[1.25]">
                {f.title}
              </h3>
              <p className="mt-3 text-[15px] leading-[1.6]">{f.body}</p>
            </div>
          ))}
        </div>
      </div>
    </Reveal>
  );
}

/* Section: Trust ───────────────────────────────────────────────────────── */

const TRUST_POINTS: ReadonlyArray<{ headline: string; body: string }> = [
  {
    headline: "Your client records stay yours.",
    body: "Export the full history of your studio at any time. If you cancel, your data goes with you.",
  },
  {
    headline: "Hone does not sell client data.",
    body: "Not to advertisers, not to anyone. The privacy policy spells this out in plain English.",
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
    headline: "Practitioner-only notes stay private.",
    body: "Personal notes and private warnings are practitioner-only and excluded from the general export.",
  },
  {
    headline: "Secure sign in. Studio data is isolated.",
    body: "Magic link or Google sign in via Supabase Auth. Row-level security keeps each studio's data scoped to its own studio.",
  },
];

function TrustSection() {
  return (
    <Reveal as="section" className="px-6 py-20 md:px-12 md:py-28 lg:px-16">
      <div className="mx-auto max-w-[1400px]">
        <EyebrowCaption>How your data is handled</EyebrowCaption>
        <h2
          className="font-[var(--font-fraunces)] mt-8 max-w-[820px] text-[32px] font-bold leading-[1.05] md:text-[44px]"
          style={{ letterSpacing: "-0.03em" }}
        >
          Plain English, before anything else.
        </h2>

        <div className="mt-12 grid grid-cols-1 gap-x-12 gap-y-10 md:grid-cols-2">
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
      </div>
    </Reveal>
  );
}

/* Section: Pilot ───────────────────────────────────────────────────────── */

function PilotSection() {
  return (
    <Reveal as="section" className="px-6 py-20 md:px-12 md:py-28 lg:px-16">
      <div className="mx-auto max-w-[1400px]">
        <EyebrowCaption>Pilot</EyebrowCaption>
        <h2
          className="font-[var(--font-fraunces)] mt-8 max-w-[820px] text-[32px] font-bold leading-[1.05] md:text-[44px]"
          style={{ letterSpacing: "-0.03em" }}
        >
          Built with working electrologists.
        </h2>
        <p className="mt-6 max-w-[680px] text-[18px] leading-[1.65] md:text-[21px]">
          Hone is being shaped with independent electrolysis studios before
          broader release. The early pilot is intentionally small so the
          workflow stays practical, fast, and practitioner-led. Founder-led
          setup. No agency, no implementation team, no slide deck.
        </p>
      </div>
    </Reveal>
  );
}

/* Section: Pricing teaser ──────────────────────────────────────────────── */

function PricingTeaser() {
  return (
    <Reveal as="section" className="px-6 py-20 md:px-12 md:py-28 lg:px-16">
      <div className="mx-auto max-w-[1400px]">
        <EyebrowCaption>Founding pilot pricing</EyebrowCaption>
        <h2
          className="font-[var(--font-fraunces)] mt-8 max-w-[820px] text-[32px] font-bold leading-[1.05] md:text-[44px]"
          style={{ letterSpacing: "-0.03em" }}
        >
          One price for the whole workflow.
        </h2>

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
            <p className="mt-4 text-[15px] leading-[1.6]" style={{ color: PALETTE.muted }}>
              Founding pilot pricing while we onboard the first wave of
              studios. Regular pricing may increase after early access.
              Cancel anytime.
            </p>
          </div>
          <div className="md:col-span-7">
            <p className="text-[17px] leading-[1.65]">
              Booking, intake, treatment plans, session charting, client
              history, and postcare. Founder-led setup and onboarding.
              Full data export any time.
            </p>
            <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
              <PrimaryCta href="/demo">Book a 15-minute walkthrough</PrimaryCta>
              <SecondaryCta href="/pricing">See pricing</SecondaryCta>
            </div>
          </div>
        </div>
      </div>
    </Reveal>
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
          See if Hone fits your practice.
        </h2>
        <p className="mt-6 text-[18px] leading-[1.65] md:text-[21px]">
          Fifteen minutes on Zoom with a founder. Real app, no slides and
          no recorded demo. We walk through your typical session and
          decide together whether Hone is a good fit for your pilot.
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
