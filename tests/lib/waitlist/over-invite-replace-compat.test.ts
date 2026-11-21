import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { replaceInvitation, type SettleOutcome } from "@/lib/waitlist/over-invite-port";
import { retryDeliveries } from "@/lib/waitlist/over-invite-retry";
import { SENDING_WINDOW_MS, tallyItems } from "@/lib/waitlist/over-invite-progress";

// The current replace command differs from the older one in three ways this app must follow: (1) two new closed refusal codes, invitation_ended and
// invitation_expired; (2) a replaced FAILED item starts a new attempt, so it goes back to `issued` with its old outcome cleared (the older one left it `failed`);
// (3) the lock order, which is invisible here. These tests pin what the app does with (1) and (2), and that it works with the older and the current command.

const issued = { invitationId: "inv-2", rawToken: "t", issuedAt: new Date(), expiresAt: new Date(), deliveryEmail: "a@b.test", deliveryName: null };
const target = [{ entryId: "e", itemId: "i", studioId: "s" }];

describe("the port's closed refusal set knows the ended and expired codes", () => {
  const rpc = (result: string) => ({ rpc: async () => ({ data: [{ result }], error: null }) }) as never;
  const input = { studioId: "s", actorUserId: "a", entryId: "e", expectedInvitationId: "inv-1" };
  for (const code of ["invitation_ended", "invitation_expired"]) {
    it(`${code} is passed through as itself`, async () => {
      expect(await replaceInvitation(rpc(code), input)).toEqual({ ok: true, result: code });
    });
  }
  it("a code the app does not know is still collapsed to refused", async () => {
    expect(await replaceInvitation(rpc("invitation_vaporised"), input)).toEqual({ ok: true, result: "refused" });
  });
});

describe("a retry that finds the invitation over", () => {
  for (const code of ["invitation_ended", "invitation_expired"]) {
    it(`${code}: nothing is delivered, the item is recorded under its own reason, and the owner is told it was not sent`, async () => {
      let delivered = 0;
      const settled: string[] = [];
      const r = await retryDeliveries(
        {
          kind: "refused",
          stillRetryable: async () => ({ state: "failed", invitationId: "inv-1" }),
          replace: async () => ({ ok: true, result: code }),
          deliver: async () => (delivered++, "accepted"),
          settle: async (_t, o, why) => (settled.push(`${o}:${why}`), { ok: true, result: "settled" }),
          sleep: async () => {},
        },
        target,
      );
      expect(delivered).toBe(0);
      expect(settled).toEqual(["failed:retry_started", `failed:${code}`]);
      expect(r[0]).toEqual({ entryId: "e", status: "skipped", reason: code });
    });
  }
  it("an ordinary permanent refusal is still recorded as retry_not_possible", async () => {
    const settled: string[] = [];
    await retryDeliveries(
      {
        kind: "refused",
        stillRetryable: async () => ({ state: "failed", invitationId: "inv-1" }),
        replace: async () => ({ ok: true, result: "invitation_redeemed" }),
        deliver: async () => "accepted",
        settle: async (_t, o, why) => (settled.push(`${o}:${why}`), { ok: true, result: "settled" }),
        sleep: async () => {},
      },
      target,
    );
    expect(settled).toEqual(["failed:retry_started", "failed:retry_not_possible"]);
  });
});

// A database model of the item, with the compare-and-swap rules settle_waitlist_batch_item has, and the two behaviours of replace.
function world(replaceLeavesState: "failed" | "issued") {
  const item = { state: "failed", invitation: "inv-1", reason: "delivery_refused" as string | null };
  const log: string[] = [];
  const settle = async (_t: unknown, outcome: string, why: string | null, expectedState?: string, expectedInv?: string | null): Promise<SettleOutcome> => {
    if (expectedInv !== undefined && expectedInv !== null && item.invitation !== expectedInv) return { ok: true, result: "state_changed" };
    if (expectedState !== undefined && item.state !== expectedState) return { ok: true, result: "state_changed" };
    item.state = outcome === "sent" ? "sent" : "failed";
    item.reason = why;
    log.push(`${outcome}:${why}`);
    return { ok: true, result: "settled" };
  };
  const replace = async () => {
    item.invitation = "inv-2";
    if (replaceLeavesState === "issued") {
      item.state = "issued";
      item.reason = null;
    }
    return { ok: true as const, result: "replaced" as const, issued };
  };
  return { item, log, settle, replace };
}

