// HON-58 — the names a printed clinical record carries, for a batch of clients.
//
// A printed clinical record (the invasive-procedure register, a chart) carries
// the LEGAL identity with the preferred name beside it in parentheses (OPS Q2).
// The record rows already hold the stored name; this reads the other two for
// the clients on the page with the SIGNED-IN client only (client_legal_identities
// is readable by an active owner or practitioner and nobody else), and works
// before migration 0258 exists (preferred_name is read through
// readWithPreferredName, and a missing legal table reads as "unavailable").
//
// `ok: false` means at least one read failed. The caller then prints the stored
// names and SAYS SO on the page; it never claims a legal name it could not read.

import { readLegalNamesForClients } from "@/lib/clients/legal-identity";
import { preferredNameColumn, readWithPreferredName } from "@/lib/clients/preferred-name-read";

export type PrintIdentity = { preferred_name: string | null; legal_name: string | null };
export type PrintIdentities = { ok: boolean; byClient: Map<string, PrintIdentity> };

type Reader = { from: (table: string) => unknown };
type ClientsTable = { select: (columns: string) => { in: (column: string, values: string[]) => PromiseLike<{ data: unknown; error: { code?: string | null; message?: string | null } | null }> } };

export async function readPrintIdentities(
  supabase: Reader,
  clientIds: readonly string[],
): Promise<PrintIdentities> {
  const ids = [...new Set(clientIds.filter((id) => id.length > 0))];
  const byClient = new Map<string, PrintIdentity>();
  if (ids.length === 0) return { ok: true, byClient };
  let ok = true;

  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { data, error } = await readWithPreferredName((withPreferred) =>
      (supabase.from("clients") as ClientsTable).select(`id, ${preferredNameColumn(withPreferred)}name`).in("id", chunk),
    );
    if (error) {
      ok = false;
      continue;
    }
    for (const row of (data ?? []) as Array<{ id: string; preferred_name?: string | null }>) {
      byClient.set(row.id, { preferred_name: row.preferred_name ?? null, legal_name: null });
    }
  }

  const legal = await readLegalNamesForClients(supabase, ids);
  if (!legal.ok) ok = false;
  else {
    for (const [id, name] of legal.value) {
      const existing = byClient.get(id) ?? { preferred_name: null, legal_name: null };
      byClient.set(id, { ...existing, legal_name: name });
    }
  }
  return { ok, byClient };
}
