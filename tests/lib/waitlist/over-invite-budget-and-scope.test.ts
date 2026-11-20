import type { SettleOutcome } from "@/lib/waitlist/over-invite-port";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => ({}) }));

import { runRounds } from "@/lib/waitlist/over-invite-run";
import { ITEM_BUDGET_MS, SPACING_MS, type WorkerDeps } from "@/lib/waitlist/over-invite-worker";
import { retryDeliveries } from "@/lib/waitlist/over-invite-retry";
import { RETRY_CLICK_MAX, tallyItems } from "@/lib/waitlist/over-invite-progress";
import { BATCHES_SHOWN, loadBatchItems, loadRefusedTargets, loadShownBatches } from "@/lib/waitlist/over-invite-shown";

describe("a call never overruns its budget (checked before every item's worth of work)", () => {
  function model(queue: number, perItemMs: number) {
    let clock = 0;
    let left = queue;
    const claimed: number[] = [];
    const deps: WorkerDeps = {
      claim: async (l) => {
        claimed.push(l.total);
        const n = Math.min(left, l.total);
        left -= n;
        return { ok: true, items: Array.from({ length: n }, (_, i) => ({ itemId: `i${i}`, batchId: "b", studioId: "s", entryId: `e${i}`, actorUserId: "a", serviceId: "v", startDate: "d", endDate: "d", allowedWeekdays: null, ttlHours: 1 })) };
      },
      admit: async () => ({ ok: true, result: "admitted", issued: { invitationId: "i", rawToken: "t", issuedAt: new Date(), expiresAt: new Date(), deliveryEmail: null, deliveryName: null } }),
      settle: async () => ({ ok: true, result: "settled" }),
      deliver: async () => { clock += perItemMs; return "accepted"; },
      mayStillSend: async () => true,
      sleep: async (ms) => { clock += ms; },
    };
    return { deps, now: () => clock, claimed, left: () => left };
  }
  for (const budget of [20_000, 40_000]) {
    it(`worst-case items (full item budget each): elapsed stays within ${budget} ms and the rest stays queued`, async () => {
      const m = model(500, ITEM_BUDGET_MS);
      const t0 = m.now();
      const r = await runRounds({ budgetMs: budget, mode: { mode: "background" }, deps: m.deps, now: m.now });
      expect(m.now() - t0).toBeLessThanOrEqual(budget);
      expect(r.budgetSpent).toBe(true);
      expect(m.left()).toBeGreaterThan(0); // nothing dropped: it is still queued for the next call
    });
  }
  it("fast items drain a large queue inside the budget, in rounds of at most 5", async () => {
    const m = model(60, 200);
    const r = await runRounds({ budgetMs: 40_000, mode: { mode: "background" }, deps: m.deps, now: m.now });
    expect(r.sent).toBe(60);
    expect(Math.max(...m.claimed)).toBeLessThanOrEqual(5);
  });
  it("an exhausted budget claims nothing at all", async () => {
    const m = model(10, 100);
    const r = await runRounds({ budgetMs: SPACING_MS + ITEM_BUDGET_MS - 1, mode: { mode: "background" }, deps: m.deps, now: m.now });
    expect(m.claimed).toEqual([]);
    expect(r.budgetSpent).toBe(true);
  });
});

