import { Fragment } from "react";
import type { Metadata } from "next";
import { SafeAnalytics } from "../../_components/SafeAnalytics";
import { SiteHeader } from "../../_components/marketing/SiteHeader";
import { SkipLink } from "@/app/_components/marketing/SkipLink";
import { SiteFooter } from "../../_components/marketing/SiteFooter";
import {
  MarketingSurface,
  Container,
  Section,
  Eyebrow,
  Display,
  Title,
  Lede,
  CTAButton,
} from "../../_components/marketing/primitives";
import { Breadcrumbs } from "../../_components/marketing/JsonLd";
import { CalendarPreview } from "../../_components/marketing/visuals/CalendarPreview";
import {
  WalkthroughCTA,
  RelatedLinks,
  FeatureMatrix,
  SpecRows,
  SpecRow,
  SpecRowHead,
  SpecRowBody,
} from "../../_components/marketing/sections";
import { WALKTHROUGH, ANALYTICS_EVENTS, POSITIONING } from "@/lib/marketing/content";
import { marketingMetadata } from "@/lib/marketing/metadata";

// Feature: /features/booking-calendar. Intent: electrolysis booking / calendar
// software. All capabilities are LIVE. SMS is opt-in (qualifier). Google
// Calendar is NEVER mentioned (dormant).
//
// MKT-02E. Structure and copy follow marketing copy deck v2.2 section 6, which
// opens by stating what this page is for: "Intentionally a supporting page.
// Nothing on it claims better scheduling than anything else." Nothing here
// compares Hone's scheduling to anything, names another product, or calls this
// booking better — the page earns its place by what booking is CONNECTED to.
//
// TWO [VERIFY] MARKERS IN THE DECK WERE RESOLVED AGAINST THE TRUTH REGISTER,
// AND THEY DID NOT RESOLVE THE SAME WAY.
//
//   Reminders — VERIFIED, with a correction. The deck's marker asks whether the
//   scheduler is "live for all onboarded studios". It is not: the register
//   classes automatic 24h/2h email reminders LIVE_WITH_GUIDED_SETUP (external
//   scheduler) and still decides MARKET, giving the exact public phrasing used
//   below. So the capability is marketable and the deck's stated precondition is
//   simply the wrong test. No SMS line, per the deck and because both SMS rows
//   are DEPLOYED_DEFAULT_OFF / QUALIFIER.
//
//   Client portal — PARTLY REFUSED. The deck line is "Clients see their upcoming
//   appointments in a portal connected to the same record", marked
//   [VERIFY scope]. The register has NO row granting that: its portal rows are
//   magic-link sign-in, an append-only access log, an outstanding-items summary,
//   two-way messaging, and photos explicitly NEVER shown in the portal. Cancel
//   and reschedule are both "from their email", not from the portal. So the
//   upcoming-appointments claim is not written, and this page says only what the
//   register grants.

export const metadata: Metadata = marketingMetadata("/features/booking-calendar");

const CAPABILITIES: { title: string; body: string }[] = [
  {
    title: "A booking page clients can use 24/7",
    body: "Give clients their own page to browse your services, see real open times, and book online, with built-in protection against double-booking.",
  },
  {
    title: "Services and availability you control",
    body: "Set your services, weekly hours, date-specific overrides, vacations, breaks, and one-off blocks. Clients can only book the time you actually make available.",
  },
  {
    title: "A calendar built for the day",
    body: "See your whole schedule in day, week, or month view on any device, and book a client or block off time in seconds.",
  },
  {
    title: "Self-serve cancel and reschedule",
    body: "Clients cancel or reschedule from their confirmation and reminder emails, with your policy shown and an optional reason captured. You're notified automatically.",
  },
  {
    title: "Move an appointment in one step",
    body: "Move a booking to a new time and the same client, notes, and history move with it, protected from double-booking.",
  },
  {
    title: "Confirmations and reminders by email",
    body: "Every booking emails the client a confirmation and notifies you. Automatic 24-hour and 2-hour email reminders help cut no-shows.",
  },
];

