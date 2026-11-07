import { describe, expect, it } from "vitest";
import { loadDayDocument, type DayDocumentDeps } from "@/lib/records/print/day-document";
import type { DayPacketLoad } from "@/lib/records/print/day-loader";

const okLoad = (sessions: unknown[] = []): DayPacketLoad => ({
  ok: true,
  value: { sessions: sessions as never, blocks: [], blockAreasById: new Map(), entries: [], laserEntries: [], practitionerNameById: new Map([["p1", "Dana"]]) },
});
const session = {
  id: "s1", started_at: "2026-05-10T15:00:00.000Z", ended_at: null, modality: "x", session_notes: null,
  performed_by_practitioner_id: "p1", practitioner_id: "p1", aftercare_and_risks_explained_at: null, aftercare_and_risks_explained_by: null,
};
function deps(over: Partial<DayDocumentDeps> & { calls?: string[] } = {}): DayDocumentDeps {
  const calls = over.calls ?? [];
  return {
    readClient: async () => (calls.push("client"), { id: "c1", name: "Stored Name" }),
    readIdentity: async () => (calls.push("identity"), { ok: true, preferred_name: "Pref", legal_name: "Legal Name" }),
    loadDay: async () => (calls.push("load"), okLoad([session])),
    ...over,
  };
}
const args = (d: DayDocumentDeps) => ({ studioId: "st", clientId: "c1", day: "2026-05-10", timezone: "America/Toronto", studioName: "Studio", deps: d });

describe("loadDayDocument: every failure is a distinct, non-empty state", () => {
  it("a client that is not this studio's reads no records at all", async () => {
    const calls: string[] = [];
    const r = await loadDayDocument(args(deps({ calls, readClient: async () => (calls.push("client"), null) })));
    expect(r).toEqual({ ok: false, reason: "client_not_found" });
    expect(calls).toEqual(["client"]);
  });
  it("a failed or throwing client read is read_failed", async () => {
    expect(await loadDayDocument(args(deps({ readClient: async () => "error" })))).toEqual({ ok: false, reason: "read_failed" });
    expect(await loadDayDocument(args(deps({ readClient: () => Promise.reject(new Error("x")) })))).toEqual({ ok: false, reason: "read_failed" });
  });
  it("Privacy Q-4: a failed read is read_failed and NEVER an empty packet", async () => {
    for (const reason of ["read_failed", "unresolvable_day"] as const) {
      const r = await loadDayDocument(args(deps({ loadDay: async () => ({ ok: false, reason }) })));
      expect(r).toEqual({ ok: false, reason });
    }
    expect(await loadDayDocument(args(deps({ loadDay: () => Promise.reject(new Error("x")) })))).toEqual({ ok: false, reason: "read_failed" });
  });
  it("only a successful read with no visits is an empty day", async () => {
    const r = await loadDayDocument(args(deps({ loadDay: async () => okLoad([]) })));
    expect(r.ok && r.packet.visits).toEqual([]);
  });
});

describe("loadDayDocument: the name on the packet", () => {
  it("is the legal name with the preferred name in parentheses", async () => {
    const r = await loadDayDocument(args(deps()));
    expect(r.ok && r.packet.clientName).toBe("Legal Name (Pref)");
    expect(r.ok && r.legalNamesUnavailable).toBe(false);
  });
  it("falls back to the stored name and SAYS so when identity could not be read, never claiming a legal name", async () => {
    const r = await loadDayDocument(args(deps({ readIdentity: async () => ({ ok: false, preferred_name: null, legal_name: null }) })));
    expect(r.ok && r.packet.clientName).toBe("Stored Name");
    expect(r.ok && r.legalNamesUnavailable).toBe(true);
    const thrown = await loadDayDocument(args(deps({ readIdentity: () => Promise.reject(new Error("x")) })));
    expect(thrown.ok && thrown.legalNamesUnavailable).toBe(true);
  });
});