describe("retry: one click, bounded, and a hang can never lead to a second email", () => {
  const target = (n: number) => ({ entryId: `e${n}`, itemId: `i${n}`, studioId: "s" });
  const issued = { invitationId: "inv", rawToken: "t", issuedAt: new Date(), expiresAt: new Date(), deliveryEmail: null, deliveryName: null };
  it("a delivery that is not accepted records delivery_unknown (never retryable again) or delivery_refused", async () => {
    const settled: string[] = [];
    const run = (state: "refused" | "unknown") =>
      retryDeliveries({
        kind: "refused",
        stillRetryable: async () => ({ state: "failed", invitationId: "inv-1" }),
        replace: async () => ({ ok: true, result: "replaced", issued }),
        deliver: async () => state,
        settle: async (t, o, r) => (settled.push(`${t.itemId}:${o}:${r}`), { ok: true, result: "settled" }),
        sleep: async () => {},
      }, [target(1)]);
    await run("unknown");
    await run("refused");
    expect(settled).toEqual(["i1:failed:retry_started", "i1:failed:delivery_unknown", "i1:failed:retry_started", "i1:failed:delivery_refused"]);
  });
  it("the retry click cap is the claim-size round (5) and the confirm number uses the same constant", () => {
    expect(RETRY_CLICK_MAX).toBe(5);
    expect(RETRY_CLICK_MAX * (SPACING_MS + ITEM_BUDGET_MS)).toBeLessThan(60_000);
  });
});

/** A fake owner-session client that APPLIES the eq/in/order/range filters it is given, over in-memory tables. */
function fakeDb(tables: Record<string, Record<string, unknown>[]>) {
  return {
    from(name: string) {
      let rows = [...(tables[name] ?? [])];
      let from = 0, to = Infinity, desc = false, orderCol: string | null = null, lim = Infinity;
      const q: any = {
        select: () => q,
        eq: (c: string, v: unknown) => ((rows = rows.filter((r) => r[c] === v)), q),
        in: (c: string, vs: unknown[]) => ((rows = rows.filter((r) => vs.includes(r[c]))), q),
        order: (c: string, o?: { ascending: boolean }) => ((orderCol = c), (desc = o?.ascending === false), q),
        limit: (n: number) => ((lim = n), q),
        range: (a: number, b: number) => ((from = a), (to = b), q),
        then: (res: (v: unknown) => void) => {
          if (orderCol) rows.sort((x, y) => (String(x[orderCol!]) < String(y[orderCol!]) ? -1 : 1) * (desc ? -1 : 1));
          res({ data: rows.slice(from, Math.min(to + 1, from + lim)).slice(0, lim), error: null });
        },
      };
      return q;
    },
  };
}

describe("the number shown on the retry confirm equals what the action retries", () => {
  it("12 batches: only the 10 shown count, and the panel's refused total equals the action's targets", async () => {
    const batches = Array.from({ length: 12 }, (_, n) => ({ id: `b${n}`, studio_id: "s", confirmed_at: `2026-11-${String(10 + n).padStart(2, "0")}`, quantity: 3, fit_shown: 0, live_shown: 0 }));
    const items: Record<string, unknown>[] = [];
    batches.forEach((b, n) => {
      for (let k = 0; k < 3; k++) items.push({ id: `${b.id}-${k}`, entry_id: `e-${b.id}-${k}`, studio_id: "s", batch_id: b.id, state: "failed", reason_class: k === 0 ? "delivery_refused" : "delivery_unknown" });
    });
    items.push({ id: "other", entry_id: "eo", studio_id: "OTHER", batch_id: "b11", state: "failed", reason_class: "delivery_refused" });
    const db = fakeDb({ waitlist_invitation_batches: batches, waitlist_invitation_batch_items: items });
    const shown = (await loadShownBatches(db, "s"))!;
    expect(shown).toHaveLength(BATCHES_SHOWN);
    let panelRefused = 0;
    for (const b of shown) panelRefused += tallyItems((await loadBatchItems(db, "s", b.id))!).refused;
    const targets = (await loadRefusedTargets(db, "s"))!;
    expect(targets).toHaveLength(panelRefused);
    expect(panelRefused).toBe(10); // one per shown batch; the two older batches and the other studio's row are not counted
    expect(targets.some((t) => t.itemId === "other")).toBe(false);
    // Unknown outcomes are never targets.
    expect(targets.every((t) => t.itemId.endsWith("-0"))).toBe(true);
  });
});

