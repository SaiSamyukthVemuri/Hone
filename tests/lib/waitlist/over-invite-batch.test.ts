import { describe, expect, it } from "vitest";
import {
  canConfirmOverInvite,
  recheckBeforeSend,
  reopenFailed,
  retryTargets,
  runInviteBatch,
  summarize,
  type SendOutcome,
} from "@/lib/waitlist/over-invite-batch";
import { buildOverInvitePreview } from "@/lib/waitlist/over-invite-preview";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `e${i}`);
const noSleep = async () => undefined;
const run = (entryIds: string[], send: (id: string) => Promise<SendOutcome>, extra: Record<string, unknown> = {}) =>
  runInviteBatch({ entryIds, send, sleep: noSleep, ...extra });

describe("a confirmed batch at zero or exhausted capacity", () => {
  it("fit=0 with 10 selected and confirmed sends all 10", async () => {
    const preview = buildOverInvitePreview({ fit: 0, active: 0, expiringSoon: 0, extra: 10 });
    expect(preview.beyondCapacity).toBe(true);
    expect(canConfirmOverInvite(10)).toBe(true);
    const sent: string[] = [];
    const r = await run(ids(10), async (id) => (sent.push(id), { kind: "sent" }));
    expect(sent).toHaveLength(10);
    expect(summarize(r.results)).toEqual({ pending: 0, sent: 10, skipped: 0, failed: 0 });
  });
  it("only real guards refuse: 10 minus the guard refusals are sent", async () => {
    const guards: Record<string, string> = { e2: "consent_missing", e5: "duplicate", e7: "entry_status" };
    const r = await run(ids(10), async (id) => (guards[id] ? { kind: "refused", code: guards[id] } : { kind: "sent" }));
    expect(summarize(r.results)).toEqual({ pending: 0, sent: 7, skipped: 3, failed: 0 });
  });
  it("capacity running out mid-batch (no_capacity from item 4 on) skips nothing silently and stops nothing", async () => {
    const r = await run(ids(10), async (id) => (Number(id.slice(1)) >= 4 ? { kind: "refused", code: "no_capacity" } : { kind: "sent" }));
    expect(r.results.filter((x) => x.status === "skipped")).toEqual([]);
    expect(r.results).toHaveLength(10);
    const failed = r.results.filter((x) => x.status === "failed");
    expect(failed).toHaveLength(6);
    expect(failed.every((x) => x.status === "failed" && x.detail === "refused_unexpectedly")).toBe(true);
    expect(retryTargets(r.results)).toHaveLength(6);
  });
  it("the confirm control is available at any capacity and only needs a recipient", () => {
    expect(canConfirmOverInvite(0)).toBe(false);
    expect(canConfirmOverInvite(1)).toBe(true);
    expect(canConfirmOverInvite(1000)).toBe(true);
    expect(canConfirmOverInvite(2.5)).toBe(false);
    expect(canConfirmOverInvite(Number.NaN)).toBe(false);
  });
});

describe("the material-change re-check", () => {
  const shown = { fit: 0, active: 3, extra: 10 };
  it("a capacity that is still zero does not re-prompt", () => {
    expect(recheckBeforeSend(shown, { fit: 0, active: 3, extra: 10 })).toBe("send");
  });
  it("re-prompts when the numbers the owner saw changed, including a fall to zero", () => {
    expect(recheckBeforeSend({ fit: 5, active: 3, extra: 10 }, { fit: 0, active: 3, extra: 10 })).toBe("reconfirm");
    expect(recheckBeforeSend(shown, { fit: 0, active: 4, extra: 10 })).toBe("reconfirm");
  });
  it("re-prompts when only the quantity changed", () => {
    expect(recheckBeforeSend(shown, { fit: 0, active: 3, extra: 11 })).toBe("reconfirm");
  });
  it("confirming again on the new numbers sends (the new numbers become the shown ones)", () => {
    const fresh = { fit: 0, active: 4, extra: 10 };
    expect(recheckBeforeSend(fresh, { ...fresh })).toBe("send");
  });
});

