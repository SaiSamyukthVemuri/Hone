"use server";

import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import {
  escapeIlike,
  filterPageShortcuts,
  sanitizeQuery,
  statusForQuery,
  SEARCH_MIN_CHARS,
  SEARCH_TOTAL_CAP,
  type SearchResult,
} from "@/lib/search/global-search";

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

  const [clientRows, blockRows, noteRows, sterileRows, disinfectantRows] =
    await Promise.all([
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
        .select(
          "id, session_id, primary_area, block_name, caution_note, reaction_notes, probe_label, probe_lot_number, created_at, session:session_id(client_id, started_at, client:client_id(name))",
        )
        .eq("studio_id", studioId)
        .is("deleted_at", null)
        .or(
          `primary_area.ilike.${like},block_name.ilike.${like},caution_note.ilike.${like},reaction_notes.ilike.${like},probe_label.ilike.${like},probe_lot_number.ilike.${like}`,
        )
        .order("created_at", { ascending: false })
        .limit(MEMORY_CAP)
        .then((r) => r.data ?? []),
      supabase
        .from("sessions")
        .select("id, client_id, started_at, next_session_note, client:client_id(name)")
        .eq("studio_id", studioId)
        .is("deleted_at", null)
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
  const [serviceRows, apptByClient, apptByStatus] = await Promise.all([
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
            "id, starts_at, status, client:client_id(name), service:services(name)",
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
            "id, starts_at, status, client:client_id(name), service:services(name)",
          )
          .eq("studio_id", studioId)
          .eq("status", status)
          .order("starts_at", { ascending: false })
          .limit(3)
          .then((r) => r.data ?? [])
      : Promise.resolve([]),
  ]);
  const apptByService =
    serviceRows.length > 0
      ? await supabase
          .from("appointments")
          .select(
            "id, starts_at, status, client:client_id(name), service:services(name)",
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

  for (const b of blockRows) {
    const session = Array.isArray(b.session) ? b.session[0] : b.session;
    const client = Array.isArray(session?.client)
      ? session?.client[0]
      : session?.client;
    const area =
      (b.primary_area as string | null) ||
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
