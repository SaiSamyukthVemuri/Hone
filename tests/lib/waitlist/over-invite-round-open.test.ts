import { describe, expect, it } from "vitest";
import { admitBatchItem, replaceInvitation, type ClaimedItem } from "@/lib/waitlist/over-invite-port";
import { runBatchChunk, type WorkerDeps } from "@/lib/waitlist/over-invite-worker";

// A studio with NO open admission round: the issuer needs one, and the owner never chooses it. These tests never seed an open round, which is exactly
// what hid the gap: the first batch of a studio must open the round through the same command the single invitation uses, ask again once, and
// otherwise stop under a closed reason.

const item: ClaimedItem = {
  itemId: "i1", batchId: "b", studioId: "s", entryId: "e1", actorUserId: "a", serviceId: "svc",
  startDate: "2026-12-01", endDate: "2026-12-07", allowedWeekdays: null, ttlHours: 48,
};
const issuedRow = { invitation_id: "inv", raw_token: "TOKEN", issued_at: "2026-12-01T00:00:00Z", expires_at: "2026-12-04T00:00:00Z", delivery_email: "x@example.test", delivery_name: "N" };

/** An rpc fake with a studio that starts with NO open round. `opens` is what the open command answers. */
function studio(opts: { opens?: string; error?: boolean; afterOpen?: string } = {}) {
  const calls: string[] = [];
  let open = false;
  const rpc = async (name: string, args: Record<string, unknown>) => {
    calls.push(name);
    if (name === "open_new_client_waitlist_admission_round") {
      if (opts.error) return { data: null, error: { code: "57014" } };
      const answer = opts.opens ?? "opened";
      if (answer === "opened" || answer === "round_already_open") open = true;
      return { data: [{ result: answer }], error: null, args };
    }
    if (name === "admit_new_client_waitlist_entry") return { data: [open ? (opts.afterOpen ? { result: opts.afterOpen } : { result: "admitted", ...issuedRow }) : { result: "no_round_open" }], error: null };
    if (name === "replace_waitlist_invitation") return { data: [open ? { result: "replaced", ...issuedRow } : { result: "refused:no_round_open" }], error: null };
    throw new Error(`unexpected ${name}`);
  };
  return { db: { rpc } as never, calls, isOpen: () => open };
}
const count = (calls: string[], n: string) => calls.filter((c) => c === n).length;

