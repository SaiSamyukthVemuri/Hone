import { createClient } from "@/lib/supabase/server";
import { safeLog } from "@/lib/logging/safe-log";

// Page-level permission questions that can NEVER take the page down. The Client Profile reads its gates alongside independent units; a gate
// whose client or engine call rejects must not reject the page (PERF-02C containment). `contained` turns any failure into "not allowed" (fail
// closed): the unit renders as unavailable, nothing is read for it, and the failure is logged without data.
// The call sites keep their own literal `requirePermission(..., "<key>")` so the reader guard still sees the key; only the client creation and
// the containment live here. createClient is called HERE (not in the page file) because the containment seam attributes createClient calls
// by the immediate caller frame.
export const gateClient = () => createClient();

export async function contained(key: string, ask: () => Promise<boolean>): Promise<boolean> {
  try {
    return await ask();
  } catch (e) {
    safeLog.error(JSON.stringify({ event: "permission_check_failed", key, error: e instanceof Error ? e.name : "unknown", timestamp: new Date().toISOString() }));
    return false;
  }
}

/** Run once per request-scope: the first caller starts it, every later caller shares the same promise. */
export function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | undefined;
  return () => (p ??= fn());
}
