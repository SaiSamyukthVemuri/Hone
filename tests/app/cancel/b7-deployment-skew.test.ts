import { describe, it, expect, vi, beforeEach } from "vitest";

// B7 / 0176: the OLD DB + NEW APP deployment-skew contract.
//
// This is a BEHAVIOURAL test of the adapter, not a measurement of PostgREST
// overload resolution. Resolution was measured separately; what matters here is
// what the ACTION does with the answer.
//
// The dangerous version of this code called the legacy five-argument command
// after PGRST202. That looked like graceful degradation and was actually the B7
// defect on a timer: this route no longer writes the acknowledgement, so an
// old-DB cancellation would have committed the status flip and the audit row
// with NO acknowledgement and NO presentation-hash comparison.
//
// The contract is therefore: PGRST202 => refuse, and touch nothing.

const rpcCalls: Array<{ args: Record<string, unknown> }> = [];

// Simulates a 0175 database: the seven-argument command does not exist, so
// PostgREST answers PGRST202. The five-argument command IS still installed and
// would happily cancel, which is exactly why the action must not call it.
function rpcResponse(args: Record<string, unknown>) {
  const isNewCommand =
    "p_presented_policy_hash" in args || "p_acknowledged_policy" in args;
  if (isNewCommand) {
    return {
      data: null,
      error: {
        code: "PGRST202",
        message:
          "Could not find the function public.public_cancel_appointment_with_token(...) in the schema cache",
      },
    };
  }
  // The legacy path, if it were ever reached, would SUCCEED. A test whose stub
  // also failed here could not tell "did not call it" from "called it and it
  // failed", so it must succeed to be a real trap.
  return {
    data: [{ result: "cancelled", appointment_id: "appt-1", studio_id: "studio-1" }],
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
        data: { id: "appt-1", cancellation_token_hash: "b".repeat(64) },
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

describe("B7: OLD DB + NEW APP fails closed", () => {
  it("PGRST202 refuses, and NEVER calls the legacy five-argument command", async () => {
    const res = await publicCancelAppointmentAction(fd());

    // Refused.
    expect(res.ok).toBe(false);

    // THE LOAD-BEARING ASSERTION. Exactly one RPC attempt was made, and it
    // carried the new presentation-proof arguments. A second call, the legacy
    // five-argument shape, would have cancelled the appointment with no
    // acknowledgement and no hash comparison.
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].args).toHaveProperty("p_presented_policy_hash");
    expect(rpcCalls[0].args).toHaveProperty("p_acknowledged_policy");

    const legacyCalls = rpcCalls.filter(
      (c) => !("p_presented_policy_hash" in c.args) && !("p_acknowledged_policy" in c.args),
    );
    expect(legacyCalls, "the legacy mutating command must never be invoked").toHaveLength(0);
  });

  it("leaks neither the deployment state nor that the token resolved", async () => {
    const res = await publicCancelAppointmentAction(fd());
    expect(res.ok).toBe(false);
    if (res.ok === false) {
      // The public collapse copy: the same string an unknown token gets, so
      // this cannot be used to probe token validity or infer a deploy window.
      expect(res.error).not.toMatch(/PGRST|schema cache|function|deploy|migration/i);
      expect(res.code).toBeUndefined();
    }
  });
});
