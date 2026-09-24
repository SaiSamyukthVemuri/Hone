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
  Subtitle,
  Lede,
  Hairline,
  CTAButton,
} from "../../_components/marketing/primitives";
import { Breadcrumbs } from "../../_components/marketing/JsonLd";
import { ProductFilm, ScreenFigure } from "../../_components/marketing/media";
import { WalkthroughCTA, RelatedLinks, FeatureMatrix } from "../../_components/marketing/sections";
import { WALKTHROUGH, ANALYTICS_EVENTS } from "@/lib/marketing/content";
import { marketingMetadata } from "@/lib/marketing/metadata";

// Feature: /features/treatment-memory. The canonical outreach and
// demo-follow-up URL, built from marketing copy deck v2.2.
//
// TYPOGRAPHY IS INHERITED, NOT DECLARED. Every heading here goes through the
// shared primitives, which resolve `--font-marketing-sans` via
// app/globals.css. This page therefore picks up Instrument Sans the moment
// MKT-02A lands the face, with no edit on this route. Nothing here vendors a
// font, loads one, or names a family.
//
// EVERY VISUAL IS A REAL CAPTURE of the running application against a
// lab-owned synthetic practice — invented practitioner, invented client,
// `@example.invalid` addresses, no treatment photos. No production tenant and
// no pilot data was read to make them, and none of them is a mockup.

export const metadata: Metadata = marketingMetadata("/features/treatment-memory");