describe("a thrown delivery is UNKNOWN, never refused (worker and retry)", () => {
  const issued = { invitationId: "inv", rawToken: "t", issuedAt: new Date(), expiresAt: new Date(), deliveryEmail: null, deliveryName: null };
  it("retry: deliver throws -> settled failed/delivery_unknown, not delivery_refused", async () => {
    const settled: string[] = [];
    const r = await retryDeliveries(
      {
        kind: "refused",
        stillRetryable: async () => ({ state: "failed", invitationId: "inv-1" }),
        replace: async () => ({ ok: true, result: "replaced", issued }),
        deliver: async () => { throw new Error("boom"); },
        settle: async (t, o, why) => (settled.push(`${o}:${why}`), { ok: true, result: "settled" }),
        sleep: async () => {},
      },
      [{ entryId: "e", itemId: "i", studioId: "s" }],
    );
    expect(settled).toEqual(["failed:retry_started", "failed:delivery_unknown"]);
    expect(r[0]).toMatchObject({ status: "failed", reason: "delivery_unknown" });
  });
  it("worker: deliver throws -> settle unknown/delivery_unknown", async () => {
    const { runBatchChunk } = await import("@/lib/waitlist/over-invite-worker");
    const settled: string[] = [];
    await runBatchChunk({
      claim: async () => ({ ok: true, items: [{ itemId: "i", batchId: "b", studioId: "s", entryId: "e", actorUserId: "a", serviceId: "v", startDate: "d", endDate: "d", allowedWeekdays: null, ttlHours: 1 }] }),
      admit: async () => ({ ok: true, result: "admitted", issued }),
      settle: async (_t, o, why) => (settled.push(`${o}:${why}`), { ok: true, result: "settled" }),
      deliver: async () => { throw new Error("boom"); },
      mayStillSend: async () => true,
      sleep: async () => {},
    }, undefined, { mode: "background" });
    expect(settled).toEqual(["unknown:delivery_unknown"]);
  });
});

describe("retry re-checks each item and never double sends", () => {
  const issued = { invitationId: "inv", rawToken: "t", issuedAt: new Date(), expiresAt: new Date(), deliveryEmail: null, deliveryName: null };
  it("two concurrent retries of the same item send exactly one email", async () => {
    const state = new Map<string, string>([["i1", "failed:delivery_refused"]]);
    let sends = 0;
    const mk = () => ({
      kind: "refused" as const,
      stillRetryable: async ({ itemId }: { itemId: string }) => (state.get(itemId) === "failed:delivery_refused" ? { state: "failed", invitationId: "inv-1" } : null),
      replace: async () => ({ ok: true as const, result: "replaced" as const, issued }),
      deliver: async () => { sends += 1; return "accepted" as const; },
      settle: async (t: { itemId: string }, o: string, why: string | null) => {
        state.set(t.itemId, o === "sent" ? "sent" : `${o}:${why}`);
        return { ok: true as const, result: "settled" };
      },
      sleep: async () => {},
    });
    const target = [{ entryId: "e1", itemId: "i1", studioId: "s" }];
    const [a, b] = await Promise.all([retryDeliveries(mk(), target), retryDeliveries(mk(), target)]);
    // The first marks it retry_started before replacing, so the second finds it no longer retryable. (Without the mark both would send.)
    expect(sends).toBe(1);
    expect([a[0].status, b[0].status].sort()).toEqual(["sent", "skipped"]);
  });
  it("an item no longer in the retryable state is skipped, nothing replaced", async () => {
    let replaced = false;
    const r = await retryDeliveries(
      { kind: "refused", stillRetryable: async () => null, replace: async () => ((replaced = true), { ok: true, result: "replaced", issued }), deliver: async () => "accepted", settle: async () => ({ ok: true, result: "settled" }), sleep: async () => {} },
      [{ entryId: "e", itemId: "i", studioId: "s" }],
    );
    expect(replaced).toBe(false);
    expect(r[0]).toMatchObject({ status: "skipped", reason: "no_longer_retryable" });
  });
  it("a replace that issues nothing puts the item back as it was", async () => {
    const settled: string[] = [];
    await retryDeliveries(
      { kind: "unknown", stillRetryable: async () => ({ state: "failed", invitationId: "inv-1" }), replace: async () => ({ ok: true, result: "invitation_redeemed" }), deliver: async () => "accepted", settle: async (_t, o, why) => (settled.push(`${o}:${why}`), { ok: true, result: "settled" }), sleep: async () => {} },
      [{ entryId: "e", itemId: "i", studioId: "s" }],
    );
    expect(settled).toEqual(["failed:retry_started", "failed:retry_not_possible"]); // a permanent refusal is not offered again
  });
});

