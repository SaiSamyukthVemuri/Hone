"use server";

import { createClient } from "@/lib/supabase/server";
import {
  getCurrentPractitionerWithStudio,
  getSessionBlockAreasByBlockIds,
} from "@/lib/supabase/queries";
import { blockAreasLabel } from "@/lib/sessions/block-areas";
import {
  escapeIlike,
  filterPageShortcuts,
  sanitizeQuery,
  statusForQuery,
  SEARCH_MIN_CHARS,
  SEARCH_TOTAL_CAP,
  type SearchResult,
} from "@/lib/search/global-search";
import { mergeMemoryBlockRows } from "@/lib/search/treatment-memory-merge";

// Global Search V1 server action (PR #232).
//
// Security posture:
//   * Requires an authenticated practitioner; resolves the CURRENT
//     studio and filters every query by studio_id explicitly, with
//     RLS as the backstop (user-scoped client only; no admin client,
//     no service role anywhere in this file).
//   * Returns only sanitized result objects (id/type/title/subtitle/
//     href/date/badge). No tokens, no Stripe ids, no payment rows,
//     no exposure incident content, no audit payloads.
//   * Every href is app-internal.
//
// Each category is capped; queries are simple ILIKE scans bounded by
// studio + limit, fine at pilot scale (documented follow-up: add
// trigram indexes if a studio ever grows past that).

const CLIENT_CAP = 5;
const APPOINTMENT_CAP = 4;
const MEMORY_CAP = 4;
const RECORD_CAP = 3;

// Child (structured treatment area) candidates to consider before deduplication.
// A small multiple of MEMORY_CAP, not MEMORY_CAP itself: several areas can point
// at the SAME block ("Left Cheek" + "Right Cheek"), and a block already found by
// the direct path can appear here too, so a cap of 4 area rows could easily
// resolve to fewer than 4 distinct new blocks. The final memory list is still
// capped at MEMORY_CAP after the merge, so widening this changes recall, never
// how many results a practitioner sees.
const MEMORY_CHILD_CANDIDATE_CAP = MEMORY_CAP * 5;

// Selected once and reused by BOTH memory paths (direct text match and the
// parent fetch for child-area matches). Sharing the literal is what lets the two
// result sets be merged as interchangeable rows — if they drifted, a block found
// only via its child area could render a different subtitle from the same block
// found directly.
// `!inner` is load-bearing, not decoration. A plain embed filters the EMBED, not
// the parent: with `session:sessions(...)` a block whose session is soft-deleted
// or void still comes back, just with `session: null` — which then renders an
// href of `/clients/undefined/sessions/…`. Measured against the local stack:
//   session_blocks, no filter ................................. 283
//   `!inner` + session.record_status=neq.void ................. 280  ← parents dropped
//   plain embed + session.record_status=neq.void .............. 283  ← nothing dropped
// So the inner join is what makes the parent-session filters below actually
// remove rows, and it removes them in the DATABASE — before ordering and before
// the cap — so an inactive record can never occupy one of the four slots.
const MEMORY_BLOCK_SELECT =
  "id, session_id, primary_area, side, block_name, caution_note, reaction_notes, probe_label, probe_lot_number, created_at, session:sessions!inner(client_id, started_at, deleted_at, record_status, client:clients(name))";

// A treatment record is SEARCHABLE only while its parent session is active.
// `sessions.record_status` is `text NOT NULL check (record_status in ('draft',
// 'finalized','void'))`, so `neq` is safe here — a NULL would make `<>` yield
// NULL and silently drop the row, and the column cannot be NULL.
// 'void' is the retired/withdrawn record; 'draft' and 'finalized' are both live.
const SESSION_ACTIVE_FILTERS = {
  deletedAt: "session.deleted_at",
  recordStatus: "session.record_status",
} as const;
const VOID_RECORD_STATUS = "void";

type MemoryBlockSession = {
  client_id: string | null;
  started_at: string | null;
  deleted_at: string | null;
  record_status: string | null;
  client: { name: string | null } | Array<{ name: string | null }> | null;
};

