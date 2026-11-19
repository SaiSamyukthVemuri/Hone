import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { clientDisplayName } from "@/lib/clients/identity";
import { createClient } from "@/lib/supabase/server";
import type { Studio } from "@/lib/types/database";

import { assembleClientInputs } from "./statement-document-assemble";
import { readAppointmentsKeyset, readMoneyForAppointments, readVisitNames } from "./statement-money-read";
import type { DocumentVisitInput, FeeItemInput } from "./statement-document";

// ===========================================================================
// The read behind a client's statement or invoice. READ-ONLY, owner-only, fail-closed.
// ===========================================================================
//
// No INSERT, UPDATE, DELETE, RPC, Stripe call, mail or migration, and NO service-role client: every read runs as the signed-in owner through the
// invoker client under RLS. The money tables are owner-readable only (0254); for any other role they return zero rows WITH NO ERROR, which would
// read as "no money". So the owner gate is the FIRST statement and no client is built, and no query is made, for anyone else.
//
// STUDIO AND CLIENT come from the signed-in practitioner's studio and a client id that is verified to belong to that studio BEFORE any visit or
// money is read. A client of another studio and an unknown id give the SAME `client_not_found`, so an id cannot be probed across studios.
//
// IT STARTS FROM THE CLIENT'S APPOINTMENTS (appointment-first), so a visit with no money row is kept. Appointments are read by KEYSET paging
// ((starts_at, id), 500 per page), never one capped read: the whole history is read, in full, or the read fails. The document built from it is
// therefore computed over the FULL scope; presentation paging (a later screen) slices the finished document and cannot change a count or a total.
//
// FAILS CLOSED. Any failed read, any money read that reaches the row cap (PostgREST truncates without an error), or a history beyond MAX_PAGES
// makes the whole read unavailable. A partial history is never presented as a complete one.

export { MAX_PAGES } from "./statement-money-read";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ClientStatementRead =
  | { access: "refused" }
  | { access: "granted"; ok: false; reason: "read_failed" | "too_many_appointments" | "currency_unknown" | "invalid_client" | "client_not_found" }
  | {
      access: "granted";
      ok: true;
      client: { id: string; name: string };
      timezone: string;
      studioCurrency: string;
      visits: DocumentVisitInput[];
      feeItems: FeeItemInput[];
      /** Appointments left off the document that nevertheless carry money (a future booking with a payment). */
      offDocumentWithMoney: number;
    };

export async function loadClientStatementRead(
  practitioner: { readonly role: string },
  studio: Pick<Studio, "id" | "timezone">,
  studioCurrency: string | null,
  clientId: string,
  now: Date,
  supabaseClient: SupabaseClient | undefined = undefined,
): Promise<ClientStatementRead> {
  // FIRST STATEMENT. Nothing below runs for a non-owner.
  if (practitioner.role !== "owner") return { access: "refused" };
  if (!studioCurrency) return { access: "granted", ok: false, reason: "currency_unknown" };
  if (typeof clientId !== "string" || !UUID.test(clientId)) return { access: "granted", ok: false, reason: "invalid_client" };

  const supabase = supabaseClient ?? (await createClient());
  const failed = { access: "granted", ok: false, reason: "read_failed" } as const;

  // The client must belong to THIS studio before anything else is read.
  const { data: clientRow, error: clientError } = await supabase
    .from("clients")
    .select("id, name, preferred_name")
    .eq("id", clientId)
    .eq("studio_id", studio.id)
    .maybeSingle();
  if (clientError) return failed;
  if (!clientRow) return { access: "granted", ok: false, reason: "client_not_found" };
  const clientName = clientDisplayName({ name: (clientRow as { name: string | null }).name ?? "", preferred_name: (clientRow as { preferred_name: string | null }).preferred_name });

  // Appointment-first, keyset-paged over the full history (shared read).
  const apptRead = await readAppointmentsKeyset(supabase, studio.id, { clientId });
  if (!apptRead.ok) return apptRead.reason === "too_many_appointments" ? { access: "granted", ok: false, reason: "too_many_appointments" } : failed;
  const appts = apptRead.rows;
  if (appts.length === 0) return { access: "granted", ok: true, client: { id: clientId, name: clientName }, timezone: studio.timezone, studioCurrency, visits: [], feeItems: [], offDocumentWithMoney: 0 };

  const money = await readMoneyForAppointments(supabase, studio.id, appts.map((a) => a.id));
  if (!money.ok) return failed;
  const { serviceNames, practitionerNames } = await readVisitNames(supabase, studio.id, appts);

  const assembled = assembleClientInputs({
    studioCurrency,
    timezone: studio.timezone,
    nowIso: now.toISOString(),
    appointments: appts,
    cardRows: money.cardRows,
    settlementRows: money.settlementRows,
    legacyFeeRows: money.legacyFeeRows,
    serviceNames,
    practitionerNames,
  });

  return {
    access: "granted",
    ok: true,
    client: { id: clientId, name: clientName },
    timezone: studio.timezone,
    studioCurrency,
    visits: assembled.visits,
    feeItems: assembled.feeItems,
    offDocumentWithMoney: assembled.offDocumentWithMoney,
  };
}
