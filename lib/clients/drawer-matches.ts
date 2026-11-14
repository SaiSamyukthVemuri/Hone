import { matchesClientSearch, sortByMatchRank, type SearchableClient } from "@/lib/clients/name-search";

/**
 * The booking drawer's "Find existing client" list: filter with the shared matcher, order BEST MATCH FIRST
 * (exact name, name prefix, word-start, looser name, email, then the rest; ties by name then id), THEN cap.
 * Ranking before the cap is the point: with more matches than the cap, an exact match must not be cut off
 * by alphabetical order. An empty query keeps the caller's order (just-added clients first). A client present twice (same id) appears once.
 */
export function rankDrawerClients<T extends SearchableClient & { id?: string }>(
  clients: readonly T[],
  rawQuery: string,
  max: number,
): { matches: T[]; total: number } {
  const query = rawQuery.trim();
  // The drawer merges its just-added clients with the server list, and after a create BOTH hold the client:
  // keep the first occurrence of an id (the just-added one comes first), so it is listed and counted once.
  const seen = new Set<string>();
  const unique = clients.filter((c) => {
    if (c.id === undefined) return true;
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });
  const found = unique.filter((c) => matchesClientSearch(c, query));
  const ordered = query.length === 0 ? found : sortByMatchRank(found, query);
  return { matches: ordered.slice(0, max), total: found.length };
}