export default function BookingCalendarPage() {
  return (
    <MarketingSurface>
      <SkipLink />
      <SiteHeader />
      <Breadcrumbs
        items={[
          { name: "Home", path: "/" },
          { name: "Electrolysis software", path: "/electrolysis-software" },
          { name: "Booking and calendar", path: "/features/booking-calendar" },
        ]}
      />
      <main id="main-content" className="scroll-mt-16">
        <Container className="grid items-start gap-x-[clamp(2.5rem,5vw,5rem)] gap-y-10 pb-[var(--mk-section-pad)] pt-[clamp(1rem,0.5rem+1.25vw,1.75rem)] lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
          <div>
            <Display className="max-w-[18ch]">Booking connected to the treatment record</Display>
            {/* #762 OWNS THESE WORDS, THIS PAGE OWNS ONLY THE LINE BREAK. Deck §6
                sets the sub as two lines, and it is the same sentence pair #762
                declares as POSITIONING.differentiationLine. Spelled by hand it
                would drift the first time that constant is edited, so the break
                is applied to the constant instead of the words being retyped.
                Split on sentence ends rather than on a known fragment, so a
                different sentence count still renders. */}
            <Lede className="mt-5 max-w-[38rem]">
              {POSITIONING.differentiationLine
                .split(/(?<=\.)\s+/)
                .filter(Boolean)
                .map((line, i) => (
                  <Fragment key={line}>
                    {i > 0 ? <br /> : null}
                    {line}
                  </Fragment>
                ))}
            </Lede>
            <CTAButton
              href={WALKTHROUGH.href}
              event={ANALYTICS_EVENTS.primaryCtaClick}
              className="mt-7 max-sm:w-full"
            >
              {WALKTHROUGH.primaryLabel}
            </CTAButton>
          </div>
          <CalendarPreview />
        </Container>

        <Section tone="warm">
          <Container>
            <Eyebrow>Online booking for your studio</Eyebrow>
            <Title className="mt-3 max-w-2xl">
              Appointments land on the calendar with the record attached.
            </Title>
            <Lede className="mt-4 max-w-2xl">
              Clients book from your studio&rsquo;s booking page. Appointments land on the
              studio calendar with the client&rsquo;s record attached.
            </Lede>
            <FeatureMatrix items={CAPABILITIES} />
          </Container>
        </Section>

        {/* ONE SPEC SHEET, NOT FOUR BANDS (see sections.tsx SpecRows). Two
            bodies used to restate their own heading word for word; the repeat
            is trimmed and nothing is added. */}
        <Section tone="paper">
          <Container>
            <Title className="max-w-2xl">Around the appointment</Title>
            <SpecRows>
              <SpecRow>
                <SpecRowHead>One shared calendar</SpecRowHead>
                <SpecRowBody>
                  <p>The record always shows who treated.</p>
                  <p>
                    A colour-coded calendar for the whole studio. Each practitioner charts under
                    their own name.
                  </p>
                </SpecRowBody>
              </SpecRow>
              <SpecRow>
                <SpecRowHead>Intake before the visit</SpecRowHead>
                <SpecRowBody>
                  <p>Read the history before they arrive.</p>
                  <p>
                    Health history is collected before the appointment and reviewed by you.
                    Flags like a pacemaker or an EpiPen are visible before the client arrives.
                  </p>
                </SpecRowBody>
              </SpecRow>
              <SpecRow>
                <SpecRowHead>Client portal</SpecRowHead>
                <SpecRowBody>
                  <p>A signed-in space, connected to the same record.</p>
                  <p>
                    Clients sign in with a passwordless, single-use magic link that expires in
                    60 minutes. The portal surfaces outstanding items &mdash; incomplete intake,
                    consent to sign, unread messages &mdash; and carries secure two-way
                    messaging whose content stays in the portal and never in notification
                    emails.
                  </p>
                  <p>
                    Treatment photos are never shown in the portal. Cancelling and rescheduling
                    happen from the client&rsquo;s confirmation and reminder emails.
                  </p>
                </SpecRowBody>
              </SpecRow>
              <SpecRow>
                <SpecRowHead>What booking is for on Hone</SpecRowHead>
                <SpecRowBody>
                  <p>The next appointment starts with the last treatment.</p>
                  <p>
                    Booking puts the appointment on the calendar. Charting puts the treatment in
                    the record. Hone connects the two.
                  </p>
                </SpecRowBody>
              </SpecRow>
            </SpecRows>
          </Container>
        </Section>

        <RelatedLinks
          title="What the appointment connects to."
          links={[
            {
              href: "/features/treatment-memory",
              label: "Treatment memory",
              blurb: "See how the last treatment reaches the next appointment.",
            },
            {
              href: "/features/charting-records",
              label: "Charting and records",
              blurb: "The treatment you chart against the appointment you booked.",
            },
            {
              href: "/electrolysis-software",
              label: "Electrolysis practice software",
              blurb: "See how booking fits the rest of the workflow.",
            },
          ]}
        />

        <WalkthroughCTA
          title="See booking and the record together."
          body="We'll show a booking landing on the calendar and the treatment charted against it, and reply within one business day."
        />
      </main>
      <SiteFooter />
      <SafeAnalytics />
    </MarketingSurface>
  );
}