// The record's real vocabulary, transcribed from the fields the product
// actually writes — not a paraphrase of them.
//
// THE UNIT IS THE SETTINGS BLOCK, NOT THE AREA, and this comment exists
// because the first version of this page got it backwards. `session_blocks`
// holds ONE setup — mode, energy, frequency, probe and lot, minutes, numbing,
// the tolerance and reaction observed, and any caution. `session_block_areas`
// (migration 0128) is a child table carrying ONLY `area`, `laterality` and an
// ordering hint: no clinical value at all. So a block may cover SEVERAL areas
// that shared one setup, and describing those settings as independent per-area
// rows would be describing a product we did not build.
//
// What IS per-area is the HISTORY: `lib/sessions/treatment-intelligence.ts`
// groups by area name and a block contributes to EVERY area it covered, which
// is why "Every area keeps its own history" further up the page is a claim the
// read model actually supports.
const RECORD_FIELDS: { eyebrow: string; title: string; body: string }[] = [
  {
    eyebrow: "Where",
    title: "The areas it covered",
    body: "Midline upper lip. Bilateral chin. A block lists every area the setup was used on, each with its own side, so a multi-area session stays legible instead of collapsing into one paragraph.",
  },
  {
    eyebrow: "How",
    title: "Mode and energy",
    body: "Blend, thermolysis or galvanic, with the energy level, timing, intensity and pulse count you worked at, recorded on the block rather than once for the whole appointment.",
  },
  {
    eyebrow: "With what",
    title: "Probe identity and lot",
    body: "Manufacturer, finish, construction and size, plus the lot number and whether it was confirmed. The detail that is impossible to reconstruct afterwards.",
  },
  {
    eyebrow: "How long",
    title: "Time at that setup",
    body: "Minutes worked and the machine frequency they were worked at, so the next visit starts from a real number rather than an impression.",
  },
  {
    eyebrow: "What happened",
    title: "Response and tolerance",
    body: "Reaction type, a tolerance rating, and your own note on how the skin behaved at that setup. This is the field that changes what you do next time.",
  },
  {
    eyebrow: "Comfort",
    title: "Numbing and aftercare",
    body: "Whether numbing was used, with your own note beside it. Aftercare and risks are confirmed once for the session, stamped with who explained them and when.",
  },
];
export default function TreatmentMemoryPage() {
  return (
    <MarketingSurface>
      <SkipLink />
      <SiteHeader />
      <Breadcrumbs
        items={[
          { name: "Home", path: "/" },
          { name: "Electrolysis software", path: "/electrolysis-software" },
          { name: "Treatment memory", path: "/features/treatment-memory" },
        ]}
      />

      <main id="main-content" className="scroll-mt-16 overflow-x-hidden">
        {/* Intro. A single centred column rather than the two-column hero the
            sibling feature pages use: the film is the hero image here, and the
            deck places it directly below the intro. */}
        <Container className="pb-14 pt-10 lg:pb-16 lg:pt-14">
          <div className="mx-auto max-w-3xl text-center">
            <Eyebrow>Treatment memory</Eyebrow>
            <Display className="mt-5">Treatment memory for electrologists</Display>
            <Lede className="mx-auto mt-6 max-w-2xl">
              A returning client is not a blank slate. Hone keeps what happened, per
              area, and brings it forward when it&rsquo;s needed.
            </Lede>
            <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row sm:gap-4">
              <CTAButton href={WALKTHROUGH.href} event={ANALYTICS_EVENTS.primaryCtaClick}>
                {WALKTHROUGH.primaryLabelShort}
              </CTAButton>
              <CTAButton
                href="/features/charting-records"
                variant="outline"
                event={ANALYTICS_EVENTS.featureCtaClick}
              >
                See charting &amp; records
              </CTAButton>
            </div>
          </div>

          <div className="mx-auto mt-14 max-w-5xl">
            <ProductFilm
              src="/marketing/hone-product-overview-v3-1.mp4"
              poster="/marketing/treatment-memory/film-poster-1920.webp"
              label="Hone product overview: a returning client's history carried from one appointment into the next"
              caption={
                <>
                  A short walkthrough of the real application: opening a returning
                  client, reading what the last visit left behind, and charting
                  today&rsquo;s session, setup by setup. Recorded against a
                  demonstration practice with invented clients. No client data
                  appears in it.
                </>
              }
            />
          </div>
        </Container>

        {/* 1. The premise. */}
        <Section tone="paper">
          <Container size="wide">
            <div className="max-w-2xl">
              <Eyebrow>The premise</Eyebrow>
              <Title className="mt-4">A returning client is not a blank slate</Title>
              <Lede className="mt-6">
                By the fourth visit there is a history: which areas you have worked,
                what the skin did afterwards, the note you left yourself last time.
                Most practice software treats that appointment as an empty row and
                leaves the history in your head, on a card, or three scrolls down a
                notes field.
              </Lede>
              <Lede className="mt-4">
                Hone treats it as the point. The client file opens with the things
                that change what you do today: a pinned caution, allergies, skin type
                and the plan you are working through.
              </Lede>
            </div>
            <ScreenFigure
              base="client-profile"
              priority
              alt="A client profile in Hone. A pinned note reads that the client is sensitive along the jawline and that the area should be worked last, with a check-in before increasing energy. Below it are an allergies panel and the client's skin type and treatment history."
              caption="A returning client's profile. The caution is pinned to the top of the file, not buried in a note from four visits ago."
            />
          </Container>
        </Section>

        {/* 2. The structural claim the rest of the page rests on. */}
        <Section tone="warm">
          <Container size="wide">
            <div className="max-w-2xl">
              <Eyebrow>Structure</Eyebrow>
              <Title className="mt-4">Every area keeps its own history</Title>
              <Lede className="mt-6">
                Electrolysis is not one treatment repeated. The upper lip and the chin
                are on different clearance schedules, tolerate different energy, and
                respond differently. A record that averages them into one line throws
                away the part you needed.
              </Lede>
              <Lede className="mt-4">
                So the unit you chart is a setup: the mode, energy, probe, lot and
                minutes you worked at, with the areas it covered listed against it.
                Areas share a block when the same setup applied to them, and when the
                settings differ they are separate blocks, which is how the difference
                survives.
              </Lede>
              <Lede className="mt-4">
                History is then read the other way round. Every block that covered an
                area feeds that area&rsquo;s history, so the chin accumulates its own
                record of what was used on it and how it responded, whether or not it
                was ever charted on its own.
              </Lede>
            </div>
            <ScreenFigure
              base="session-record"
              alt="A session record in Hone showing two setup blocks. The midline upper lip and the bilateral chin were worked at different energy levels and for different lengths of time, so each has its own block listing frequency, probe, mode, energy level, timing, intensity and minutes, with its own response and tolerance."
              caption="Two blocks here because the settings differed: the chin tolerated less than the lip and was worked down accordingly. Had both been treated at the same setup, they would share one block and still each keep their own history."
            />
          </Container>
        </Section>

        {/* 3. The pull quote. One of two dark bands on the page; the other is
            the closing CTA. It is the page's own line, deliberately not
            attributed to a person — an invented quotation from a named
            practitioner would be a fabricated endorsement. */}
        <Section tone="band">
          <Container>
            <blockquote className="mx-auto max-w-3xl text-center">
              <Title as="h2" className="text-paper">
                &ldquo;The history of the chin is the history of the chin.&rdquo;
              </Title>
              <Lede onBand className="mx-auto mt-6 max-w-xl">
                Not the history of the appointment, the client, or the month. Hone is
                built around that distinction, because it is the one that decides what
                you do when the client sits down.
              </Lede>
            </blockquote>
          </Container>
        </Section>

        {/* 4. What "memory" concretely means: the fields. */}
        <Section tone="paper">
          <Container size="wide">
            <div className="max-w-2xl">
              <Eyebrow>The record, as fields</Eyebrow>
              <Title className="mt-4">Memory is only as good as what you wrote down</Title>
              <Lede className="mt-6">
                Nothing here is free text pretending to be a record. Each setup is
                stored as structured fields with its treated areas listed against it,
                which is what lets the next session retrieve it, compare it and put it
                in front of you without anyone searching for it.
              </Lede>
            </div>
            <FeatureMatrix items={RECORD_FIELDS} />
            <p className="mt-8 max-w-2xl text-[0.9375rem] leading-[1.6] text-muted">
              Hone surfaces what you recorded. It does not diagnose, recommend
              settings, or make a clinical decision on your behalf, and the
              record-gap reminders are rules over your own data rather than a model
              guessing. The judgement stays yours.
            </p>
          </Container>
        </Section>

        {/* 5. The named surface. */}
        <Section tone="warm">
          <Container size="wide">
            <div className="max-w-2xl">
              <Eyebrow>Before Today</Eyebrow>
              <Title className="mt-4">The briefing you would have written yourself</Title>
              <Lede className="mt-6">
                Open a returning client&rsquo;s appointment and the briefing is already
                assembled: when you last treated them, which areas, how each one
                responded, and the caution you flagged for this visit. It is built
                from your own charting, so there is nothing extra to maintain.
              </Lede>
            </div>
            <ScreenFigure
              base="before-today"
              alt="An appointment in Hone before it begins. A pinned caution and allergies sit at the top, followed by the client's details and a last-treatment panel giving the date, the areas treated and the notes left for this visit."
              caption="The same appointment a generic booking tool would show as a name and a time."
            />
          </Container>
        </Section>

        {/* 6. The mechanism: the carry-forward itself. */}
        <Section tone="paper">
          <Container size="wide">
            <div className="max-w-2xl">
              <Eyebrow>Carry forward</Eyebrow>
              <Title className="mt-4">What comes forward without being asked</Title>
              <Lede className="mt-6">
                At the end of a session you leave a short note for next time. You do
                not file it, tag it or remember where it went. It reappears on the
                client&rsquo;s last-visit card and inside the new session panel, at
                the moment it is useful.
              </Lede>
            </div>

            <div className="mt-10 grid gap-x-12 gap-y-8 lg:grid-cols-3">
              {[
                {
                  n: "01",
                  t: "You flag it once",
                  b: "A caution, a tolerance you want watched, or a plan for the next visit, written while the session is still in front of you.",
                },
                {
                  n: "02",
                  t: "The caution rides with the setup",
                  b: "A caution is stored on the block you flagged it in, which already names the areas that block covered, so it comes back attached to them. The plan for next time is one note for the session, and it returns with the session.",
                },
                {
                  n: "03",
                  t: "It resurfaces on its own",
                  b: "On the last-visit card and in the next session panel, before the appointment starts, without a search.",
                },
              ].map((s) => (
                <div key={s.n} className="flex flex-col">
                  <span className="text-[1rem] font-semibold tabular-nums tracking-[0.02em] text-mineral">
                    {s.n}
                  </span>
                  <Subtitle as="h3" className="mt-2">
                    {s.t}
                  </Subtitle>
                  <Hairline className="my-3.5" />
                  <p className="text-[1.0625rem] leading-[1.55] text-muted">{s.b}</p>
                </div>
              ))}
            </div>

            <ScreenFigure
              base="previous-session"
              alt="An earlier session record in Hone. Its last-treatment panel carries the previous visit's areas, responses and a watch note for the jawline, showing the same fields being carried forward one visit earlier in the same course of treatment."
              caption="The visit before: the same fields, one appointment earlier, which is what makes the briefing above possible."
            />
          </Container>
        </Section>

        {/* 7. The migration objection, answered. */}
        <Section tone="warm">
          <Container size="wide">
            <div className="grid gap-10 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16">
              <div>
                <Eyebrow>Starting from what you have</Eyebrow>
                <Title className="mt-4">Bring your history with you</Title>
                <Lede className="mt-6">
                  Treatment memory is worth least on day one, which is the day most
                  practices are asked to switch. So the history comes across during
                  guided setup, from paper cards, a spreadsheet, or whatever you are
                  using now.
                </Lede>
                <Lede className="mt-4">
                  Imported history is labelled as imported wherever it appears. It
                  shows up in the briefing and does its job, and it is never quietly
                  mixed in with what you charted in Hone.
                </Lede>
              </div>
              <div className="lg:pt-2">
                <Hairline strong />
                <dl className="divide-y divide-[color:var(--color-hairline)]">
                  {[
                    [
                      "From paper cards",
                      "Kept as a labelled imported record in the client's history, in the practitioner's original wording rather than forced into Hone's charting fields.",
                    ],
                    [
                      "From a spreadsheet",
                      "Brought across row by row into that same imported record, with the founder doing the mapping rather than handing you an importer.",
                    ],
                    [
                      "Always labelled",
                      "Imported entries are marked as imported in the briefing and the record, permanently and visibly.",
                    ],
                  ].map(([t, b]) => (
                    <div key={t} className="py-5">
                      <dt className="text-[1.0625rem] font-semibold text-ink">{t}</dt>
                      <dd className="mt-1.5 text-[1rem] leading-[1.55] text-muted">{b}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </div>
          </Container>
        </Section>

        <RelatedLinks
          title="How treatment memory connects"
          links={[
            {
              href: "/features/charting-records",
              label: "Charting and records",
              blurb:
                "Memory is only as good as the charting behind it. See how a session is recorded, setup by setup.",
            },
            {
              href: "/features/booking-calendar",
              label: "Booking and calendar",
              blurb:
                "Every appointment feeds the record, and reminders help a returning client keep their course going.",
            },
            {
              href: "/electrolysis-software",
              label: "Electrolysis practice software",
              blurb:
                "Where treatment memory sits in the rest of the electrolysis workflow.",
            },
          ]}
        />

        {/* The deck's closing line is this band's headline: the closing
            statement and the walkthrough CTA are one beat, not two stacked
            dark sections. */}
        <WalkthroughCTA
          title="Pick up where you left off."
          body="We will walk through the briefing on a real course of treatment, show how your own charting carries forward, and reply within one business day."
        />
      </main>

      <SiteFooter />
      <SafeAnalytics />
    </MarketingSurface>
  );
}
