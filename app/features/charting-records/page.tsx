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
import { Reveal } from "../../_components/marketing/Reveal";
import { Breadcrumbs } from "../../_components/marketing/JsonLd";
import { SessionRecordPreview } from "../../_components/marketing/visuals/SessionRecordPreview";
import { WalkthroughCTA, RelatedLinks, FeatureMatrix } from "../../_components/marketing/sections";
import { WALKTHROUGH, ANALYTICS_EVENTS } from "@/lib/marketing/content";
import { marketingMetadata } from "@/lib/marketing/metadata";

// Feature: /features/charting-records. Intent: electrolysis charting / treatment
// records. All LIVE. "Print/export" = print-friendly views + the CSV data export
// (there is no PDF file export of charting, do not imply one).
//
// TRUTH-01A: this comment used to say "full studio data export" and the page
// body said "full studio history". Both overstated a named-subset export whose
// contents are declared in lib/export/resource-registry.ts. Charting reaches the
// export as electrolysis_entries.csv and laser_entries.csv; the session BLOCK
// that groups them has no file of its own yet, so do not imply the charting
// record leaves whole.
//
// MKT-02E. Structure and copy follow marketing copy deck v2.2 section 5.
//
// THE EDIT-HISTORY SECTION IS NEITHER THE DECK'S NOR THE REGISTER'S SENTENCE,
// AND THE SECOND HALF OF THAT IS A REGISTER DEFECT WORTH REPORTING.
//
// The deck heads it "Corrections are recorded, not written over". Truth-register
// standing rule 7 (clinical-record rule, 2026-07-29) forbids marketing a
// *correction / amendment workflow* — signed / finalized clinical records are
// RETIRED and permanently rejected — and offers its own replacement wording:
// "treatment records stay editable, and every change is attributed and
// time-stamped."
//
// THAT REPLACEMENT DOES NOT HOLD FOR THE FIELDS THIS PAGE IS ABOUT. Checked in
// the schema, not taken from the register. `update_session_block_with_areas` is
// last defined in 0156_conditional_numbing_notes.sql:102-169 (0155 and 0129
// before it; 0166 only calls it) and it UPDATEs the block in place, then DELETEs
// and reinserts its areas, writing no `session_audit` row at all. Exactly two
// live writers put rows in that table: `edit_session_started_at` (0167:425,
// field `started_at`) and `soft_delete_session_area` (0123:116, field
// `area_removed`). A third, in retired `finalize_session` (0119:603), is dead —
// 0159 revoked EXECUTE from every runtime role. So changing mode, energy,
// frequency, probe, lot, tolerance, reaction or the treated-area set retains
// nothing of the previous value, and a general "every change is attributed and
// time-stamped" on a page that lists exactly those fields would be read as an
// audit trail that does not exist.
//
// The register row is the sharper defect, and it is not this page's to fix.
// §2 (Charting & Records) line 113, "Correcting a charting mistake", is classed
// LIVE_FOR_ALL_ONBOARDED / MARKET with the phrasing "records stay editable, and
// every change is captured in the session edit history". Correcting a mis-charted
// session means changing those same fields, which is precisely what
// `session_audit` does not capture. (Its neighbour at line 105, "Session edit
// history — see who changed a session and when", stays true for the two events
// above; it is the generalisation to *every* change that is not.) No other
// marketing surface carries either sentence today — the homepage does not — so
// this page is the only copy affected, and the register row should be corrected
// at source before the next page inherits it.
//
// What IS true is what this section now says, and rule 7 preserves all of it:
// `client_clinical_notes` (0126) is append-only with in-place UPDATE blocked by
// trigger, so a correction is a new revision via `supersedes_note_id`; and
// migration 0086 keeps the sterile-item and disinfectant record-keeping trail.
// (Named by migration rather than by table: tests/app/records/audit-trail.test.ts
// allowlists which files under app/, lib/ and components/ may mention that
// table's name, and a marketing comment is not one of them.)
//
// WHAT IS PER-AREA AND WHAT IS PER-BLOCK, BECAUSE THE COPY GOT THIS WRONG ONCE.
//
// This page said "Four areas, four records" and "every field is attached to the
// area it describes". Both were false, and Codex was right to call it. The write
// path is one command: `create_block_with_entry` (0166:390) makes ONE
// `session_blocks` row plus its complete area set, then at most ONE
// `electrolysis_entries` row. So a four-area block is one record, not four.
//
// `session_block_areas` (0128:26) carries only `area`, `laterality` and
// `display_order` — and nothing was ever added to it. Every treatment field
// lives on the parent block, which 0019 labels in as many words: "Treatment-level
// params that apply to every entry in this block" — mode, apilus_modality,
// energy_level, minutes_performed, probe_type, probe_size, machine_frequency.
// That is why the capability line above no longer says "minutes performed per
// area": `minutes_performed` is a block column.
//
// WHAT IS TRUE, AND IS WHAT THE SECTION NOW CLAIMS. Per-area history is real:
// `lib/sessions/treatment-intelligence.ts:41-45` states that when structured
// areas are present "the block contributes to EVERY area's intelligence (not just
// primary_area)", so a "Cheeks + Sideburns" block appears under both areas. And a
// secondary area is independently findable — `lib/search/treatment-memory-merge.ts`
// exists to close exactly that recall gap, while merging so one treatment still
// shows up as one result. So each area does keep its own history; what it does
// not get is its own settings inside a shared block.
//
// The deck's two [DECIDE] items are left as they already ship: Apilus is named
// in the capability list exactly as production names it today, and no laser line
// is added. Neither is an MKT-02E decision to take.

