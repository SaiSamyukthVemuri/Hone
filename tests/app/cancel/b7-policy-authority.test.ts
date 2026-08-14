import { describe, it, expect, vi, beforeEach } from "vitest";

// B7 / 0176: the DATABASE is the policy authority, not the action.
//
// The action used to re-read the studio's current policy and refuse early when
// it required an acknowledgement the form had not sent. That made the action a
// SECOND policy authority and hid a case the command must decide: a page that
// rendered NO policy, a studio that ADDS one, and a submit carrying the
// empty-snapshot hash. The early return answered "acknowledgement required",
// which invites the client to tick a box for text they have still never seen.
// The command answers `policy_changed`, which forces the new policy to be
// re-presented and consented to afresh.
//
// The contract is therefore: the action FORWARDS the submission and surfaces
// whatever the database decided.

const rpcCalls: Array<{ args: Record<string, unknown> }> = [];

// Stands in for a 0176 database that has just had a policy ADDED: the presented
// empty-snapshot hash no longer matches, so the command answers policy_changed.
function rpcResponse(_args: Record<string, unknown>) {
  return {
    data: [
      {
        result: "policy_changed",
        appointment_id: "appt-1",
        studio_id: "studio-1",
        policy_acknowledgement_id: null,
      },
    ],
    error: null,
  };
}

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    rpc: async (_name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ args });
      return rpcResponse(args);
    },
    from: () => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.order = () => q;
      q.limit = () => q;
      // A resolvable appointment row: the action looks this up BOTH to resolve
      // the token and to recover the stored hash it passes to the command. If
      // either returns null the action collapses before the RPC and the test
      // would prove nothing, which is why the first test asserts that exactly
      // one RPC call actually happened.
      q.maybeSingle = async () => ({
        data: { id: "appt-1", cancellation_token_hash: "b".repeat(64), studio: { cancellation_policy_text: "P", no_show_policy_text: null } },
        error: null,
      });
      q.insert = async () => {
        throw new Error("B7: the action must not write during an old-DB skew");
      };
      q.update = () => {
        throw new Error("B7: the action must not write during an old-DB skew");
      };
      return q;
    },
  }),
}));

// The action reads request headers for rate limiting; there is no Next request
// scope in a unit test.
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.7" }),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

vi.mock("@/lib/rate-limit/public", () => ({
  limitTokenRoute: async () => ({ allowed: true }),
  RATE_LIMIT_MESSAGE: "rate limited",
}));

// A resolvable token, so the action reaches the RPC rather than collapsing
// earlier for an unrelated reason. Without this the test could pass while
// proving nothing, see the guard assertion in the first test.
vi.mock("@/lib/booking/tokens", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    verifyCancellationToken: () => ({ ok: true, appointment_id: "appt-1" }),
  };
});

import { publicCancelAppointmentAction } from "@/app/cancel/[token]/actions";

function fd(): FormData {
  const f = new FormData();
  f.set("token", "raw-token");
  f.set("reason", "schedule_changed");
  f.set("acknowledged_policy", "true");
  f.set("presented_policy_hash", "a".repeat(64));
  return f;
}

beforeEach(() => {
  rpcCalls.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("B7: the action defers to the database on policy", () => {
  it("a no-policy render + a policy added since => policy_changed reaches the caller", async () => {
    // The submission looks exactly like the frozen case D: the page saw no
    // policy, so it posts the EMPTY-snapshot hash and no acknowledgement.
    const f = new FormData();
    f.set("token", "raw-token");
    f.set("reason", "schedule_changed");
    f.set("presented_policy_hash", "e".repeat(64));

    const res = await publicCancelAppointmentAction(f);

    // The action must have FORWARDED rather than deciding. An action-level
    // requiresAck gate would return before any RPC happened.
    expect(rpcCalls, "the action must call the command, not pre-empt it").toHaveLength(1);
    expect(rpcCalls[0].args.p_acknowledged_policy).toBe(false);
    expect(rpcCalls[0].args.p_presented_policy_hash).toBe("e".repeat(64));

    // And it must surface policy_changed, not the ack-required copy, the
    // client has to SEE the new policy before consenting to it.
    expect(res.ok).toBe(false);
    if (res.ok === false) {
      expect(res.code).toBe("policy_changed");
      expect(res.error).toMatch(/policies changed while you were on this page/i);
      expect(res.error).not.toMatch(/must acknowledge|acknowledge the/i);
    }
  });

  it("does not read the studio policy itself before calling the command", async () => {
    const f = new FormData();
    f.set("token", "raw-token");
    f.set("reason", "schedule_changed");
    f.set("presented_policy_hash", "e".repeat(64));
    await publicCancelAppointmentAction(f);
    // One RPC, and the decision came back from it. The point is not the call
    // count for its own sake: it is that no second authority exists to disagree
    // with the database under a row lock.
    expect(rpcCalls).toHaveLength(1);
  });
});