describe("a retry settles the replacement whether the item is `failed` (older replace) or `issued` (current replace) after the replace", () => {
  for (const after of ["failed", "issued"] as const) {
    it(`accepted delivery is recorded sent (item ${after} after replace)`, async () => {
      const w = world(after);
      const r = await retryDeliveries(
        { kind: "refused", stillRetryable: async () => ({ state: "failed", invitationId: "inv-1" }), replace: w.replace, deliver: async () => "accepted", settle: w.settle, sleep: async () => {} },
        target,
      );
      expect(r[0]).toEqual({ entryId: "e", status: "sent" });
      expect(w.item.state).toBe("sent");
    });
    it(`a refused delivery stays retryable under its reason (item ${after} after replace)`, async () => {
      const w = world(after);
      const r = await retryDeliveries(
        { kind: "refused", stillRetryable: async () => ({ state: "failed", invitationId: "inv-1" }), replace: w.replace, deliver: async () => "refused", settle: w.settle, sleep: async () => {} },
        target,
      );
      expect(r[0]).toMatchObject({ status: "failed", reason: "delivery_refused" });
      expect(w.item).toMatchObject({ state: "failed", reason: "delivery_refused", invitation: "inv-2" });
    });
    it(`a thrown delivery is recorded unknown, never refused (item ${after} after replace)`, async () => {
      const w = world(after);
      const r = await retryDeliveries(
        { kind: "refused", stillRetryable: async () => ({ state: "failed", invitationId: "inv-1" }), replace: w.replace, deliver: async () => { throw new Error("x"); }, settle: w.settle, sleep: async () => {} },
        target,
      );
      expect(r[0]).toMatchObject({ status: "failed", reason: "delivery_unknown" });
      expect(w.item.reason).toBe("delivery_unknown");
    });
  }
  it("on the failed path too, a settle answered with anything but `settled` is reported as settle_failed, not under the delivery reason", async () => {
    for (const kind of ["refused", "unknown"] as const) {
      for (const answer of ["state_changed", "not_found", "invalid_state"]) {
        const r = await retryDeliveries(
          {
            kind,
            stillRetryable: async () => ({ state: kind === "refused" ? "failed" : "unknown", invitationId: "inv-1" }),
            replace: async () => ({ ok: true, result: "replaced", issued }),
            deliver: async () => (kind === "refused" ? "refused" : "unknown"),
            settle: async (_t, _o, why) => (why === "retry_started" ? { ok: true, result: "settled" } : { ok: true, result: answer }),
            sleep: async () => {},
          },
          target,
        );
        expect(r[0], `${kind}/${answer}`).toEqual({ entryId: "e", status: "failed", reason: "settle_failed" });
      }
    }
  });
  it("a settle the database answers with anything but `settled` is reported as not recorded, never as sent", async () => {
    for (const answer of ["state_changed", "already_sent", "invalid_state"]) {
      const r = await retryDeliveries(
        {
          kind: "refused",
          stillRetryable: async () => ({ state: "failed", invitationId: "inv-1" }),
          replace: async () => ({ ok: true, result: "replaced", issued }),
          deliver: async () => "accepted",
          settle: async (_t, _o, why) => (why === "retry_started" ? { ok: true, result: "settled" } : { ok: true, result: answer }),
          sleep: async () => {},
        },
        target,
      );
      expect(r[0], answer).toEqual({ entryId: "e", status: "failed", reason: "settle_failed" });
    }
  });
  it("the settle after a replace names the NEW invitation and no expected state", async () => {
    const calls: { state?: string; inv?: string | null }[] = [];
    await retryDeliveries(
      {
        kind: "refused",
        stillRetryable: async () => ({ state: "failed", invitationId: "inv-1" }),
        replace: async () => ({ ok: true, result: "replaced", issued }),
        deliver: async () => "accepted",
        settle: async (_t, _o, why, st, inv) => {
          if (why !== "retry_started") calls.push({ state: st, inv });
          return { ok: true, result: "settled" };
        },
        sleep: async () => {},
      },
      target,
    );
    expect(calls).toEqual([{ state: undefined, inv: "inv-2" }]);
  });
});

