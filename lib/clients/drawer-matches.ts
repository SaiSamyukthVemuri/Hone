import { matchesClientSearch, sortByMatchRank, type SearchableClient } from "@/lib/clients/name-search";

/**
 * The booking drawer's "Find existing client" list: filter with the shared matcher, order BEST MATCH FIRST
 * (exact name, name prefix, word-start, looser name, email, then the rest; ties by name then id), THEN cap.
 * Ranking before the cap is the point: with more matches than the cap, an exact match must not be cut off
 * by alphabetical order. An empty query keeps the caller's order (just-added clients first).
 */
export function rankDrawerClients<T extends SearchableClient & { id?: string }>(
  clients: readonly T[],
  rawQuery: string,
  max: number,
): { matches: T[]; total: number } {
  const query = rawQuery.trim();
  const found = clients.filter((c) => matchesClientSearch(c, query));
  const ordered = query.length === 0 ? found : sortByMatchRank(found, query);
  return { matches: ordered.slice(0, max), total: found.length };
}
