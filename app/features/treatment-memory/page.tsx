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
import { ProductFilm } from "../../_components/marketing/ProductFilm";
import { ScreenFigure } from "../../_components/marketing/media";
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

        </Container>

        {/* THE CANONICAL FILM, NOT A SECOND ONE. This page originally shipped
            its own copy of the asset and its own <video>. MKT-02B (#764) had
            already published the identical file — byte-for-byte, same sha256 —
            at /film/hone-treatment-memory-v3-1.mp4 behind a shared player, so
            the duplicate was deleted and this route now uses theirs.

            That component is a FACADE: it fetches zero media bytes until
            someone presses play, carries the film's transcript in the
            accessibility tree, moves focus to the video it replaces, and has no
            autoplay path at all. Reimplementing any of that here would be a
            second player authority for one asset.

            ON A BAND, deliberately. `ProductFilm` renders its caption in
            `--color-onband-muted`, which is a light sage: legible on the dark
            band it was designed for, and far too low-contrast on this page's
            paper. Matching the surface it expects is the fix; forking the
            component to recolour a caption is not. */}
        <Section tone="band" className="!py-[clamp(3rem,5vw,4.5rem)]">
          <Container>
            <ProductFilm />
          </Container>
        </Section>

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
              alt="A client profile in Hone. A pinned note, marked visible on every appointment, reads that the client is sensitive along the jawline and that the area should be worked last with a check-in before increasing energy. Below it an allergies panel reads none reported, and a skin panel records a practitioner-confirmed Fitzpatrick type above the legacy skin notes, where the capture ends."
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
                History is then read the other way round. The area summary is built
                from a client&rsquo;s most recent 200 sessions, and inside that window
                every block that covered an area feeds that area, so the chin
                accumulates its own record of what was used on it and how it
                responded, whether or not it was ever charted on its own.
              </Lede>
            </div>
            {/* A CROP OF THE SAME CAPTURE, not a new one. The full-viewport
                frame carried the blue WATCH TODAY panel, which
                `point-of-care-memory.ts` builds from
                `session_blocks.caution_note` — an input PR #199 retired — so
                the figure advertised a workflow no practitioner can start.
                Cropping to the setup band removes it while keeping the evidence
                this section actually needs. Nothing was repainted, removed or
                composited; the only change is the frame. 30:7, hence the
                explicit intrinsic size. */}
            <ScreenFigure
              base="session-record"
              width={2400}
              height={560}
              alt="The setup panel of a session record in Hone, listing two blocks. Midline Upper lip: 27.12 MHz, a Sterex Gold two-piece F3 Short probe with a confirmed lot number, Blend, energy level 3, 3 seconds, 40 percent, 1 pulse, 18 minutes, numbing used. Bilateral Chin: the same frequency, probe and lot, Blend, energy level 2, 3 seconds, 40 percent, 1 pulse, 12 minutes, numbing used."
              caption="Two blocks, because the settings differed: the chin was worked at a lower energy and for less time than the lip. Had both been treated at the same setup they would share one block, and each area would still keep its own history."
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
                assembled: when you last treated them, which areas the setup covered,
                how the skin responded, the note you left for this visit, and anything
                pinned to the client&rsquo;s file. It is built from your own charting,
                so there is nothing extra to maintain.
              </Lede>
            </div>
            <ScreenFigure
              base="before-today"
              alt="An appointment in Hone before it begins. A pinned caution and an allergies panel sit above the client's details, followed by a last-treatment panel giving the date, the service, the duration and the areas treated: midline upper lip and bilateral chin. Below it a last-session-notes section is headed For next visit, where the capture ends."
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
                  t: "You write it once",
                  b: "The plan for next time, written at the end of the session while it is still in front of you. It can name any area you want watched, and most do.",
                },
                {
                  n: "02",
                  t: "It stays where you wrote it",
                  b: "One note on the session, not filed and not tagged. The tolerance and response you recorded stay on the setup block they describe, and a standing instruction belongs on the client\u2019s pinned notes instead.",
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

            {/* NO FIGURE HERE, DELIBERATELY. The obvious capture to place under
                these three steps was the previous visit's session record — and
                it renders a WATCH TODAY panel, which `point-of-care-memory.ts`
                builds from `session_blocks.caution_note`. PR #199 removed the
                input that writes that column, so a practitioner charting today
                cannot produce one. Showing it in the section about what carries
                forward would advertise a retired path in pictures after the
                prose had stopped advertising it in words, which is the same
                claim made less accountably.

                No existing capture can stand in: the only one containing the
                live session-level plan cuts off at the viewport before the note
                text. A replacement needs a fresh capture from the lab fixture,
                and until there is one these steps carry the section alone. */}
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
                  Imported history is labelled as imported wherever it appears, and it
                  is never quietly mixed in with what you charted in Hone. The briefing
                  leads with the most recent imported entries and tells you how many
                  more are on file behind them.
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
                      "Brought across row by row into that same imported record and kept there, with the founder doing the mapping rather than handing you an importer.",
                    ],
                    [
                      "Labelled, and counted",
                      "Imported entries are marked as imported wherever they surface. Before Today leads with the most recent of them and names the total held, so the count tells you there is more history behind the ones on screen.",
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