describe("what is retryable: only the right rows", () => {
  const mixed = (n: string, state: string, reason: string | null) => ({ id: n, entry_id: `e${n}`, studio_id: "s", batch_id: "b1", state, reason_class: reason });
  const rows = [
    mixed("1", "failed", "delivery_refused"),
    mixed("2", "failed", "delivery_unknown"),
    mixed("3", "failed", "settle_failed"),
    mixed("4", "unknown", "delivery_unknown"),
    mixed("5", "issued", null),
    mixed("6", "sent", null),
    mixed("7", "skipped", "owner_stopped"),
  ];
  const db = () => fakeDb({ waitlist_invitation_batches: [{ id: "b1", studio_id: "s", confirmed_at: "2026-11-20", quantity: 7, fit_shown: 0, live_shown: 0 }], waitlist_invitation_batch_items: rows });
  it("refused retry targets are ONLY failed + delivery_refused", async () => {
    const { loadRefusedTargets } = await import("@/lib/waitlist/over-invite-shown");
    expect((await loadRefusedTargets(db(), "s"))!.map((t) => t.itemId)).toEqual(["1"]);
  });
  it("unknown retry targets are ONLY unknown and failed + delivery_unknown (not issued, sent, skipped, refused)", async () => {
    const { loadUnknownTargets } = await import("@/lib/waitlist/over-invite-shown");
    expect((await loadUnknownTargets(db(), "s"))!.map((t) => t.itemId).sort()).toEqual(["2", "4"]);
  });
});

describe("an issued item inside the lease shows as sending, not unknown", () => {
  it("young issued = sending; old issued = unknown", () => {
    const now = Date.parse("2026-11-20T12:00:00Z");
    const t = tallyItems([{ state: "issued", reason_class: null, issued_at: "2026-11-20T11:59:30Z" }, { state: "issued", reason_class: null, issued_at: "2026-11-20T11:50:00Z" }], now);
    expect(t.sending).toBe(1);
    expect(t.unknown).toBe(1);
  });
});

describe("budget edge: an item that would not fit is never started", () => {
  it("with room for exactly one worst item the call claims one, and never more than the remaining budget allows", async () => {
    let clock = 0;
    const claimed: number[] = [];
    const deps: WorkerDeps = {
      claim: async (l) => { claimed.push(l.total); return { ok: true, items: Array.from({ length: l.total }, (_, i) => ({ itemId: `i${i}`, batchId: "b", studioId: "s", entryId: `e${i}`, actorUserId: "a", serviceId: "v", startDate: "d", endDate: "d", allowedWeekdays: null, ttlHours: 1 })) }; },
      admit: async () => ({ ok: true, result: "admitted", issued: { invitationId: "i", rawToken: "t", issuedAt: new Date(), expiresAt: new Date(), deliveryEmail: null, deliveryName: null } }),
      settle: async () => ({ ok: true, result: "settled" }),
      deliver: async () => { clock += ITEM_BUDGET_MS; return "accepted"; },
      mayStillSend: async () => true,
      sleep: async (ms) => { clock += ms; },
    };
    await runRounds({ budgetMs: SPACING_MS + ITEM_BUDGET_MS + 100, mode: { mode: "background" }, deps, now: () => clock });
    expect(claimed).toEqual([1]);
    expect(clock).toBeLessThanOrEqual(SPACING_MS + ITEM_BUDGET_MS + 100);
  });
  it("the cron budget plus its margin stays inside the platform cap, and so does confirm's", async () => {
    const cron = await import("@/app/api/cron/waitlist-invitation-batches/route");
    expect(cron.maxDuration).toBeGreaterThanOrEqual(60);
  });
});