describe("delivery, chunks and retry", () => {
  it("a per-recipient delivery failure does not stop the rest", async () => {
    const r = await run(ids(6), async (id) => (id === "e1" || id === "e4" ? { kind: "failed" } : { kind: "sent" }));
    expect(summarize(r.results)).toEqual({ pending: 0, sent: 4, skipped: 0, failed: 2 });
    expect(r.paused).toBe(false);
  });
  it("a systemic failure pauses the batch and leaves the rest pending", async () => {
    const r = await run(ids(6), async (id) => (id === "e2" ? { kind: "failed", systemic: true } : { kind: "sent" }));
    expect(r.paused).toBe(true);
    expect(summarize(r.results)).toEqual({ pending: 3, sent: 2, skipped: 0, failed: 1 });
  });
  it("a chunk bounds one call, never the quantity: further calls finish the batch with no duplicates", async () => {
    const sentIds: string[] = [];
    const send = async (id: string): Promise<SendOutcome> => (sentIds.push(id), { kind: "sent" });
    const first = await run(ids(60), send);
    expect(summarize(first.results).sent).toBe(25);
    expect(first.more).toBe(true);
    const second = await run(ids(60), send, { previous: first.results });
    const third = await run(ids(60), send, { previous: second.results });
    expect(third.more).toBe(false);
    expect(sentIds).toHaveLength(60);
    expect(new Set(sentIds).size).toBe(60);
  });
  it("a double-submitted list sends each person once", async () => {
    const sent: string[] = [];
    await run(["e1", "e1", "e2", "e1"], async (id) => (sent.push(id), { kind: "sent" }));
    expect(sent).toEqual(["e1", "e2"]);
  });
  it("is paced: one sleep between sends, none before the first", async () => {
    const naps: number[] = [];
    await runInviteBatch({ entryIds: ids(4), send: async () => ({ kind: "sent" }), sleep: async (ms) => void naps.push(ms) });
    expect(naps).toEqual([500, 500, 500]);
  });
  it("one in flight: the next send does not start before the previous settles", async () => {
    let inFlight = 0;
    let peak = 0;
    await run(ids(5), async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return { kind: "sent" };
    });
    expect(peak).toBe(1);
  });
  it("retry targets only failed items, never a sent or skipped one", async () => {
    const r = await run(ids(4), async (id) => (id === "e0" ? { kind: "failed" } : id === "e1" ? { kind: "refused", code: "duplicate" } : { kind: "sent" }));
    expect(retryTargets(r.results)).toEqual(["e0"]);
  });
  it("a thrown send is a delivery failure, and an unknown refusal is a failure, not a skip", async () => {
    const r = await run(ids(2), async (id) => {
      if (id === "e0") throw new Error("synthetic");
      return { kind: "refused", code: "something_new" };
    });
    expect(r.results.map((x) => (x.status === "failed" ? x.detail : x.status))).toEqual(["delivery", "refused_unexpectedly"]);
  });
  it("continuing a chunk keeps earlier skipped and failed results and advances only the pending ones (26 people, the first 25 refused)", async () => {
    const calls: string[] = [];
    const send = async (id: string): Promise<SendOutcome> => {
      calls.push(id);
      return id === "e25" ? { kind: "sent" } : { kind: "refused", code: "consent_missing" };
    };
    const first = await run(ids(26), send);
    expect(summarize(first.results)).toEqual({ pending: 1, sent: 0, skipped: 25, failed: 0 });
    const second = await run(ids(26), send, { previous: first.results });
    expect(summarize(second.results)).toEqual({ pending: 0, sent: 1, skipped: 25, failed: 0 });
    expect(second.more).toBe(false);
    expect(calls).toHaveLength(26);
    expect(new Set(calls).size).toBe(26);
  });
  it("failures are not retried implicitly: only reopenFailed makes the next call retry exactly them", async () => {
    let ok = false;
    const calls: string[] = [];
    const send = async (id: string): Promise<SendOutcome> => (calls.push(id), id === "e1" && !ok ? { kind: "failed" } : { kind: "sent" });
    const first = await run(ids(3), send);
    const again = await run(ids(3), send, { previous: first.results });
    expect(calls).toEqual(["e0", "e1", "e2"]);
    expect(summarize(again.results)).toEqual({ pending: 0, sent: 2, skipped: 0, failed: 1 });
    ok = true;
    const retry = await run(ids(3), send, { previous: reopenFailed(again.results) });
    expect(calls).toEqual(["e0", "e1", "e2", "e1"]);
    expect(summarize(retry.results)).toEqual({ pending: 0, sent: 3, skipped: 0, failed: 0 });
  });
  it("a NaN or non-finite chunk size falls back to the default chunk of 25 instead of removing the bound; a non-positive one clamps to one send per call", async () => {
    for (const c of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = await run(ids(60), async () => ({ kind: "sent" }), { chunkSize: c });
      expect(summarize(r.results), String(c)).toEqual({ pending: 35, sent: 25, skipped: 0, failed: 0 });
    }
    for (const c of [-4, 0]) {
      const r = await run(ids(3), async () => ({ kind: "sent" }), { chunkSize: c });
      expect(summarize(r.results), String(c)).toEqual({ pending: 2, sent: 1, skipped: 0, failed: 0 });
    }
  });
});
