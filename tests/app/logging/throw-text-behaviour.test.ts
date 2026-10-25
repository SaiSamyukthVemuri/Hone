import { describe, expect, it, vi } from "vitest";

// MSG-LOG-RAW-ERROR (R1), behaviour. Representative thrown messages, driven
// through the real functions with a database error that quotes a synthetic
// address and phone. The whole-tree rule is tests/lib/logging/throw-text-contract.test.ts;
// this proves the closed form keeps the context a person debugging needs
// (what failed, and the SQLSTATE) without the text.

vi.mock("server-only", () => ({}));

const EMAIL = "leak.probe@example.test";
const PHONE = "+1 555 010 0199";
const HOSTILE = `invalid input syntax for type uuid: "${EMAIL}" ${PHONE}`;

const reply = vi.hoisted(() => ({ error: null as { code?: string; message: string } | null }));
function chain(): unknown {
  const handler: ProxyHandler<object> = {
    get(_t, prop) {
      if (prop === "then") {
        return (resolve: (v: unknown) => void) => resolve({ data: null, error: reply.error });
      }
      return () => new Proxy({}, handler);
    },
  };
  return new Proxy({}, handler);
}
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from: () => chain() }) }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => ({ from: () => chain() }) }));

async function messageOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected a throw");
}

function expectClean(text: string) {
  expect(text).not.toContain(EMAIL);
  expect(text).not.toContain("leak.probe");
  expect(text.replace(/\D/g, "")).not.toContain("5550100199");
}

describe("a thrown database error keeps its context and its SQLSTATE, not its text", () => {
  it("getLatestIntakeForClient", async () => {
    reply.error = { code: "22P02", message: HOSTILE };
    const { getLatestIntakeForClient } = await import("@/lib/intake/queries");
    const m = await messageOf(() => getLatestIntakeForClient("s", "c"));
    expectClean(m);
    expect(m).toBe("Failed to load intake: 22P02");
  });

  it("getTreatmentGoal", async () => {
    reply.error = { code: "42501", message: HOSTILE };
    const { getTreatmentGoal } = await import("@/lib/treatment-time/queries");
    const m = await messageOf(() => getTreatmentGoal("s", "c"));
    expectClean(m);
    expect(m).toBe("Failed to load treatment goal: 42501");
  });

  it("an error object with no code is 'unknown', still without the text", async () => {
    reply.error = { message: HOSTILE };
    const { getTreatmentGoal } = await import("@/lib/treatment-time/queries");
    const m = await messageOf(() => getTreatmentGoal("s", "c"));
    expectClean(m);
    expect(m).toBe("Failed to load treatment goal: unknown");
  });

  it("an error whose code is the text is 'unknown'", async () => {
    reply.error = { code: HOSTILE, message: HOSTILE };
    const { getTreatmentGoal } = await import("@/lib/treatment-time/queries");
    const m = await messageOf(() => getTreatmentGoal("s", "c"));
    expectClean(m);
    expect(m).toBe("Failed to load treatment goal: unknown");
  });
});
