import "server-only";
import { createClient } from "@/lib/supabase/server";
import type {
  ClientClinicalNote,
  ClinicalNoteKind,
  ClinicalNoteWithAuthor,
} from "@/lib/types/database";

// Read-side data access for the dedicated CONSULTATION / SKIN & HAIR ANALYSIS
// clinical records (migration 0126). All reads go through the RLS-gated
// authenticated client, so a practitioner only ever sees their own studio's
// notes. History reads are bounded (a paginated limit) so the main charting
// route never triggers an unbounded client-history load.

export const CLINICAL_NOTE_KINDS: ReadonlyArray<ClinicalNoteKind> = [
  "consultation",
  "skin_hair_analysis",
];

export const CLINICAL_NOTE_KIND_LABEL: Record<ClinicalNoteKind, string> = {
  consultation: "Consultation notes",
  skin_hair_analysis: "Skin & hair analysis",
};

// (ClinicalNoteWithAuthor lives in lib/types/database.ts so client components
// can import the type without pulling this server-only module.)

const SELECT_COLS =
  "id, client_id, studio_id, practitioner_id, kind, body, areas, occurred_at, supersedes_note_id, created_at";

async function attachAuthors(
  rows: ClientClinicalNote[],
): Promise<Map<string, string | null>> {
  const ids = [...new Set(rows.map((r) => r.practitioner_id))];
  if (ids.length === 0) return new Map();
  const supabase = await createClient();
  const { data } = await supabase
    .from("practitioners")
    .select("id, display_name")
    .in("id", ids);
  const map = new Map<string, string | null>();
  for (const p of (data ?? []) as Array<{ id: string; display_name: string | null }>) {
    map.set(p.id, p.display_name);
  }
  return map;
}

// The single non-superseded "current latest" entry for one kind, plus how many
// total entries exist for that kind (so the UI can offer "View history"). Bounded:
// pulls only the most-recent window per kind, which always contains the latest
// non-superseded row and any revision that superseded a recent row.
export async function getLatestClinicalNote(
  clientId: string,
  kind: ClinicalNoteKind,
): Promise<{ latest: ClinicalNoteWithAuthor | null; total: number }> {
  const supabase = await createClient();
  // Order by (occurred_at desc, created_at desc) — the head definition itself,
  // and the exact key of client_clinical_notes_latest_idx. The head (newest
  // non-superseded row) is therefore the first non-superseded row in this
  // window: any row on/after the head's date sorts within the window, so the
  // bounded fetch cannot skip the head. A missing table (pre-migration) yields
  // an empty result here rather than throwing (fail-soft).
  const { data, count } = await supabase
    .from("client_clinical_notes")
    .select(SELECT_COLS, { count: "exact" })
    .eq("client_id", clientId)
    .eq("kind", kind)
    .order("occurred_at", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(50);
  const rows = (data ?? []) as ClientClinicalNote[];
  const superseded = new Set(
    rows.map((r) => r.supersedes_note_id).filter((x): x is string => !!x),
  );
  // Newest by clinical event time, then insert time; the current head is the
  // newest row not superseded by any other row.
  const ordered = [...rows].sort(
    (a, b) =>
      new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime() ||
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
  const head = ordered.find((r) => !superseded.has(r.id)) ?? null;
  if (!head) return { latest: null, total: count ?? 0 };
  const authors = await attachAuthors([head]);
  return {
    latest: {
      ...head,
      author_name: authors.get(head.practitioner_id) ?? null,
      is_superseded: superseded.has(head.id),
    },
    total: count ?? 0,
  };
}

// The latest entry for BOTH kinds — the compact summary used on the client
// profile cards, appointment prep, and the charting screen.
export async function getClinicalNotesSummary(clientId: string): Promise<
  Record<ClinicalNoteKind, { latest: ClinicalNoteWithAuthor | null; total: number }>
> {
  const [consultation, skin] = await Promise.all([
    getLatestClinicalNote(clientId, "consultation"),
    getLatestClinicalNote(clientId, "skin_hair_analysis"),
  ]);
  return { consultation, skin_hair_analysis: skin };
}

// Complete dated history for one kind for the print/export view — pages through
// until exhausted, hard-capped so a pathological row count can never run away.
export async function getClinicalNotesForExport(
  clientId: string,
  kind: ClinicalNoteKind,
): Promise<ClinicalNoteWithAuthor[]> {
  const PAGE = 100;
  const HARD_CAP = 2000;
  const all: ClinicalNoteWithAuthor[] = [];
  for (let offset = 0; offset < HARD_CAP; offset += PAGE) {
    const { notes } = await getClinicalNoteHistory(clientId, kind, {
      limit: PAGE,
      offset,
    });
    all.push(...notes);
    if (notes.length < PAGE) break;
  }
  return all;
}

// Full dated history for one kind, newest first, paginated (bounded page size).
export async function getClinicalNoteHistory(
  clientId: string,
  kind: ClinicalNoteKind,
  opts: { limit?: number; offset?: number } = {},
): Promise<{ notes: ClinicalNoteWithAuthor[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  const supabase = await createClient();
  const { data, count } = await supabase
    .from("client_clinical_notes")
    .select(SELECT_COLS, { count: "exact" })
    .eq("client_id", clientId)
    .eq("kind", kind)
    .order("occurred_at", { ascending: false })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  const rows = (data ?? []) as ClientClinicalNote[];
  // Whether each row was superseded is derived across the FULL set of superseding
  // links for this client+kind (a page boundary must not mislabel a row).
  const { data: linkData } = await supabase
    .from("client_clinical_notes")
    .select("supersedes_note_id")
    .eq("client_id", clientId)
    .eq("kind", kind)
    .not("supersedes_note_id", "is", null);
  const superseded = new Set(
    ((linkData ?? []) as Array<{ supersedes_note_id: string | null }>)
      .map((r) => r.supersedes_note_id)
      .filter((x): x is string => !!x),
  );
  const authors = await attachAuthors(rows);
  return {
    notes: rows.map((r) => ({
      ...r,
      author_name: authors.get(r.practitioner_id) ?? null,
      is_superseded: superseded.has(r.id),
    })),
    total: count ?? 0,
  };
}
