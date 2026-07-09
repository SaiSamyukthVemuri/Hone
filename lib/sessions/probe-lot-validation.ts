import "server-only";

// Server-side probe-lot validation (Charting Validation PR 3).
//
// probe_lots is a studio-scoped inventory table. A client-supplied probe_lot_id
// must never be trusted: it has to be a well-formed UUID that belongs to the
// caller's OWN studio. This validator enforces that before any write. Free-text
// probe_lot_number is a separate, manual/unverified field and is NOT touched
// here — a manual lot never becomes an inventory-verified probe_lot_id.

// Type-only inline import so there is no runtime/unused import of createClient.
type ServerSupabase = Awaited<
  ReturnType<typeof import("@/lib/supabase/server").createClient>
>;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string | null | undefined): boolean {
  return typeof value === "string" && UUID_RE.test(value.trim());
}

export type ProbeLotValidation =
  | { ok: true; value: string | null }
  | { ok: false; error: string };

// Validate a client-supplied probe_lot_id:
//   empty/null   -> ok, null (no inventory lot; manual/free-text is fine)
//   malformed    -> rejected (not a UUID)
//   wrong studio -> rejected (not in the caller's probe_lots inventory)
//   valid        -> ok, the id
// The lookup is studio-scoped AND RLS-scoped (probe_lots is members-only for the
// caller's studio), so a cross-studio id returns no row and is rejected.
export async function validateProbeLotId(
  supabase: ServerSupabase,
  studioId: string,
  raw: string | null | undefined,
): Promise<ProbeLotValidation> {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  if (!isUuid(trimmed)) {
    return { ok: false, error: "That probe lot reference is invalid." };
  }
  const { data, error } = await supabase
    .from("probe_lots")
    .select("id")
    .eq("id", trimmed)
    .eq("studio_id", studioId)
    .maybeSingle();
  if (error) {
    return { ok: false, error: "Could not verify the probe lot. Please try again." };
  }
  if (!data) {
    return {
      ok: false,
      error: "That probe lot isn’t in your studio’s inventory.",
    };
  }
  return { ok: true, value: trimmed };
}
