// HON-58 — reading a client's legal identity (public.client_legal_identities).
//
// The table is readable only by an active owner or practitioner of the studio
// (receptionists, anon and service_role are denied by the database), so every
// reader here takes the SIGNED-IN supabase client and never an admin client: a
// caller that is not authorized simply gets no rows. A read that FAILS is
// reported as unavailable, never as "this client has no legal identity", so a
// surface can fall back to the stored name on purpose rather than by accident.
//
// Nothing here logs a name, and no legal name is inferred from anything.

import { clientLegalName, type ClientIdentityFields } from "@/lib/clients/identity";
import { isMissingRelationError } from "@/lib/supabase/missing-relation";

export const LEGAL_IDENTITY_COLUMNS =
  "client_id, legal_given_name, legal_middle_name, legal_family_name";

export type LegalIdentityRow = Pick<
  ClientIdentityFields,
  "legal_given_name" | "legal_middle_name" | "legal_family_name"
> & { client_id: string };

type ReadResult<T> = { ok: true; value: T } | { ok: false };

// The signed-in supabase client, typed loosely on purpose: passing the SDK's
// own builder types through a generic parameter makes the compiler recurse
// (TS2589). Each read narrows to the small Builder shape it actually uses.
type SupabaseLike = { from: (table: string) => unknown };
type Table = { select: (columns: string) => Builder };

// The two reads below only chain what PostgREST's builder provides; the loose
// types keep this module testable with a small fake and free of SDK types.
type Builder = {
  eq: (column: string, value: string) => Builder;
  in: (column: string, values: string[]) => Builder;
  gt: (column: string, value: string) => Builder;
  order: (column: string, opts: { ascending: boolean }) => Builder;
  range: (from: number, to: number) => Builder;
  maybeSingle: () => PromiseLike<{ data: unknown; error: unknown }>;
  then: PromiseLike<{ data: unknown; error: unknown }>["then"];
};

const PAGE = 1000;

/** One client's legal identity, or null when none is recorded. */
export async function readLegalIdentity(
  supabase: SupabaseLike,
  clientId: string,
): Promise<ReadResult<LegalIdentityRow | null>> {
  const q = (supabase.from("client_legal_identities") as Table).select(LEGAL_IDENTITY_COLUMNS);
  const { data, error } = await q.eq("client_id", clientId).maybeSingle();
  if (error) return { ok: false };
  return { ok: true, value: (data as LegalIdentityRow | null) ?? null };
}

/**
 * The combined legal name of every client in the studio that has one, keyed by
 * client id. Paged by id so no page can be silently cut by the API row cap.
 */
export async function readLegalNamesForStudio(
  supabase: SupabaseLike,
  studioId: string,
): Promise<ReadResult<Map<string, string>>> {
  const names = new Map<string, string>();
  let afterId: string | null = null;
  for (;;) {
    let q = (supabase.from("client_legal_identities") as Table).select(LEGAL_IDENTITY_COLUMNS).eq("studio_id", studioId);
    if (afterId !== null) q = q.gt("client_id", afterId);
    const { data, error } = (await q.order("client_id", { ascending: true }).range(0, PAGE - 1)) as {
      data: LegalIdentityRow[] | null;
      error: unknown;
    };
    if (error) return { ok: false };
    const rows = data ?? [];
    if (rows.length === 0) return { ok: true, value: names };
    for (const row of rows) {
      const legal = clientLegalName(row);
      if (legal) names.set(row.client_id, legal);
    }
    afterId = rows[rows.length - 1].client_id;
  }
}

/** The legal names for the given clients only (a print or a detail view). */
export async function readLegalNamesForClients(
  supabase: SupabaseLike,
  clientIds: readonly string[],
): Promise<ReadResult<Map<string, string>>> {
  const names = new Map<string, string>();
  const unique = [...new Set(clientIds)];
  for (let i = 0; i < unique.length; i += 200) {
    const chunk = unique.slice(i, i + 200);
    const q = (supabase.from("client_legal_identities") as Table).select(LEGAL_IDENTITY_COLUMNS);
    const { data, error } = (await q.in("client_id", chunk)) as { data: LegalIdentityRow[] | null; error: unknown };
    // Before migration 0258 the table does not exist, so NO client has a legal
    // identity: that is an empty answer, not a failure. Only this table's
    // missing-relation error is tolerated; every other error stays unavailable.
    if (isMissingRelationError(error, "client_legal_identities")) return { ok: true, value: new Map() };
    if (error) return { ok: false };
    for (const row of data ?? []) {
      const legal = clientLegalName(row);
      if (legal) names.set(row.client_id, legal);
    }
  }
  return { ok: true, value: names };
}