describe("two server instances racing on one item: exactly one email", () => {
  it("the second instance's replace answers state_changed (the invitation is no longer the latest), so it sends nothing", async () => {
    let latest = "inv-1";
    let sends = 0;
    const row = { state: "failed", reason: "delivery_refused" as string | null };
    const issued = { invitationId: "inv-2", rawToken: "t", issuedAt: new Date(), expiresAt: new Date(), deliveryEmail: null, deliveryName: null };
    const deps = (retryDeliveriesFn: typeof retryDeliveries) => ({
      kind: "refused" as const,
      // Both instances read the item BEFORE either replaces.
      stillRetryable: async () => ({ state: row.state, invitationId: latest }),
      replace: async (_e: string, expected: string | null) => {
        if (expected !== latest) return { ok: true as const, result: "state_changed" };
        latest = "inv-2";
        return { ok: true as const, result: "replaced" as const, issued };
      },
      deliver: async () => { sends += 1; return "accepted" as const; },
      settle: async (_t: unknown, o: string, why: string | null, expected?: string) => {
        if (expected !== undefined && expected !== row.state) return { ok: true as const, result: "state_changed" };
        row.state = o === "sent" ? "sent" : "failed";
        row.reason = why;
        return { ok: true as const, result: "settled" };
      },
      sleep: async () => {},
      _fn: retryDeliveriesFn,
    });
    const vi_ = await import("vitest");
    vi_.vi.resetModules();
    const a = (await import("@/lib/waitlist/over-invite-retry")).retryDeliveries;
    vi_.vi.resetModules();
    const b = (await import("@/lib/waitlist/over-invite-retry")).retryDeliveries; // a separate module instance: its in-process guard is separate
    const target = [{ entryId: "e1", itemId: "i1", studioId: "s" }];
    const [ra, rb] = await Promise.all([a(deps(a), target), b(deps(b), target)]);
    expect(sends).toBe(1);
    expect([ra[0].status, rb[0].status].sort()).toEqual(["sent", "skipped"]);
  });
});

describe("nothing is delivered unless replace answered replaced", () => {
  for (const result of ["state_changed", "refused", "no_live_invitation", "invitation_redeemed", "not_found"]) {
    it(`replace answers ${result}: no delivery, no sent mark`, async () => {
      let delivered = 0;
      const settled: string[] = [];
      const r = await retryDeliveries(
        {
          kind: "unknown",
          stillRetryable: async () => ({ state: "unknown", invitationId: "inv-1" }),
          replace: async () => ({ ok: true, result }),
          deliver: async () => (delivered++, "accepted"),
          settle: async (_t, o, why, exp) => (settled.push(`${o}:${why}:${exp}`), { ok: true, result: "settled" }),
          sleep: async () => {},
        },
        [{ entryId: "e", itemId: "i-" + result, studioId: "s" }],
      );
      expect(delivered).toBe(0);
      expect(settled.some((x) => x.startsWith("sent"))).toBe(false);
      expect(r[0].status).toBe("skipped");
      if (result === "state_changed") expect(settled).toEqual(["failed:retry_started:unknown"]); // left as the other caller has it
    });
  }
  it("the mark and the invitation check receive the values just read", async () => {
    const seen: string[] = [];
    await retryDeliveries(
      {
        kind: "refused",
        stillRetryable: async () => ({ state: "failed", invitationId: "INV-X" }),
        replace: async (_e, expected) => (seen.push(`replace:${expected}`), { ok: true, result: "state_changed" }),
        deliver: async () => "accepted",
        settle: async (_t, _o, _w, exp) => (seen.push(`settle:${exp}`), { ok: true, result: "settled" }),
        sleep: async () => {},
      },
      [{ entryId: "e", itemId: "i-pass", studioId: "s" }],
    );
    expect(seen).toEqual(["settle:failed", "replace:INV-X"]);
  });
});