describe("the progress view of an item a replace has reset", () => {
  const now = Date.parse("2026-11-21T12:00:00Z");
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  it("a replaced item (issued, fresh, no reason) is Sending, not refused and not failed", () => {
    const t = tallyItems([{ state: "issued", reason_class: null, issued_at: iso(5_000) }], now);
    expect(t).toMatchObject({ sending: 1, refused: 0, otherFailed: 0, unknown: 0 });
  });
  it("one nobody settled for longer than the lease is shown as unknown (the next claim sweeps it to unknown)", () => {
    const t = tallyItems([{ state: "issued", reason_class: null, issued_at: iso(SENDING_WINDOW_MS + 1_000) }], now);
    expect(t).toMatchObject({ sending: 0, unknown: 1, refused: 0 });
  });
  it("a retry that found the invitation over is counted as ended, not as a failure", () => {
    const t = tallyItems(
      [
        { state: "failed", reason_class: "invitation_ended", issued_at: null },
        { state: "failed", reason_class: "invitation_expired", issued_at: null },
        { state: "failed", reason_class: "retry_not_possible", issued_at: null },
      ],
      now,
    );
    expect(t).toMatchObject({ ended: 2, otherFailed: 1, refused: 0 });
  });
});

describe("a transient replace failure puts the item back as the kind it was", () => {
  const rows = (kind: "refused" | "unknown") => {
    const calls: { outcome: string; reason: string | null; expected: string | null | undefined }[] = [];
    return {
      calls,
      deps: {
        kind,
        stillRetryable: async () => ({ state: kind === "refused" ? "failed" : "unknown", invitationId: "inv-1" }),
        replace: async () => ({ ok: false as const, code: "unavailable" as const }),
        deliver: async () => { throw new Error("must not deliver"); },
        settle: async (_t: unknown, outcome: string, reason: string | null, expected?: string | null) => (calls.push({ outcome, reason, expected }), { ok: true as const, result: "settled" }),
        sleep: async () => {},
      },
    };
  };
  it("the mark is followed by a put-back under the ORIGINAL kind's reason, guarded by the state the mark set", async () => {
    for (const [kind, reason] of [["refused", "delivery_refused"], ["unknown", "delivery_unknown"]] as const) {
      const w = rows(kind);
      const r = await retryDeliveries(w.deps as never, target);
      expect(r[0], kind).toEqual({ entryId: "e", status: "skipped", reason: "replace_unavailable" });
      expect(w.calls, kind).toEqual([
        { outcome: "failed", reason: "retry_started", expected: kind === "refused" ? "failed" : "unknown" },
        { outcome: "failed", reason, expected: "failed" },
      ]);
    }
  });
  it("what is put back is offered to the SAME retry kind again and counted as that kind, never as the other", () => {
    const refused = { state: "failed", reason_class: "delivery_refused", issued_at: null };
    const unknown = { state: "failed", reason_class: "delivery_unknown", issued_at: null };
    expect(tallyItems([refused])).toMatchObject({ refused: 1, unknown: 0, unknownRetryable: 0 });
    expect(tallyItems([unknown])).toMatchObject({ refused: 0, unknown: 1, unknownRetryable: 1 });
  });
});
