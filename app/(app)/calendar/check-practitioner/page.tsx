import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { createClient } from "@/lib/supabase/server";
import { clientDisplayName } from "@/lib/clients/identity";
import { preferredNameColumn, readWithPreferredName } from "@/lib/clients/preferred-name-read";
import { FormattedDateTime } from "@/components/formatted-date-time";
import {
  CHECK_REASON_TEXT,
  PHASE_TEXT,
  classifyForCheck,
  practitionerLabel,
  type AssignmentPhase,
  type CheckItem,
  type OpenAppointment,
  type PractitionerLite,
} from "@/lib/appointments/check-practitioner";
import { ReassignRow } from "./ReassignRow";

// Sam 1 Nov: before completion becomes assigned-only, the OWNER reviews the still-open appointments whose
// practitioner may be wrong. This page only SHOWS them. No assignment changes until the owner presses
// "Change practitioner" on a row (audited by the command). Owner only; a practitioner gets a 404.
// Sam 2 Nov: a PAST appointment date is not a recorded treatment start. Rows are split into what can be reassigned now
// (not started) and what is shown for review only (date passed; treatment recorded), each with its real status.
// Nothing here completes, reassigns, cancels or touches payment on its own.
// OWNER-ONLY BY DESIGN, not by a permission key: it reviews who is recorded, an owner act. If appointment reassignment later becomes
// configurable for staff (Roles program), this page and its action stay owner-only until a separately reviewed decision says otherwise.
// "Chart written by" always shows the RECORDED performer of a session, never the assignee.

export const dynamic = "force-dynamic";
// Every open appointment is read, in pages (Codex P2: a fixed window can hide the misassigned ones behind started
// rows and then say "Nothing to check"). A hard ceiling keeps the page bounded; if it is hit the page says so and
// never claims the list is complete.
const PAGE = 500;
const MAX_PAGES = 20;

