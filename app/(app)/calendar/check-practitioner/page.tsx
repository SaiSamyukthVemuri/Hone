import { notFound } from "next/navigation";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { createClient } from "@/lib/supabase/server";
import { clientDisplayName } from "@/lib/clients/identity";
import { preferredNameColumn, readWithPreferredName } from "@/lib/clients/preferred-name-read";
import { FormattedDateTime } from "@/components/formatted-date-time";
import {
  CHECK_REASON_TEXT,
  classifyForCheck,
  type OpenAppointment,
  type PractitionerLite,
} from "@/lib/appointments/check-practitioner";
import { ReassignRow } from "./ReassignRow";

// Sam 1 Nov: before completion becomes assigned-only, the OWNER reviews the still-open appointments whose
// practitioner may be wrong. This page only SHOWS them. No assignment changes until the owner presses
// "Change practitioner" on a row (audited by the command). Owner only; a practitioner gets a 404.

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
          `id, starts_at, practitioner_id, created_by_practitioner_id, client:clients(${preferredNameColumn(withPreferred)}name), service:services(name), sessions(performed_by_practitioner_id, deleted_at)`,
        )
        .eq("studio_id", studio.id)
        .eq("status", "confirmed")
        .order("starts_at")
        .order("id")
        .range(page * PAGE, page * PAGE + PAGE - 1),
    );
  const pracPromise = supabase.from("practitioners").select("id, role, active, display_name").eq("studio_id", studio.id);
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
    displayName: (p.display_name as string) ?? "Practitioner",
  }));
  const nameOf = new Map(practitioners.map((p) => [p.id, p.displayName]));
  const options = practitioners
    .filter((p) => p.active)
    .map((p) => ({ id: p.id, displayName: p.displayName }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  type Row = {
    id: string;
    starts_at: string;
    practitioner_id: string | null;
    created_by_practitioner_id: string | null;
    client: { name: string | null; preferred_name?: string | null } | { name: string | null; preferred_name?: string | null }[] | null;
    service: { name: string | null } | { name: string | null }[] | null;
    sessions: { performed_by_practitioner_id: string | null; deleted_at: string | null }[] | null;
  };
  const rows = (apptRes.data ?? []) as unknown as Row[];
  const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);
  const open: OpenAppointment[] = rows.map((r) => ({
    id: r.id,
    startsAt: r.starts_at,
    practitionerId: r.practitioner_id,
    createdByPractitionerId: r.created_by_practitioner_id,
    // A soft-deleted chart is not evidence of who performed the visit (the sessions policy does not hide it).
    performedBy: (r.sessions ?? [])
      .filter((s) => s.deleted_at === null || s.deleted_at === undefined)
      .map((s) => s.performed_by_practitioner_id)
      .filter((x): x is string => !!x),
  }));
  const items = classifyForCheck(open, practitioners, new Date());
  const byId = new Map(rows.map((r) => [r.id, r]));

  return (
    <section className="mx-auto flex max-w-3xl flex-col gap-4" data-testid="check-practitioner">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Check the practitioner</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Practitioners can mark only their own appointments complete. These open appointments may have the wrong
          practitioner recorded. Nothing is changed until you change it here. A suggestion comes from who wrote the
          chart and is never applied for you.
        </p>
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
        <ul className="flex flex-col gap-3">
          {items.map((it) => {
            const r = byId.get(it.id)!;
            const client = one(r.client);
            const service = one(r.service);
            return (
              <li
                key={it.id}
                data-testid="check-practitioner-item"
                className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">
                    {client ? clientDisplayName({ name: client.name ?? "", preferred_name: client.preferred_name ?? null }) : "Client"}
                    {service?.name ? ` · ${service.name}` : ""}
                  </span>
                  <FormattedDateTime iso={it.startsAt} />
                </div>
                <p className="text-sm">
                  Recorded practitioner:{" "}
                  <strong>{it.currentPractitionerId ? (nameOf.get(it.currentPractitionerId) ?? "Unknown") : "none"}</strong>
                </p>
                <ul className="list-disc pl-5 text-xs text-neutral-600 dark:text-neutral-400">
                  {it.reasons.map((reason) => (
                    <li key={reason}>{CHECK_REASON_TEXT[reason]}</li>
                  ))}
                </ul>
                <ReassignRow
                  appointmentId={it.id}
                  options={options}
                  suggestionId={it.suggestionPractitionerId}
                  currentId={it.currentPractitionerId}
                  canChange={it.isFuture}
                />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
