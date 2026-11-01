import { clientDisplayName } from "@/lib/clients/identity";
import { preferredNameColumn, readWithPreferredName } from "@/lib/clients/preferred-name-read";
import type { createClient } from "@/lib/supabase/server";

// ONE way for the dashboard to turn client ids into the name staff see
// (HON-58 / Privacy C1): the preferred name, else the stored name, through the
// existing identity helper. Read-only, studio-scoped, id/name/preferred only;
// chunked so no URL grows without bound. Throws a fixed message on any error so
// the caller decides how to degrade.

type Supabase = Awaited<ReturnType<typeof createClient>>;

const CLIENT_CHUNK = 100;
export const DISPLAY_NAME_FALLBACK = "Client";

export async function getClientDisplayNames(
  supabase: Supabase,
  studioId: string,
  clientIds: ReadonlyArray<string>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(clientIds)];
  for (let i = 0; i < ids.length; i += CLIENT_CHUNK) {
    const chunk = ids.slice(i, i + CLIENT_CHUNK);
    const { data, error } = await readWithPreferredName((withPreferred) =>
      supabase
        .from("clients")
        .select(`id, name, ${preferredNameColumn(withPreferred)}archived_at`)
        .eq("studio_id", studioId)
        .in("id", chunk),
    );
    if (error) throw new Error("Failed to load client names");
    for (const c of (data ?? []) as unknown as Array<{
      id: string;
      name: string;
      preferred_name?: string | null;
    }>) {
      out.set(c.id, clientDisplayName(c));
    }
  }
  return out;
}

// Gives each procedure-record detail gap the DISPLAY name. The procedure record
// itself is a regulatory document and keeps the stored name; only this
// dashboard projection changes. If names cannot be read, the neutral label is
// used: never the stored name of a client who may go by another.
export async function withDisplayNamesOnDetailGaps<
  T extends { detailGaps?: Array<{ clientId: string; clientName: string }> },
>(supabase: Supabase, studioId: string, actions: T): Promise<T> {
  const gaps = actions.detailGaps;
  if (!gaps || gaps.length === 0) return actions;
  let names: Map<string, string>;
  try {
    names = await getClientDisplayNames(supabase, studioId, gaps.map((g) => g.clientId));
  } catch {
    names = new Map();
  }
  return {
    ...actions,
    detailGaps: gaps.map((g) => ({ ...g, clientName: names.get(g.clientId) || DISPLAY_NAME_FALLBACK })),
  };
}