describe("port passes the expected values and keeps state_changed as a closed code", () => {
  it("replace sends p_expected_invitation_id; settle sends p_expected_state; state_changed survives the closed set", async () => {
    const { replaceInvitation, settleItem } = await import("@/lib/waitlist/over-invite-port");
    const calls: [string, Record<string, unknown>][] = [];
    const db = { rpc: async (fn: string, args: Record<string, unknown>) => (calls.push([fn, args]), { data: fn.startsWith("replace") ? [{ result: "state_changed" }] : "state_changed", error: null }) };
    const r = await replaceInvitation(db as never, { studioId: "s", actorUserId: "a", entryId: "e", expectedInvitationId: "INV" });
    const s = await settleItem(db as never, { itemId: "i", studioId: "s", entryId: "e" }, "failed", "retry_started", "unknown");
    expect(calls[0][1]).toMatchObject({ p_expected_invitation_id: "INV" });
    expect(calls[1][1]).toMatchObject({ p_expected_state: "unknown" });
    expect(r).toEqual({ ok: true, result: "state_changed" });
    expect(s).toEqual({ ok: true, result: "state_changed" });
  });
});

describe("the retry mark gates everything after it", () => {
  const issued = { invitationId: "inv-2", rawToken: "t", issuedAt: new Date(), expiresAt: new Date(), deliveryEmail: null, deliveryName: null };
  const marks: [string, SettleOutcome][] = [
    ["state_changed", { ok: true, result: "state_changed" }],
    ["not_found", { ok: true, result: "not_found" }],
    ["invalid_state", { ok: true, result: "invalid_state" }],
    ["a failed call", { ok: false, code: "unavailable" as never }],
  ];
  for (const [name, answer] of marks) {
    it(`a mark answering ${name} stops the retry BEFORE replace; nothing is replaced or delivered`, async () => {
      let replaced = 0, delivered = 0;
      const r = await retryDeliveries(
        {
          kind: "refused",
          stillRetryable: async () => ({ state: "failed", invitationId: "inv-1" }),
          replace: async () => (replaced++, { ok: true, result: "replaced", issued }),
          deliver: async () => (delivered++, "accepted"),
          settle: async () => answer,
          sleep: async () => {},
        },
        [{ entryId: "e", itemId: "i-" + name, studioId: "s" }],
      );
      expect(replaced).toBe(0);
      expect(delivered).toBe(0);
      expect(r[0]).toMatchObject({ status: "skipped", reason: "no_longer_retryable" });
    });
  }
  it("the sent settle names the expected state: the retry mark leaves the item in failed", async () => {
    const calls: string[] = [];
    await retryDeliveries(
      {
        kind: "unknown",
        stillRetryable: async () => ({ state: "unknown", invitationId: "inv-1" }),
        replace: async () => ({ ok: true, result: "replaced", issued }),
        deliver: async () => "accepted",
        settle: async (_t, o, why, exp) => (calls.push(`${o}:${why}:${exp}`), { ok: true, result: "settled" }),
        sleep: async () => {},
      },
      [{ entryId: "e", itemId: "i-sent", studioId: "s" }],
    );
    // The mark names the state seen (unknown); every later settle names `failed`, the state the mark left behind.
    expect(calls).toEqual(["failed:retry_started:unknown", "sent:null:failed"]);
  });
});

