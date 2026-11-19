import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { clientDisplayName } from "@/lib/clients/identity";
import { utcInstantFromLocal } from "@/lib/booking/tz";
import { readInChunks } from "@/lib/dashboard/in-chunks";
import { createClient } from "@/lib/supabase/server";
import type { Studio } from "@/lib/types/database";

import { buildDirectory, type DirectoryResult, type FinderClient } from "./statement-directory";
import { readAppointmentsKeyset, readMoneyForAppointments, readVisitNames } from "./statement-money-read";
import { isYearMonth, monthRange, STATEMENT_MAX_SANE_MONTH, STATEMENT_MIN_MONTH, type YearMonth } from "./statement-period";

// ===========================================================================
// The reads behind the Clients tab and Find a client. READ-ONLY, owner-only, fail-closed.
// ===========================================================================
// The OWNER GATE is the first statement of each exported function: no client is built and no query is made for anyone else. Invoker client only
// (row-level security), no service role, no write, no Stripe, no mail. The studio is the signed-in practitioner's studio, never a request value.
// The month is the STUDIO's calendar month: two separate local-midnight instants (a DST day is 23 or 25 hours), then every appointment in that window
// is read by keyset paging, so the figures cover the whole month or the read fails; a partial month is never shown as a whole one.

export type StatementDirectoryRead =
  | { access: "refused" }
  | { access: "granted"; ok: false; reason: "read_failed" | "too_many_appointments" | "currency_unknown" | "month_out_of_range" }
  | { access: "granted"; ok: true; month: YearMonth; label: string; timezone: string; directory: DirectoryResult };

export async function loadStatementDirectory(
  practitioner: { readonly role: string },
  studio: Pick<Studio, "id" | "timezone">,
  studioCurrency: string | null,
  month: YearMonth,
  now: Date,
  supabaseClient: SupabaseClient | undefined = undefined,
): Promise<StatementDirectoryRead> {
  if (practitioner.role !== "owner") return { access: "refused" };
  if (!studioCurrency) return { access: "granted", ok: false, reason: "currency_unknown" };
  if (!isYearMonth(month) || month < STATEMENT_MIN_MONTH || month > STATEMENT_MAX_SANE_MONTH) return { access: "granted", ok: false, reason: "month_out_of_range" };
  const failed = { access: "granted", ok: false, reason: "read_failed" } as const;

  const supabase = supabaseClient ?? (await createClient());
  const range = monthRange(month);
  const startUtc = utcInstantFromLocal(range.startLocal, "00:00", studio.timezone).toISOString();
  const endUtc = utcInstantFromLocal(range.endLocalExclusive, "00:00", studio.timezone).toISOString();

  const appts = await readAppointmentsKeyset(supabase, studio.id, { startUtc, endUtc });
  if (!appts.ok) return appts.reason === "too_many_appointments" ? { access: "granted", ok: false, reason: "too_many_appointments" } : failed;
  const money = await readMoneyForAppointments(supabase, studio.id, appts.rows.map((a) => a.id));
  if (!money.ok) return failed;
  const { serviceNames, practitionerNames } = await readVisitNames(supabase, studio.id, appts.rows);

  // Names are labels, but a missing one would put a figure under the wrong heading, so a failed name read fails the whole read.
  const clientIds = [...new Set(appts.rows.map((a) => a.clientId))];
  const names = clientIds.length
    ? await readInChunks<{ id: string; name: string | null; preferred_name: string | null }>(clientIds, (chunk) =>
        supabase.from("clients").select("id, name, preferred_name").eq("studio_id", studio.id).in("id", chunk),
      )
    : { ok: true as const, rows: [] as { id: string; name: string | null; preferred_name: string | null }[] };
  if (!names.ok) return failed;
  const clientNames = new Map<string, string>(names.rows.map((r) => [r.id, clientDisplayName({ name: r.name ?? "", preferred_name: r.preferred_name })]));

  const built = buildDirectory({
    studioCurrency,
    timezone: studio.timezone,
    nowIso: now.toISOString(),
    month,
    appointments: appts.rows,
    cardRows: money.cardRows,
    settlementRows: money.settlementRows,
    legacyFeeRows: money.legacyFeeRows,
    serviceNames,
    practitionerNames,
    clientNames,
  });
  if (!built.ok) return failed;
  return { access: "granted", ok: true, month, label: range.label, timezone: studio.timezone, directory: built.value };
}

export type FinderClientsRead =
  | { access: "refused" }
  | { access: "granted"; ok: false; reason: "read_failed" }
  | { access: "granted"; ok: true; clients: FinderClient[] };

const FINDER_COLUMNS = "id, name, preferred_name, archived_at"; // NARROW: no email, phone, pronouns or any other field is ever selected
const FINDER_BLOCK = 500;
const FINDER_MAX_BLOCKS = 50;

/** Every client of the signed-in owner's studio (active and archived), for Find a client. Names only: the server never holds a client's email or phone for this read. */
export async function loadFinderClients(
  practitioner: { readonly role: string },
  studio: Pick<Studio, "id">,
  supabaseClient: SupabaseClient | undefined = undefined,
): Promise<FinderClientsRead> {
  if (practitioner.role !== "owner") return { access: "refused" };
  const supabase = supabaseClient ?? (await createClient());
  const failed = { access: "granted", ok: false, reason: "read_failed" } as const;
  const clients: FinderClient[] = [];
  const seen = new Set<string>();
  let afterId: string | null = null;
  for (let block = 0; ; block++) {
    if (block >= FINDER_MAX_BLOCKS) return failed; // never a partial list as if whole
    let q = supabase.from("clients").select(FINDER_COLUMNS).eq("studio_id", studio.id);
    if (afterId !== null) q = q.gt("id", afterId);
    const { data, error } = await q.order("id", { ascending: true }).limit(FINDER_BLOCK);
    if (error) return failed;
    const rows = (data ?? []) as unknown as { id: string; name: string | null; preferred_name: string | null; archived_at: string | null }[];
    if (rows.length > FINDER_BLOCK) return failed;
    for (const r of rows) {
      if (seen.has(r.id)) return failed;
      seen.add(r.id);
      clients.push({ id: r.id, name: r.name ?? "", preferredName: r.preferred_name ?? null, archived: r.archived_at !== null && r.archived_at !== undefined });
    }
    if (rows.length < FINDER_BLOCK) break;
    afterId = rows[rows.length - 1].id;
  }
  return { access: "granted", ok: true, clients };
}