describe("admit for a studio with no open round", () => {
  it("opens the round through the single-invite command with the owner as actor, then admits once more", async () => {
    const s = studio();
    const r = await admitBatchItem(s.db, item, null);
    expect(r).toMatchObject({ ok: true, result: "admitted" });
    expect(s.calls).toEqual(["admit_new_client_waitlist_entry", "open_new_client_waitlist_admission_round", "admit_new_client_waitlist_entry"]);
  });
  it("passes the studio, the owner and the same allowance the single invitation uses", async () => {
    const seen: Record<string, unknown>[] = [];
    const db = { rpc: async (n: string, a: Record<string, unknown>) => (n.startsWith("open_") ? (seen.push(a), { data: [{ result: "opened" }], error: null }) : { data: [{ result: seen.length ? "admitted" : "no_round_open", ...issuedRow }], error: null }) } as never;
    await admitBatchItem(db, item, null);
    expect(seen).toEqual([{ p_studio_id: "s", p_actor_user_id: "a", p_allowance: 100 }]);
  });
  it("asks again ONCE: a round that still answers no_round_open ends as the closed code, with no loop", async () => {
    const s = studio({ opens: "opened", afterOpen: "no_round_open" });
    const r = await admitBatchItem(s.db, item, null);
    expect(r).toEqual({ ok: true, result: "no_round_open" });
    expect(count(s.calls, "admit_new_client_waitlist_entry")).toBe(2);
    expect(count(s.calls, "open_new_client_waitlist_admission_round")).toBe(1);
  });
  it("a DEFINITIVE refusal to open a round is the closed code no_round_open, and admit is not repeated", async () => {
    for (const opens of ["not_owner", "unknown_studio", "invalid_input"]) {
      const s = studio({ opens });
      expect(await admitBatchItem(s.db, item, null)).toEqual({ ok: true, result: "no_round_open" });
      expect(count(s.calls, "admit_new_client_waitlist_entry")).toBe(1);
    }
  });
  it("a LOST answer from the open command (error, throw, unreadable shape) is a transient failure, never the closed skip, and admit is not repeated", async () => {
    const lost: ((n: string) => unknown)[] = [
      () => ({ data: null, error: { code: "57014" } }),
      () => { throw new Error("network"); },
      () => ({ data: [{ nothing: 1 }], error: null }),
      () => ({ data: null, error: null }),
    ];
    for (const answer of lost) {
      const calls: string[] = [];
      const db = { rpc: async (n: string) => (calls.push(n), n.startsWith("open_") ? answer(n) : { data: [{ result: "no_round_open" }], error: null }) } as never;
      expect(await admitBatchItem(db, item, null)).toEqual({ ok: false, code: "unavailable" });
      expect(count(calls, "admit_new_client_waitlist_entry")).toBe(1);
    }
  });
  it("a lost answer leaves the item CLAIMED: nothing is settled, nothing is delivered, and it is not skipped", async () => {
    const db = { rpc: async (n: string) => (n.startsWith("open_") ? { data: null, error: { code: "57014" } } : { data: [{ result: "no_round_open" }], error: null }) } as never;
    const settled: string[] = [];
    const d: WorkerDeps = {
      claim: async () => ({ ok: true, items: [item] }),
      admit: (it) => admitBatchItem(db, it, null),
      settle: async (t, o, r) => (settled.push(`${t.itemId}:${o}:${r}`), { ok: true, result: "settled" }),
      deliver: async () => { throw new Error("must not deliver"); },
      mayStillSend: async () => "sendable",
      sleep: async () => {},
    };
    const r = await runBatchChunk(d, undefined, { mode: "background" });
    expect(r.ok && r.outcomes[0]).toMatchObject({ status: "failed", reason: "settle_failed" });
    expect(settled).toEqual([]);
  });
  it("an answer other than no_round_open never opens a round", async () => {
    const calls: string[] = [];
    const db = { rpc: async (n: string) => (calls.push(n), { data: [{ result: "no_capacity" }], error: null }) } as never;
    expect(await admitBatchItem(db, item, null)).toEqual({ ok: true, result: "no_capacity" });
    expect(calls).toEqual(["admit_new_client_waitlist_entry"]);
  });
  it("a studio's first batch is sent: every item admits and settles sent, none skipped", async () => {
    const s = studio();
    const settled: string[] = [];
    const items = [1, 2, 3].map((n) => ({ ...item, itemId: `i${n}`, entryId: `e${n}` }));
    const d: WorkerDeps = {
      claim: async () => ({ ok: true, items }),
      admit: (it) => admitBatchItem(s.db, it, null),
      settle: async (t, o, r) => (settled.push(`${t.itemId}:${o}:${r}`), { ok: true, result: "settled" }),
      deliver: async () => "accepted",
      mayStillSend: async () => "sendable",
      sleep: async () => {},
    };
    const r = await runBatchChunk(d, undefined, { mode: "background" });
    expect(r.ok && r.outcomes.map((o) => o.status)).toEqual(["sent", "sent", "sent"]);
    expect(settled).toEqual(["i1:sent:null", "i2:sent:null", "i3:sent:null"]);
    expect(count(s.calls, "open_new_client_waitlist_admission_round")).toBe(1);
  });
  it("a studio whose round cannot be opened settles each item skipped under no_round_open, a closed reason (the entry stays waiting)", async () => {
    const s = studio({ opens: "not_owner" });
    const settled: string[] = [];
    const d: WorkerDeps = {
      claim: async () => ({ ok: true, items: [item] }),
      admit: (it) => admitBatchItem(s.db, it, null),
      settle: async (t, o, r) => (settled.push(`${t.itemId}:${o}:${r}`), { ok: true, result: "settled" }),
      deliver: async () => { throw new Error("must not deliver"); },
      mayStillSend: async () => "sendable",
      sleep: async () => {},
    };
    const r = await runBatchChunk(d, undefined, { mode: "background" });
    expect(r.ok && r.outcomes[0]).toMatchObject({ status: "skipped", reason: "no_round_open" });
    expect(settled).toEqual(["i1:skipped:no_round_open"]);
  });
});

describe("replace for a studio with no open round (the retry path)", () => {
  const input = { studioId: "s", actorUserId: "a", entryId: "e", expectedInvitationId: "inv-1" };
  it("opens the round and asks again once", async () => {
    const s = studio();
    expect(await replaceInvitation(s.db, input)).toMatchObject({ ok: true, result: "replaced" });
    expect(s.calls).toEqual(["replace_waitlist_invitation", "open_new_client_waitlist_admission_round", "replace_waitlist_invitation"]);
  });
  it("a DEFINITIVE refusal to open a round is the closed value `refused`, with no second replace and no free text", async () => {
    const s = studio({ opens: "not_owner" });
    expect(await replaceInvitation(s.db, input)).toEqual({ ok: true, result: "refused" });
    expect(count(s.calls, "replace_waitlist_invitation")).toBe(1);
  });
  it("a LOST answer from the open command is a transient failure, so the retry puts the item back; never `refused`, and no second replace", async () => {
    for (const answer of [() => ({ data: null, error: { code: "57014" } }), () => { throw new Error("network"); }, () => ({ data: [{ nothing: 1 }], error: null })]) {
      const calls: string[] = [];
      const db = { rpc: async (n: string) => (calls.push(n), n.startsWith("open_") ? answer() : { data: [{ result: "refused:no_round_open" }], error: null }) } as never;
      expect(await replaceInvitation(db, input)).toEqual({ ok: false, code: "unavailable" });
      expect(count(calls, "replace_waitlist_invitation")).toBe(1);
    }
  });
  it("a second no_round_open ends as `refused` after exactly one extra ask", async () => {
    const calls: string[] = [];
    const db = { rpc: async (n: string) => (calls.push(n), n.startsWith("open_") ? { data: [{ result: "opened" }], error: null } : { data: [{ result: "refused:no_round_open" }], error: null }) } as never;
    expect(await replaceInvitation(db, input)).toEqual({ ok: true, result: "refused" });
    expect(count(calls, "replace_waitlist_invitation")).toBe(2);
  });
});