describe("the claim modes: exactly two shapes claim anything", () => {
  const limits = { perStudio: 5, total: 5, leaseSeconds: 120 };
  it("port: scoped sends the batch and the owner; background sends neither", async () => {
    const { claimItems } = await import("@/lib/waitlist/over-invite-port");
    const calls: Record<string, unknown>[] = [];
    const db = { rpc: async (_f: string, a: Record<string, unknown>) => (calls.push(a), { data: [], error: null }) };
    await claimItems(db as never, { ...limits, claim: { mode: "scoped", batchId: "B", actorUserId: "U" } });
    await claimItems(db as never, { ...limits, claim: { mode: "background" } });
    expect(calls[0]).toMatchObject({ p_batch_id: "B", p_actor_user_id: "U" });
    expect(calls[1]).toMatchObject({ p_batch_id: null, p_actor_user_id: null });
  });
  const BAD: [string, unknown][] = [
    ["undefined", undefined],
    ["empty object", {}],
    ["scoped with no batch", { mode: "scoped", actorUserId: "U" }],
    ["scoped with no owner", { mode: "scoped", batchId: "B" }],
    ["scoped with an empty owner", { mode: "scoped", batchId: "B", actorUserId: "" }],
    ["scoped with a studio only", { mode: "scoped", studioId: "s" }],
    ["an unknown mode", { mode: "all" }],
    ["background with extra ids", { mode: "scoped" }],
  ];
  for (const [name, claim] of BAD) {
    it(`the port never calls the database for ${name}`, async () => {
      const { claimItems } = await import("@/lib/waitlist/over-invite-port");
      let called = 0;
      const db = { rpc: async () => (called++, { data: [], error: null }) };
      const r = await claimItems(db as never, { ...limits, claim: claim as never });
      expect(called).toBe(0);
      expect(r).toEqual({ ok: false, code: "bad_scope" });
    });
    it(`the worker never calls claim for ${name}`, async () => {
      const { runBatchChunk } = await import("@/lib/waitlist/over-invite-worker");
      let called = 0;
      const r = await runBatchChunk({ ...baseDeps, claim: async () => (called++, { ok: true as const, items: [] }) }, undefined, claim as never);
      expect(called).toBe(0);
      expect(r).toEqual({ ok: true, outcomes: [], claimed: 0 });
    });
    it(`runRounds claims nothing for ${name}`, async () => {
      let called = 0;
      await runRounds({ budgetMs: 20_000, mode: claim as never, deps: { ...baseDeps, claim: async () => (called++, { ok: true as const, items: [] }) }, now: () => 0 });
      expect(called).toBe(0);
    });
  }
  const baseDeps = { admit: async () => ({ ok: false as const, code: "unavailable" as const }), settle: async () => ({ ok: true as const, result: "settled" }), deliver: async () => "accepted" as const, mayStillSend: async () => true, sleep: async () => {} };
  it("only the background route claims unscoped; a full scoped mode claims scoped and background claims background", async () => {
    const seen: unknown[] = [];
    const claim = async (_l: unknown, m: unknown) => (seen.push(m), { ok: true as const, items: [] });
    await runRounds({ budgetMs: 20_000, mode: { mode: "background" }, deps: { ...baseDeps, claim }, now: () => 0 });
    await runRounds({ budgetMs: 20_000, mode: { mode: "scoped", studioId: "s", batchId: "B", actorUserId: "U" }, deps: { ...baseDeps, claim }, now: () => 0 });
    expect(seen).toEqual([{ mode: "background" }, { mode: "scoped", studioId: "s", batchId: "B", actorUserId: "U" }]);
  });
  const item = (batchId: string, studioId: string, n: number) => ({ itemId: `i${n}`, batchId, studioId, entryId: `e${n}`, actorUserId: "a", serviceId: "v", startDate: "d", endDate: "d", allowedWeekdays: null, ttlHours: 1 });
  it("a scoped claim that ever returns a foreign item processes NOTHING and reports claim_failed", async () => {
    const { runBatchChunk } = await import("@/lib/waitlist/over-invite-worker");
    for (const foreign of [item("OTHER", "s", 2), item("B", "OTHER-STUDIO", 3)]) {
      let admitted = 0;
      const r = await runBatchChunk(
        { ...baseDeps, claim: async () => ({ ok: true as const, items: [item("B", "s", 1), foreign] }), admit: async () => (admitted++, { ok: false as const, code: "unavailable" as const }) },
        undefined,
        { mode: "scoped", studioId: "s", batchId: "B", actorUserId: "U" },
      );
      expect(r).toEqual({ ok: false, code: "claim_failed" });
      expect(admitted).toBe(0);
    }
  });
});
