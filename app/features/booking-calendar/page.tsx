import type { Metadata } from "next";
import { SafeAnalytics } from "../../_components/SafeAnalytics";
import { SiteHeader } from "../../_components/marketing/SiteHeader";
import { SiteFooter } from "../../_components/marketing/SiteFooter";
import {
  MarketingSurface,
  Container,
  Section,
  Eyebrow,
  Display,
  Title,
  Subtitle,
  Lede,
  Hairline,
  CTAButton,
} from "../../_components/marketing/primitives";
import { Reveal } from "../../_components/marketing/Reveal";
import { Breadcrumbs } from "../../_components/marketing/JsonLd";
import { CalendarPreview } from "../../_components/marketing/visuals/CalendarPreview";
import { WalkthroughCTA, RelatedLinks } from "../../_components/marketing/sections";
import { WALKTHROUGH, ANALYTICS_EVENTS } from "@/lib/marketing/content";
import { marketingMetadata } from "@/lib/marketing/metadata";

// Feature: /features/booking-calendar. Intent: electrolysis booking / calendar
// software. All capabilities are LIVE. SMS is opt-in (qualifier). Google
// Calendar is NEVER mentioned (dormant).

export const metadata: Metadata = marketingMetadata("/features/booking-calendar");

const CAPABILITIES: { title: string; body: string }[] = [
  {
    title: "A booking page clients can use 24/7",
    body: "Give clients their own page to browse your services, see real open times, and book online — with built-in protection against double-booking.",
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
    body: "Move a booking to a new time and it stays the same appointment — same client, notes, and history — still protected from double-booking.",
  },
  {
    title: "Automatic email reminders",
    body: "Every booking sends a confirmation, and automatic 24-hour and 2-hour email reminders help cut no-shows. Optional text reminders are available when you enable SMS and the client opts in.",
  },
];

export default function BookingCalendarPage() {
  return (
    <MarketingSurface>
      <SiteHeader />
      <Breadcrumbs
        items={[
          { name: "Home", path: "/" },
          { name: "Electrolysis software", path: "/electrolysis-software" },
          { name: "Booking and calendar", path: "/features/booking-calendar" },
        ]}
      />
      <main className="overflow-x-hidden">
        <Container className="grid items-center gap-12 pb-16 pt-8 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16 lg:pb-20 lg:pt-10">
          <Reveal immediate>
            <Eyebrow>Booking and calendar</Eyebrow>
            <Display className="mt-4">
              Online booking and a calendar for the treatment room.
            </Display>
            <Lede className="mt-6 max-w-xl">
              Give clients a booking page with real open times and double-booking protection,
              and run your day on a calendar built for how an electrolysis practice works — not
              a generic scheduler.
            </Lede>
            <div className="mt-8">
              <CTAButton href={WALKTHROUGH.href} event={ANALYTICS_EVENTS.primaryCtaClick}>
                {WALKTHROUGH.primaryLabel}
              </CTAButton>
            </div>
          </Reveal>
          <Reveal delay={80} className="lg:pl-4">
            <CalendarPreview />
          </Reveal>
        </Container>

        <Section tone="warm">
          <Container>
            <Reveal>
              <Eyebrow>What it does</Eyebrow>
              <Title className="mt-4 max-w-2xl">From first booking to the next visit.</Title>
            </Reveal>
            <div className="mt-10">
              <Hairline strong />
              <div className="grid sm:grid-cols-2 lg:grid-cols-3">
                {CAPABILITIES.map((c, i) => (
                  <Reveal
                    as="div"
                    key={c.title}
                    delay={(i % 3) * 60}
                    className="border-b border-[color:var(--color-hairline)] py-6 sm:pr-8"
                  >
                    <Subtitle as="h2" className="text-[1.125rem]">
                      {c.title}
                    </Subtitle>
                    <p className="mt-2 text-[0.9375rem] leading-[1.6] text-muted">{c.body}</p>
                  </Reveal>
                ))}
              </div>
            </div>
          </Container>
        </Section>

        <Section tone="paper">
          <Container size="prose">
            <Reveal>
              <Eyebrow>Booking that feeds the record</Eyebrow>
              <Title className="mt-4">The appointment is the start, not the end.</Title>
              <Lede className="mt-5">
                In Hone, a booking isn&apos;t a dead end on a calendar. It carries into intake,
                charting, and treatment memory, so the schedule and the treatment record stay
                connected — and a returning client&apos;s history is already there when they
                book again.
              </Lede>
            </Reveal>
          </Container>
        </Section>

        <RelatedLinks
          title="What happens after the booking."
          links={[
            {
              href: "/features/charting-records",
              label: "Charting and records",
              blurb: "Chart the treatment at the point of care and keep clean procedure records.",
            },
            {
              href: "/features/treatment-memory",
              label: "Treatment memory",
              blurb: "Every appointment feeds the Before Today briefing for the next visit.",
            },
            {
              href: "/electrolysis-software",
              label: "Electrolysis practice software",
              blurb: "See how booking fits the whole electrolysis workflow.",
            },
          ]}
        />

        <WalkthroughCTA
          title="See the booking flow end to end."
          body="We'll walk through your booking page, calendar, and reminders on a real workflow — and reply within one business day."
        />
      </main>
      <SiteFooter />
      <SafeAnalytics />
    </MarketingSurface>
  );
}
