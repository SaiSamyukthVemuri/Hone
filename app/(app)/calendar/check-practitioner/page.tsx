import { notFound } from "next/navigation";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { createClient } from "@/lib/supabase/server";
import { clientDisplayName } from "@/lib/clients/identity";
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
const LIMIT = 300;

export default async function CheckPractitionerPage() {
  const { practitioner, studio } = await requirePractitionerWithStudio();
  if (practitioner.role !== "owner") notFound();

  const supabase = await createClient();
  const [apptRes, pracRes] = await Promise.all([
    supabase
      .from("appointments")
      .select(
        "id, starts_at, practitioner_id, created_by_practitioner_id, client:clients(name, preferred_name), service:services(name), sessions(performed_by_practitioner_id)",
      )
      .eq("studio_id", studio.id)
      .eq("status", "confirmed")
      .order("starts_at")
      .limit(LIMIT),
    supabase.from("practitioners").select("id, role, active, display_name").eq("studio_id", studio.id),
  ]);
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
    client: { name: string | null; preferred_name: string | null } | { name: string | null; preferred_name: string | null }[] | null;
    service: { name: string | null } | { name: string | null }[] | null;
    sessions: { performed_by_practitioner_id: string | null }[] | null;
  };
  const rows = (apptRes.data ?? []) as unknown as Row[];
  const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);
  const open: OpenAppointment[] = rows.map((r) => ({
    id: r.id,
    startsAt: r.starts_at,
    practitionerId: r.practitioner_id,
    createdByPractitionerId: r.created_by_practitioner_id,
    performedBy: (r.sessions ?? []).map((s) => s.performed_by_practitioner_id).filter((x): x is string => !!x),
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
      {rows.length === LIMIT && (
        <p className="text-xs text-neutral-500">Showing the first {LIMIT} open appointments.</p>
      )}
      {items.length === 0 ? (
        <p data-testid="check-practitioner-empty" className="text-sm">
          Nothing to check: every open appointment has a practitioner who does not look misassigned.
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
                    {client ? clientDisplayName({ name: client.name ?? "", preferred_name: client.preferred_name }) : "Client"}
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