export const metadata: Metadata = marketingMetadata("/features/charting-records");

/** Deck section 5, "The fields", verbatim. A list for layout, not an ordering claim. */
const FIELDS: readonly string[] = [
  "Area and side",
  "Mode and modality",
  "Energy",
  "Frequency",
  "Pulse count",
  "Split readings",
  "Probe type",
  "Probe lot",
  "Tolerance",
  "Skin response",
  "Aftercare",
  "Next-treatment note",
];

const CAPABILITIES: { title: string; body: string }[] = [
  {
    title: "Point-of-care charting",
    body: "Chart electrolysis and laser sessions on one page, mode (thermolysis, blend, galvanic), Apilus modality, energy, machine frequency, and per-pass readings.",
  },
  {
    title: "Structured probe and lot",
    body: "Select a validated probe by brand, material, and size, and record the probe lot number from a searchable active-lot picker drawn from your sterile-item records. Manual entry is always available.",
  },
  {
    title: "Areas, laterality, and minutes",
    body: "Record several treatment areas under one machine-settings block, each with its own laterality, plus the minutes performed for that block for treatment-time tracking.",
  },
  {
    title: "Observations and response",
    body: "Tag what you saw with quick observation chips, and capture how each area was tolerated and any reaction, as structured, factual records alongside free-text notes.",
  },
  {
    title: "Procedure records and print views",
    body: "Generate per-client procedure records from charted sessions, filterable by client and date, and open clean, print-friendly views for inspections.",
  },
  {
    title: "Traceability and logs",
    body: "Trace a probe lot to the areas that recorded it, and keep sterile-item and disinfectant logs with lot numbers, expiry, and replace-by dates, with an append-only edit history.",
  },
];

