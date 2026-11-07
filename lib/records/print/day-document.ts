// HON-46 M2 — the whole read behind the day packet page, after the audit.
//
// Orders and maps the outcomes so the page cannot confuse them:
//   * the client must be in this studio (else client_not_found, no records read);
//   * a read that fails, stalls or saturates is read_failed, NEVER an empty day
//     (Privacy Q-4);
//   * an unresolvable day is unresolvable_day, NEVER an empty day;
//   * only a successful read with no visits is an empty day.
// The name on the packet is the LEGAL name with the preferred name in
// parentheses (OPS Q2, HON-58). If the legal name could not be read the stored
// name is used and the packet SAYS so; a legal name is never claimed unread.

import { clinicalPacketName } from "@/lib/clients/identity";
import { buildDayPacket, type DayPacket } from "@/lib/records/print/day-packet";
import type { DayPacketLoad } from "@/lib/records/print/day-loader";

export type DayDocument =
  | { ok: true; packet: DayPacket; legalNamesUnavailable: boolean }
  | { ok: false; reason: "client_not_found" | "unresolvable_day" | "read_failed" };

export type DayDocumentDeps = {
  /** The studio's client, id and stored name only; null when not this studio's. "error" on a failed read. */
  readClient: (studioId: string, clientId: string) => Promise<{ id: string; name: string } | null | "error">;
  readIdentity: (clientId: string) => Promise<{ ok: boolean; preferred_name: string | null; legal_name: string | null }>;
  loadDay: () => Promise<DayPacketLoad>;
};

export async function loadDayDocument(args: {
  studioId: string;
  clientId: string;
  day: string;
  timezone: string;
  studioName: string;
  deps: DayDocumentDeps;
}): Promise<DayDocument> {
  const { deps } = args;
  const client = await deps.readClient(args.studioId, args.clientId).catch(() => "error" as const);
  if (client === "error") return { ok: false, reason: "read_failed" };
  if (client === null) return { ok: false, reason: "client_not_found" };

  const loaded = await deps.loadDay().catch(() => ({ ok: false as const, reason: "read_failed" as const }));
  if (!loaded.ok) return { ok: false, reason: loaded.reason };

  const identity = await deps.readIdentity(args.clientId).catch(() => ({ ok: false, preferred_name: null, legal_name: null }));
  const clientName = clinicalPacketName({
    name: client.name,
    preferred_name: identity.preferred_name,
    legal_name: identity.legal_name,
  });
  const packet = buildDayPacket({
    day: args.day,
    timezone: args.timezone,
    studioName: args.studioName,
    clientName,
    sessions: loaded.value.sessions,
    blocks: loaded.value.blocks,
    blockAreasById: loaded.value.blockAreasById,
    entries: loaded.value.entries,
    laserEntries: loaded.value.laserEntries,
    practitionerNameById: loaded.value.practitionerNameById,
  });
  return { ok: true, packet, legalNamesUnavailable: !identity.ok };
}