type MemoryBlockRow = {
  id: string;
  session_id: string | null;
  primary_area: string | null;
  side: string | null;
  block_name: string | null;
  caution_note: string | null;
  reaction_notes: string | null;
  probe_label: string | null;
  probe_lot_number: string | null;
  created_at: string | null;
  session: MemoryBlockSession | MemoryBlockSession[] | null;
};

function fmtDate(iso: string | null | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString().slice(0, 10);
}

export async function globalSearchAction(
  rawQuery: string,
): Promise<{ ok: true; results: SearchResult[] } | { ok: false }> {
  let studioId: string;
  try {
    const { studio } = await getCurrentPractitionerWithStudio();
    studioId = studio.id;
  } catch {
    return { ok: false };
  }

  const query = sanitizeQuery(rawQuery ?? "");
  if (query.length < SEARCH_MIN_CHARS) {
    return { ok: true, results: filterPageShortcuts("") };
  }
  const like = `%${escapeIlike(query)}%`;
  const supabase = await createClient();

  const [
    clientRows,
    blockRows,
    childAreaRows,
    noteRows,
    sterileRows,
    disinfectantRows,
  ] = await Promise.all([
    supabase
      .from("clients")
      .select("id, name, email, phone")
      .eq("studio_id", studioId)
      .is("archived_at", null)
      .or(`name.ilike.${like},email.ilike.${like},phone.ilike.${like}`)
      .order("name")
      .limit(CLIENT_CAP)
      .then((r) => r.data ?? []),
    supabase
      .from("session_blocks")
      .select(MEMORY_BLOCK_SELECT)
      .eq("studio_id", studioId)
      .is("deleted_at", null)
      // The block being live is not enough — a live block can hang off a session
      // that was soft-deleted or voided, and surfacing it would expose treatment
      // history the studio logically removed AND hand back a link that 404s.
      .is(SESSION_ACTIVE_FILTERS.deletedAt, null)
      .neq(SESSION_ACTIVE_FILTERS.recordStatus, VOID_RECORD_STATUS)
      .or(
        `primary_area.ilike.${like},block_name.ilike.${like},caution_note.ilike.${like},reaction_notes.ilike.${like},probe_label.ilike.${like},probe_lot_number.ilike.${like}`,
      )
      .order("created_at", { ascending: false })
      .limit(MEMORY_CAP)
      .then((r) => r.data ?? []),
    // Structured treatment areas (migration 0128). The block columns above
    // only carry the LEGACY primary_area, so a block charted as
    // "Left Cheek · Right Sideburn" is stored with primary_area "Cheek" and
    // searching "Sideburn" matched nothing — the secondary area was displayed
    // correctly but was unreachable. This is a bounded id-only probe; the
    // parent blocks themselves are fetched in the next wave under the SAME
    // rules as the direct path — studio scope, live block, and an ACTIVE
    // non-void parent session — so a stale, foreign or withdrawn child can
    // never become a result on its own. session_block_areas has no soft-delete
    // column of its own: it cascades with the parent, so every liveness
    // decision belongs to the parent fetch.
    supabase
      .from("session_block_areas")
      .select("session_block_id")
      .eq("studio_id", studioId)
      .ilike("area", like)
      .order("created_at", { ascending: false })
      .limit(MEMORY_CHILD_CANDIDATE_CAP)
      .then((r) => r.data ?? []),
    supabase
      .from("sessions")
      .select("id, client_id, started_at, next_session_note, client:clients(name)")
      .eq("studio_id", studioId)
      .is("deleted_at", null)
      // Same liveness rule as the block paths: a voided session's next-visit
      // note is withdrawn treatment history and must not be searchable.
      .neq("record_status", VOID_RECORD_STATUS)
      .ilike("next_session_note", like)
      .order("started_at", { ascending: false })
      .limit(2)
      .then((r) => r.data ?? []),
    supabase
      .from("record_keeping_sterile_items")
      .select("id, item_description, lot_number, date_purchased")
      .eq("studio_id", studioId)
      .or(`lot_number.ilike.${like},item_description.ilike.${like}`)
      .order("date_purchased", { ascending: false })
      .limit(RECORD_CAP)
      .then((r) => r.data ?? []),
    supabase
      .from("record_keeping_disinfectants")
      .select("id, disinfectant_name, date_prepared")
      .eq("studio_id", studioId)
      .ilike("disinfectant_name", like)
      .order("date_prepared", { ascending: false })
      .limit(2)
      .then((r) => r.data ?? []),
  ]);

  // Appointments: by matched client, by service-name match, and by
  // status keyword. Bounded follow-up reads, deduped by id.
  const clientIds = clientRows.map((c) => c.id as string);
  const status = statusForQuery(query);
  // Parent blocks for the child-area matches: ONE bounded query for all matching
  // child block ids (never one query per area row, and never one area query per
  // block). Every integrity check the direct path applies is re-applied here —
  // explicit studio scoping, soft-delete exclusion, and RLS as the backstop —
  // because a child row is only ever a POINTER; the parent is what is allowed to
  // become a result.
  const childBlockIds = [
    ...new Set(
      (childAreaRows as Array<{ session_block_id?: unknown }>)
        .map((r) => r.session_block_id)
        .filter((id): id is string => typeof id === "string" && id !== ""),
    ),
  ];
  const [serviceRows, apptByClient, apptByStatus, childBlockRows] = await Promise.all([
    supabase
      .from("services")
      .select("id, name")
      .eq("studio_id", studioId)
      .ilike("name", like)
      .limit(3)
      .then((r) => r.data ?? []),
    clientIds.length > 0
      ? supabase
          .from("appointments")
          .select(
            "id, starts_at, status, client:clients(name), service:services(name)",
          )
          .eq("studio_id", studioId)
          .in("client_id", clientIds)
          .order("starts_at", { ascending: false })
          .limit(APPOINTMENT_CAP)
          .then((r) => r.data ?? [])
      : Promise.resolve([]),
    status
      ? supabase
          .from("appointments")
          .select(
            "id, starts_at, status, client:clients(name), service:services(name)",
          )
          .eq("studio_id", studioId)
          .eq("status", status)
          .order("starts_at", { ascending: false })
          .limit(3)
          .then((r) => r.data ?? [])
      : Promise.resolve([]),
    childBlockIds.length > 0
      ? supabase
          .from("session_blocks")
          .select(MEMORY_BLOCK_SELECT)
          .eq("studio_id", studioId)
          .is("deleted_at", null)
          // Identical liveness rules to the direct path — a child area must not
          // be a back door to a record the direct path would refuse.
          .is(SESSION_ACTIVE_FILTERS.deletedAt, null)
          .neq(SESSION_ACTIVE_FILTERS.recordStatus, VOID_RECORD_STATUS)
          .in("id", childBlockIds)
          .order("created_at", { ascending: false })
          .limit(MEMORY_CAP)
          .then((r) => r.data ?? [])
      : Promise.resolve([]),
  ]);
  const apptByService =
    serviceRows.length > 0
      ? await supabase
          .from("appointments")
          .select(
            "id, starts_at, status, client:clients(name), service:services(name)",
          )
          .eq("studio_id", studioId)
          .in("service_id", serviceRows.map((s) => s.id as string))
          .order("starts_at", { ascending: false })
          .limit(3)
          .then((r) => r.data ?? [])
      : [];

  const results: SearchResult[] = [];

  for (const c of clientRows) {
    results.push({
      id: `client:${c.id}`,
      type: "client",
      title: (c.name as string) || "Client",
      subtitle:
        (c.email as string | null) || (c.phone as string | null) || undefined,
      href: `/clients/${c.id}`,
    });
  }

  const seenAppointments = new Set<string>();
  for (const a of [...apptByClient, ...apptByService, ...apptByStatus]) {
    const id = a.id as string;
    if (seenAppointments.has(id)) continue;
    seenAppointments.add(id);
    if (seenAppointments.size > APPOINTMENT_CAP) break;
    const client = Array.isArray(a.client) ? a.client[0] : a.client;
    const service = Array.isArray(a.service) ? a.service[0] : a.service;
    results.push({
      id: `appointment:${id}`,
      type: "appointment",
      title: (client?.name as string) || "Appointment",
      subtitle: (service?.name as string) || undefined,
      href: `/calendar/${id}`,
      date: fmtDate(a.starts_at as string),
      badge: (a.status as string) || undefined,
    });
  }

  // Merge the two memory paths into one result set. Deduplication by block id
  // happens BEFORE the cap, so a block that matched both directly and through a
  // child area consumes one slot rather than two — capping first would let a
  // duplicate hide a distinct treatment. Ordering stays the existing newest-first
  // clinical-memory order.
  const memoryBlockRows = mergeMemoryBlockRows<MemoryBlockRow>(
    blockRows as unknown as MemoryBlockRow[],
    childBlockRows as unknown as MemoryBlockRow[],
    MEMORY_CAP,
  );

  // Migration 0128: resolve the full multi-area label per matched block so a
  // memory result shows every treated area + laterality, not just the first —
  // including for a block found ONLY through a secondary area, which is the
  // whole point of the child-area path above.
  const searchAreasByBlock = await getSessionBlockAreasByBlockIds(
    memoryBlockRows.map((b) => b.id),
    studioId,
  );
  for (const b of memoryBlockRows) {
    const session = Array.isArray(b.session) ? b.session[0] : b.session;
    // Belt and braces behind the inner join. If a parent ever arrives missing,
    // malformed, or (impossibly, given `!inner`) inactive, DROP the row rather
    // than emit `/clients/undefined/sessions/…` — a link that 404s is worse
    // than no result, and a defensive render must not resurrect what the
    // database filters were written to remove.
    if (
      !session ||
      typeof session.client_id !== "string" ||
      session.client_id === "" ||
      typeof b.session_id !== "string" ||
      b.session_id === "" ||
      session.deleted_at != null ||
      session.record_status === VOID_RECORD_STATUS
    ) {
      continue;
    }
    const client = Array.isArray(session?.client)
      ? session?.client[0]
      : session?.client;
    const area =
      blockAreasLabel(searchAreasByBlock.get(b.id as string), {
        primary_area: b.primary_area as string | null,
        side: b.side as string | null,
      }) ||
      (b.block_name as string | null) ||
      "Treatment area";
    const lot = b.probe_lot_number as string | null;
    const caution = b.caution_note as string | null;
    results.push({
      id: `memory:block:${b.id}`,
      type: "memory",
      title: (client?.name as string) || "Session",
      subtitle: caution
        ? `Recorded caution · ${area}`
        : lot
          ? `Probe lot ${lot} · ${area}`
          : `Session · ${area}`,
      href: `/clients/${session?.client_id}/sessions/${b.session_id}`,
      date: fmtDate((session?.started_at as string) ?? (b.created_at as string)),
    });
  }
  for (const s of noteRows) {
    const client = Array.isArray(s.client) ? s.client[0] : s.client;
    results.push({
      id: `memory:note:${s.id}`,
      type: "memory",
      title: (client?.name as string) || "Session",
      subtitle: "Recorded treatment note",
      href: `/clients/${s.client_id}/sessions/${s.id}`,
      date: fmtDate(s.started_at as string),
    });
  }

  for (const r of sterileRows) {
    const lot = r.lot_number as string | null;
    results.push({
      id: `record:sterile:${r.id}`,
      type: "record",
      title: (r.item_description as string) || "Sterile item",
      subtitle: lot ? `Lot ${lot}` : "Sterile item record",
      href: lot
        ? `/records?section=sterile&lot=${encodeURIComponent(lot)}`
        : "/records?section=sterile",
      date: fmtDate(r.date_purchased as string),
    });
  }
  for (const r of disinfectantRows) {
    results.push({
      id: `record:disinfectant:${r.id}`,
      type: "record",
      title: (r.disinfectant_name as string) || "Disinfectant",
      subtitle: "Disinfectant record",
      href: "/records?section=disinfectants",
      date: fmtDate(r.date_prepared as string),
    });
  }

  results.push(...filterPageShortcuts(query));

  return { ok: true, results: results.slice(0, SEARCH_TOTAL_CAP) };
}