export default async function CheckPractitionerPage() {
  const { practitioner, studio } = await requirePractitionerWithStudio();
  if (practitioner.role !== "owner") notFound();

  const supabase = await createClient();
  const readPage = (page: number) =>
    // preferred_name arrives with 0258; until the database has it the read retries without it (shows the stored name).
    readWithPreferredName((withPreferred) =>
      supabase
        .from("appointments")
        .select(
          `id, starts_at, practitioner_id, created_by_practitioner_id, client:clients(${preferredNameColumn(withPreferred)}name), service:services(name), sessions(performed_by_practitioner_id, started_at, deleted_at)`,
        )
        .eq("studio_id", studio.id)
        .eq("status", "confirmed")
        .order("starts_at")
        .order("id")
        .range(page * PAGE, page * PAGE + PAGE - 1),
    );
  const pracPromise = supabase.from("practitioners").select("id, role, active, display_name, email").eq("studio_id", studio.id);
  const pageData: unknown[] = [];
  let apptError: unknown = null;
  let complete = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await readPage(page);
    if (res.error) { apptError = res.error; break; }
    const got = (res.data ?? []) as unknown[];
    pageData.push(...got);
    if (got.length < PAGE) { complete = true; break; }
  }
  const pracRes = await pracPromise;
  const apptRes = { error: apptError, data: pageData };
  if (apptRes.error || pracRes.error) {
    return (
      <p role="alert" className="text-sm text-neutral-600">
        We couldn&apos;t load this list. Please try again.
      </p>
    );
  }

  const practitioners: PractitionerLite[] = (pracRes.data ?? []).map((p) => ({
    id: p.id as string,
    role: p.role as string,
    active: p.active === true,
    displayName: (p.display_name as string) ?? "",
    email: (p.email as string | null) ?? null,
  }));
  // Display name where there is one, the email only when there is no real name; the email is shown as a secondary line.
  const labelOf = new Map(practitioners.map((p) => [p.id, practitionerLabel(p)]));
  const nameCount = new Map<string, number>();
  for (const l of labelOf.values()) nameCount.set(l.name, (nameCount.get(l.name) ?? 0) + 1);
  const options = practitioners
    .filter((p) => p.active)
    .map((p) => {
      const l = labelOf.get(p.id)!;
      // two people with the same name are told apart by email in the dropdown
      return { id: p.id, displayName: (nameCount.get(l.name) ?? 0) > 1 && l.email ? `${l.name} (${l.email})` : l.name };
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  type Row = {
    id: string;
    starts_at: string;
    practitioner_id: string | null;
    created_by_practitioner_id: string | null;
    client: { name: string | null; preferred_name?: string | null } | { name: string | null; preferred_name?: string | null }[] | null;
    service: { name: string | null } | { name: string | null }[] | null;
    sessions: { performed_by_practitioner_id: string | null; started_at: string | null; deleted_at: string | null }[] | null;
  };
  const rows = (apptRes.data ?? []) as unknown as Row[];
  const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);
  const open: OpenAppointment[] = rows.map((r) => {
    // A soft-deleted chart is not evidence of who performed the visit (the sessions policy does not hide it).
    const live = (r.sessions ?? []).filter((s) => s.deleted_at === null || s.deleted_at === undefined);
    const starts = live.map((s) => s.started_at).filter((x): x is string => !!x).sort();
    return {
      id: r.id,
      startsAt: r.starts_at,
      practitionerId: r.practitioner_id,
      createdByPractitionerId: r.created_by_practitioner_id,
      performedBy: live.map((s) => s.performed_by_practitioner_id).filter((x): x is string => !!x),
      // A linked session is the RECORD that treatment began; a past date alone is not.
      linkedSessionCount: live.length,
      treatmentStartedAt: starts[0] ?? null,
    };
  });
  const items = classifyForCheck(open, practitioners, new Date());
  const byId = new Map(rows.map((r) => [r.id, r]));

  const groups: Record<AssignmentPhase, CheckItem[]> = { upcoming: [], date_passed: [], treatment_recorded: [] };
  for (const it of items) groups[it.phase].push(it);
  const PHASES: AssignmentPhase[] = ["upcoming", "date_passed", "treatment_recorded"];

  const who = (id: string | null) => {
    const l = id ? labelOf.get(id) : null;
    return id ? (l ?? { name: "Unknown", email: null }) : null;
  };

  return (
    <section className="mx-auto flex max-w-3xl flex-col gap-5" data-testid="check-practitioner">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Review practitioner assignments</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Once the assigned-only completion rule is switched on, practitioners will be able to mark only their own
          appointments complete. These open appointments may have the wrong practitioner recorded. Nothing is changed until you change it here. A suggestion comes from who wrote the
          chart and is never applied for you.
        </p>
        {items.length > 0 && (
          <p data-testid="check-practitioner-summary" className="text-sm font-medium">
            {groups.upcoming.length} can be reassigned now · {groups.date_passed.length} past with no treatment recorded ·{" "}
            {groups.treatment_recorded.length} with treatment recorded
          </p>
        )}
      </header>
      {!complete && (
        <p role="status" data-testid="check-practitioner-partial" className="text-xs text-neutral-600">
          Only the first {rows.length} open appointments (earliest first) were checked. This list is not complete.
        </p>
      )}
      {items.length === 0 ? (
        <p data-testid="check-practitioner-empty" className="text-sm">
          {complete
            ? "Nothing to check: every open appointment has a practitioner who does not look misassigned."
            : `Nothing to check among the ${rows.length} appointments read, but not all open appointments were read.`}
        </p>
      ) : (
        PHASES.filter((ph) => groups[ph].length > 0).map((ph) => (
          <section key={ph} data-testid={`check-section-${ph}`} className="flex flex-col gap-3">
            <div>
              <h2 className="text-base font-semibold">
                {PHASE_TEXT[ph].heading} <span className="font-normal text-neutral-500">({groups[ph].length})</span>
              </h2>
              <p className="text-xs text-neutral-600 dark:text-neutral-400">{PHASE_TEXT[ph].explain}</p>
            </div>
            <ul className="flex flex-col gap-3">
              {groups[ph].map((it) => {
                const r = byId.get(it.id)!;
                const client = one(r.client);
                const service = one(r.service);
                const current = who(it.currentPractitionerId);
                return (
                  <li
                    key={it.id}
                    data-testid="check-practitioner-item"
                    data-phase={it.phase}
                    className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                      <span className="font-medium">
                        {client ? clientDisplayName({ name: client.name ?? "", preferred_name: client.preferred_name ?? null }) : "Client"}
                        {service?.name ? ` · ${service.name}` : ""}
                      </span>
                      <FormattedDateTime iso={it.startsAt} />
                    </div>
                    <p data-testid="check-practitioner-status" className="text-sm">
                      {it.phase === "upcoming" && "Not started."}
                      {it.phase === "date_passed" && "The appointment date has passed. No treatment is recorded."}
                      {it.phase === "treatment_recorded" && (
                        <>
                          Treatment recorded{!it.isFuture ? "" : " (the appointment date is still ahead)"}
                          {it.treatmentStartedAt ? (
                            <>
                              , started <FormattedDateTime iso={it.treatmentStartedAt} />
                            </>
                          ) : (
                            " (no start time on the record)"
                          )}
                          .
                        </>
                      )}
                    </p>
                    <p className="text-sm">
                      Recorded practitioner:{" "}
                      <strong>{current ? current.name : "none"}</strong>
                      {current?.email ? <span className="text-xs text-neutral-500"> · {current.email}</span> : null}
                    </p>
                    {it.performedBy.length > 0 && (
                      <p className="text-xs text-neutral-600 dark:text-neutral-400">
                        Chart written by:{" "}
                        {it.performedBy.map((id) => who(id)?.name ?? "Unknown").join(", ")}
                      </p>
                    )}
                    <ul className="list-disc pl-5 text-xs text-neutral-600 dark:text-neutral-400">
                      {it.reasons.map((reason) => (
                        <li key={reason}>{CHECK_REASON_TEXT[reason]}</li>
                      ))}
                    </ul>
                    {it.phase === "upcoming" ? (
                      <ReassignRow
                        appointmentId={it.id}
                        options={options}
                        suggestionId={it.suggestionPractitionerId}
                        currentId={it.currentPractitionerId}
                      />
                    ) : (
                      <p data-testid="check-practitioner-historical" className="text-xs text-neutral-500">
                        The practitioner is not changed here. Open the appointment to complete it
                        {it.phase === "date_passed" ? " or mark it a no-show" : ""}.
                      </p>
                    )}
                    <div>
                      <Link
                        href={`/calendar/${it.id}`}
                        data-testid="check-practitioner-open"
                        className="inline-flex min-h-[44px] items-center text-sm font-medium underline underline-offset-2"
                      >
                        Open appointment
                      </Link>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
    </section>
  );
}