export default function ChartingRecordsPage() {
  return (
    <MarketingSurface>
      <SkipLink />
      <SiteHeader />
      <Breadcrumbs
        items={[
          { name: "Home", path: "/" },
          { name: "Electrolysis software", path: "/electrolysis-software" },
          { name: "Charting and records", path: "/features/charting-records" },
        ]}
      />
      <main id="main-content" className="scroll-mt-16 overflow-x-hidden">
        <Container className="grid items-start gap-12 pb-16 pt-8 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16 lg:pb-20 lg:pt-10">
          <Reveal immediate>
            <Eyebrow>Charting and records</Eyebrow>
            <Display className="mt-4">
              Electrolysis charting built around treatments, not generic notes
            </Display>
            <Lede className="mt-6 max-w-xl">
              The record is shaped like the work: per area, per treatment, in fields.
            </Lede>
            <div className="mt-8">
              <CTAButton href={WALKTHROUGH.href} event={ANALYTICS_EVENTS.primaryCtaClick}>
                {WALKTHROUGH.primaryLabel}
              </CTAButton>
            </div>
          </Reveal>
          <Reveal delay={80} className="lg:pl-4">
            <SessionRecordPreview />
          </Reveal>
        </Container>

        <Section tone="warm">
          <Container size="wide">
            <Eyebrow>The fields</Eyebrow>
            <Title className="mt-4 max-w-2xl">What one treatment records.</Title>
            <ul className="mt-8 flex flex-wrap gap-3">
              {FIELDS.map((field) => (
                <li
                  key={field}
                  className="rounded-full border border-hairline bg-paper px-4 py-2 text-[0.875rem] leading-none text-ink"
                >
                  {field}
                </li>
              ))}
            </ul>
            <FeatureMatrix items={CAPABILITIES} />
          </Container>
        </Section>

        <Section tone="paper">
          <Container size="prose">
            <Reveal>
              <Eyebrow>Per area, not per visit</Eyebrow>
              <Title className="mt-4">Every area keeps its own history.</Title>
              <Lede className="mt-5">
                Each treated area is recorded as an area, with its own side &mdash; not as one
                line in a visit note. Treat several areas at the same settings and those
                settings are recorded once, for that group, and every area in it carries the
                treatment into its own history. Open the chin months later and you read the
                chin.
              </Lede>
            </Reveal>
          </Container>
        </Section>

        <Section tone="warm">
          <Container size="prose">
            <Reveal>
              <Eyebrow>Notes are append-only</Eyebrow>
              <Title className="mt-4">A saved note is never overwritten.</Title>
              <Lede className="mt-5">
                Correcting a clinical note records a new revision that supersedes the old one,
                so the original stays readable. Sterile-item and disinfectant records keep an
                append-only log of their own.
              </Lede>
              <p className="mt-4 text-[0.9375rem] leading-[1.6] text-muted">
                Treatment records themselves stay editable, so a value you change is the value
                the record shows.
              </p>
            </Reveal>
          </Container>
        </Section>

        <Section tone="paper">
          <Container size="prose">
            <Reveal>
              <Eyebrow>Lots, sterile items and expiry</Eyebrow>
              <Title className="mt-4">Show what was used on the day.</Title>
              <Lede className="mt-5">
                The probe lot is part of the treatment record and linked to your inventory.
                Sterile items and disinfectant carry expiry dates in a log. When you need to
                show what was used on a given day, there&rsquo;s a print-friendly view.
              </Lede>
            </Reveal>
          </Container>
        </Section>

        <Section tone="warm">
          <Container size="prose">
            <Reveal>
              <Eyebrow>Photos</Eyebrow>
              <Title className="mt-4">Attached to the record, kept private.</Title>
              <Lede className="mt-5">
                Treatment photos attach to the record. They&rsquo;re stored privately, camera
                metadata is stripped, and they open through short-lived links.
              </Lede>
            </Reveal>
          </Container>
        </Section>

        <Section tone="paper">
          <Container size="prose">
            <Reveal>
              <Eyebrow>Gaps are flagged</Eyebrow>
              <Title className="mt-4">Hone points out what&rsquo;s missing.</Title>
              <Lede className="mt-5">
                A missing probe lot. Aftercare not marked. A completed appointment not yet
                charted. Hone flags each one.
              </Lede>
              <p className="mt-4 text-[0.9375rem] leading-[1.6] text-muted">
                Hone supports record-keeping workflows; studios remain responsible for meeting
                their local public-health requirements.
              </p>
            </Reveal>
          </Container>
        </Section>

        <RelatedLinks
          title="Where the record goes."
          links={[
            {
              href: "/features/treatment-memory",
              label: "Treatment memory",
              blurb: "Structured charting is what makes the Before Today briefing possible next visit.",
            },
            {
              href: "/features/booking-calendar",
              label: "Booking and calendar",
              blurb: "Each appointment links to the session you chart against it.",
            },
            {
              href: "/electrolysis-software",
              label: "Electrolysis practice software",
              blurb: "See how charting and records fit the whole workflow.",
            },
          ]}
        />

        <WalkthroughCTA
          title="See charting on a real session."
          body="We'll walk through charting a session and pulling a procedure record, and reply within one business day."
        />
      </main>
      <SiteFooter />
      <SafeAnalytics />
    </MarketingSurface>
  );
}
