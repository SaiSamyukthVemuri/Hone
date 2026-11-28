import { beforeEach, describe, expect, it, vi } from "vitest";

// HON-130: the draft actions take studio and practitioner from the SESSION, refuse with a closed code and store NOTHING while the
// server-side switch is off, and never put draft text in a log.
const S = "11111111-1111-4111-8111-111111111111";
const C = "33333333-3333-4333-8333-333333333333";
const W = "44444444-4444-4444-8444-444444444444";
const rpc = vi.hoisted(() => vi.fn());
const logs = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc, from: () => ({ select: () => ({ eq: async () => ({ data: [], error: null }) }) }) }) }));
vi.mock("@/lib/supabase/queries", () => ({ getCurrentPractitionerWithStudio: async () => ({ studio: { id: S }, practitioner: { id: "p1" } }) }));
vi.mock("@/lib/logging/safe-log", () => ({ safeLog: { error: (m: string) => logs.push(m), info: (m: string) => logs.push(m) } }));

import { discardNoteDraftAction, loadNoteDrafts, saveNoteDraftAction } from "@/app/(app)/clients/[id]/note-draft-actions";

const input = { key: { clientId: C, kind: "consultation" as const, target: "new" }, fields: { body: "SECRET CLINICAL TEXT" }, expectedRevision: 0, writer: W };

beforeEach(() => {
  rpc.mockReset();
  logs.length = 0;
  delete process.env.HONE_NOTE_DRAFTS_STUDIO_IDS;
});

describe("switch OFF (the default in every environment)", () => {
  it("save refuses with the closed code and calls NOTHING in the database", async () => {
    expect(await saveNoteDraftAction(input)).toEqual({ status: "disabled" });
    expect(rpc).not.toHaveBeenCalled();
  });
  it("load returns nothing and calls nothing", async () => {
    expect(await loadNoteDrafts(C)).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("discard still reaches the database: an author can always delete their own draft", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    expect(await discardNoteDraftAction(input.key)).toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledWith("discard_client_note_draft", expect.objectContaining({ p_studio_id: S, p_client_id: C }));
  });
  it("another studio on the list does not enable this one", async () => {
    process.env.HONE_NOTE_DRAFTS_STUDIO_IDS = "99999999-9999-4999-8999-999999999999";
    expect(await saveNoteDraftAction(input)).toEqual({ status: "disabled" });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("switch ON for this studio", () => {
  beforeEach(() => {
    process.env.HONE_NOTE_DRAFTS_STUDIO_IDS = S;
  });
  it("studio comes from the session, never the request; fields are sanitised", async () => {
    rpc.mockResolvedValue({ data: [{ status: "ok", revision: 1, fields: {}, updated_at: "2026-11-28T10:00:00Z" }], error: null });
    const r = await saveNoteDraftAction({ ...input, fields: { body: "t", evil: "x" } as never });
    expect(r).toEqual({ status: "ok", revision: 1, savedAt: "2026-11-28T10:00:00Z" });
    expect(rpc).toHaveBeenCalledWith("save_client_note_draft", { p_studio_id: S, p_client_id: C, p_kind: "consultation", p_target: "new", p_fields: { body: "t" }, p_expected_revision: 0, p_writer: W });
  });
  it("a malformed key, writer or revision is refused before any database call", async () => {
    expect((await saveNoteDraftAction({ ...input, key: { ...input.key, target: "current" } })).status).toBe("invalid");
    expect((await saveNoteDraftAction({ ...input, writer: "nope" })).status).toBe("invalid");
    expect((await saveNoteDraftAction({ ...input, expectedRevision: -1 })).status).toBe("invalid");
    expect(rpc).not.toHaveBeenCalled();
  });
  it("a database failure is a closed error and the log carries NO draft text", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "SECRET CLINICAL TEXT leaked" } });
    expect(await saveNoteDraftAction(input)).toEqual({ status: "error" });
    expect(logs.join(" ")).not.toContain("SECRET");
  });
  it("a thrown error is a closed error, with no text in the log", async () => {
    rpc.mockRejectedValue(new Error("SECRET CLINICAL TEXT"));
    expect(await saveNoteDraftAction(input)).toEqual({ status: "error" });
    expect(logs.join(" ")).not.toContain("SECRET");
  });
  it("a conflict returns the stored draft sanitised; cleared / gone / refused pass through as closed codes", async () => {
    rpc.mockResolvedValueOnce({ data: [{ status: "conflict", revision: 4, fields: { body: "theirs", evil: 1 }, updated_at: "t" }], error: null });
    expect(await saveNoteDraftAction(input)).toEqual({ status: "conflict", revision: 4, fields: { body: "theirs" }, savedAt: "t" });
    rpc.mockResolvedValueOnce({ data: [{ status: "cleared", revision: 7, fields: {}, updated_at: null }], error: null });
    expect(await saveNoteDraftAction(input)).toEqual({ status: "cleared", revision: 7 }); // the tombstone's revision, so a fresh session can continue from it
    for (const status of ["gone", "refused"]) {
      rpc.mockResolvedValueOnce({ data: [{ status, revision: 0, fields: {}, updated_at: null }], error: null });
      expect(await saveNoteDraftAction(input)).toEqual({ status });
    }
  });
});
