import { SectionLabel } from "@/components/ui/section-label";
import {
  getOwnerCapacityBriefing,
  type OwnerCapacityBriefing,
} from "@/lib/dashboard/owner-capacity";
import type { Fact } from "@/lib/dashboard/owner-capacity-model";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";

// ===========================================================================
// PRACTICE CAPACITY — the owner's client-truth briefing
// ===========================================================================
//
// Owner-only. The role check runs BEFORE any capacity read is issued, so an
// ordinary practitioner never causes a studio-wide analytics query, let alone
// receives one — the refusal is the same shape /settings/studio renders. Studio
// scope is server-resolved from the practitioner row; nothing here reads a
// browser-supplied id, and every underlying table is RLS-scoped to studio
// membership, so a cross-studio read is not expressible.
//
// WHAT THIS GATE IS NOT: a data boundary. RLS on clients, treatment_plans and
// appointments is `is_studio_member`, so any practitioner of this studio can
// already read the underlying rows. This page decides who is SHOWN the
// aggregate. Saying otherwise would describe a protection that does not exist.
//
// READ-ONLY. No form, no action, no mutation.
//
// SCOPE — OWNER-CAP Slice 1. It answers ONE question: which active treatment
// clients have no TREATMENT booked. Treatment access ("how soon could I see someone
// new"), weekly capacity, new-client demand and conversion are later slices,
// and are absent rather than stubbed.

export const metadata = { title: "Practice capacity" };

export default async function PracticeCapacityPage() {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (practitioner.role !== "owner") {
    return (
      <section className="rounded-lg border border-line bg-surface-sunken p-6 text-sm text-fg-muted">
        Only studio owners can see practice capacity.
      </section>
    );
  }

  const briefing = await getOwnerCapacityBriefing(studio);
  return <CapacityBriefing briefing={briefing} />;
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/** A number the studio can act on, or the one sentence saying why there isn't one. */
function Figure({
  fact,
  format = (n: number) => n.toLocaleString(),
  suffix,
}: {
  fact: Fact<number>;
  format?: (value: number) => string;
  suffix?: string;
}) {
  if (!fact.known) return <NotKnown reason={fact.reason} />;
  return (
    <p className="text-3xl font-semibold tabular-nums">
      {format(fact.value)}
      {suffix ? <span className="ml-1 text-base font-normal text-fg-muted">{suffix}</span> : null}
    </p>
  );
}

/**
 * The absence, carrying its own reason. Never a dash, never a zero: the whole
 * point of Fact<T> is that the owner learns WHY a figure is missing.
 */
function NotKnown({ reason }: { reason: string }) {
  return (
    <>
      <p className="text-base font-medium text-fg-muted">Not enough evidence yet</p>
      <p className="mt-1 text-xs text-fg-muted">{reason}</p>
    </>
  );
}

function Card({
  label,
  children,
  note,
}: {
  label: string;
  children: React.ReactNode;
  note?: string;
}) {
  return (
    <div className="rounded-lg border border-line p-4">
      <SectionLabel size="caption" as="h3">
        {label}
      </SectionLabel>
      <div className="mt-2">{children}</div>
      {note ? <p className="mt-2 text-xs text-fg-muted">{note}</p> : null}
    </div>
  );
}

function CapacityBriefing({ briefing }: { briefing: OwnerCapacityBriefing }) {
  const { clients, depth, futureTreatmentMinutes } = briefing;
  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-xl font-semibold">Practice capacity</h1>
        <p className="mt-1 text-sm text-fg-muted">
          Who is in treatment, and who has no treatment booked. Times are{" "}
          {briefing.timezone}.
        </p>
      </header>

      <section>
        <SectionLabel as="h2">Clients</SectionLabel>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Card
            label="Client records"
            note="Every client on file who is not archived. Not a measure of who is in treatment."
          >
            <Figure fact={clients.totalRecords} />
          </Card>
          <Card label="Active treatment clients" note={clients.activeTreatmentBasis}>
            <Figure fact={clients.activeTreatment} />
          </Card>
          <Card
            label="No future treatment booked"
            note="Active treatment clients with no upcoming treatment appointment. A booked consultation does not count as treatment."
          >
            <Figure fact={clients.activeTreatmentWithoutFutureBooking} />
          </Card>
        </div>
      </section>

      <section>
        {/* EVERY LABEL HERE SAYS "TREATMENT" ON PURPOSE. The bands are folded by
            summarizeFutureTreatment, which deliberately excludes consultations —
            so an active client whose only future booking is a consultation
            belongs in the zero band. The copy used to describe the bands as
            spanning all future appointments, and the zero card claimed the client
            held no booking of any kind. Both told the owner the opposite of what
            the number does, and would prompt a follow-up call to someone already
            in the diary. Something IS booked; it is simply not treatment.

            The old wording is described rather than quoted, because
            tests/source-guards/owner-capacity-copy-guards.test.ts bans the
            literal phrasing across this whole surface — comments included, since
            a comment stating the wrong product rule is how it comes back. */}
        <SectionLabel as="h2">Future treatment booking depth</SectionLabel>
        <p className="mt-1 text-xs text-fg-muted">
          Counted across future treatment appointments only, cumulatively — a client
          with three booked treatments appears in all three bands. Consultations do
          not count.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-4">
          <Card label="No treatment booked">
            <Figure fact={factOf(depth, (d) => d.zero)} />
          </Card>
          <Card label="1 or more treatments">
            <Figure fact={factOf(depth, (d) => d.oneOrMore)} />
          </Card>
          <Card label="2 or more treatments">
            <Figure fact={factOf(depth, (d) => d.twoOrMore)} />
          </Card>
          <Card label="3 or more treatments">
            <Figure fact={factOf(depth, (d) => d.threeOrMore)} />
          </Card>
        </div>
      </section>

      {/* The heading used to read "Treatment time on the calendar", which is a
          claim about the CALENDAR while the figure is a claim about CURRENT
          CLIENTS. Archiving a client does not cancel their appointments — the
          calendar still shows them — so an archived client's live booking sits
          outside this client-rooted snapshot and the old wording could have
          published a known total that understated the diary, or read zero while
          work was still on it. The measurement is right for the population this
          page is about; the label was the defect. */}
      <section>
        <SectionLabel as="h2">Future treatment time for current clients</SectionLabel>
        <div className="mt-3">
          <Card
            label="Treatment time booked"
            note="Current, non-archived clients only. Treatment appointments only; consultations and buffers are excluded."
          >
            <Figure
              fact={futureTreatmentMinutes}
              format={(m) => (m / 60).toFixed(1)}
              suffix="hours"
            />
          </Card>
        </div>
      </section>

      <p className="text-xs text-fg-muted">
        Read-only. This page answers who is in treatment and who has no treatment
        booked — a booked consultation is not treatment. It does not yet report how
        soon a new client could be seen, weekly capacity, or new-client demand.
      </p>
    </div>
  );
}

/**
 * Project one field out of a Fact-wrapped record, preserving the unknown and
 * its reason. Local to the screen: it is a presentation convenience, not a rule.
 */
function factOf<T, U>(fact: Fact<T>, pick: (value: T) => U): Fact<U> {
  return fact.known ? { known: true, value: pick(fact.value) } : fact;
}
