import { beforeEach, describe, expect, it, vi } from "vitest";

// A rollout command can fail two different ways. If it was REFUSED the database rolled back and "nothing changed" is true. If the call threw, timed out
// or its answer never came back it may have COMMITTED, so the rollout may already be in the new state (possibly On for every studio), and the operator
// must be told the result is UNKNOWN and to reload, never that nothing changed.
const S = vi.hoisted(() => ({ next: { kind: "ok", value: "changed" } as { kind: string; value?: string } }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "11111111-1111-4111-8111-111111111111", email: "op@example.invalid" } } }) } }) }));
vi.mock("@/lib/admin", () => ({ isAdmin: (e: string | null | undefined) => e === "op@example.invalid" }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => { throw new Error("no real client"); } }));
vi.mock("@/lib/rollouts/admin-commands", async (orig) => {
  const real = await orig<typeof import("@/lib/rollouts/admin-commands")>();
  return {
    ...real,
    setRolloutMode: vi.fn(async () => S.next),
    addPilotStudio: vi.fn(async () => S.next),
    removePilotStudio: vi.fn(async () => S.next),
    logBlockedAttempt: vi.fn(async () => undefined),
  };
});

import { addPilotStudioAction, removePilotStudioAction, setRolloutModeAction } from "@/app/admin/rollouts/actions";
import { addPilotStudio, removePilotStudio, setRolloutMode, type RolloutRpc } from "@/lib/rollouts/admin-commands";

const realCommands = await vi.importActual<typeof import("@/lib/rollouts/admin-commands")>("@/lib/rollouts/admin-commands");
const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const STUDIO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACTOR = { userId: "11111111-1111-4111-8111-111111111111", email: "op@example.invalid" };
const ACTIONS: Array<[string, () => Promise<{ ok: boolean; message: string }>]> = [
  ["set mode", () => setRolloutModeAction(form({ mode: "all", confirm: "ALL STUDIOS" }))],
  ["add pilot studio", () => addPilotStudioAction(form({ studioId: STUDIO }))],
  ["remove pilot studio", () => removePilotStudioAction(form({ studioId: STUDIO }))],
];
beforeEach(() => { S.next = { kind: "ok", value: "changed" }; });

describe("the three actions tell UNKNOWN from REFUSED", () => {
  for (const [name, run] of ACTIONS) {
    it(`${name}: an UNKNOWN outcome says the result is unknown, to reload and check, and never 'Nothing changed'`, async () => {
      S.next = { kind: "unknown" };
      const r = await run();
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/UNKNOWN/);
      expect(r.message).toMatch(/Reload/);
      expect(r.message).not.toMatch(/nothing changed/i);
    });
    it(`${name}: a definitive REFUSAL may say nothing changed`, async () => {
      S.next = { kind: "refused" };
      const r = await run();
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/Nothing changed/);
      expect(r.message).not.toMatch(/UNKNOWN/);
    });
  }
});

describe("the commands classify what came back", () => {
  const real = realCommands;
  const rpcOf = (r: () => Promise<{ data: unknown; error: { message?: string; code?: string } | null }>): RolloutRpc => () => r();
  const cases: Array<[string, RolloutRpc, "ok" | "refused" | "unknown"]> = [
    ["an answer string", rpcOf(async () => ({ data: "changed", error: null })), "ok"],
    ["a call that throws (network or timeout)", rpcOf(async () => { throw new Error("fetch failed"); }), "unknown"],
    ["an error with no code (gateway, timeout)", rpcOf(async () => ({ data: null, error: { message: "upstream request timeout" } })), "unknown"],
    ["a connection-class error code (08006)", rpcOf(async () => ({ data: null, error: { message: "connection failure", code: "08006" } })), "unknown"],
    ["a server-side error code (XX000)", rpcOf(async () => ({ data: null, error: { message: "internal", code: "XX000" } })), "unknown"],
    ["no error but an answer that is not a string", rpcOf(async () => ({ data: null, error: null })), "unknown"],
    ["the database's own refusal (23514)", rpcOf(async () => ({ data: null, error: { message: "platform rollout: unknown mode", code: "23514" } })), "refused"],
  ];
  for (const [label, rpc, kind] of cases) {
    it(`${label} is ${kind} for set, add and remove alike`, async () => {
      for (const out of [await real.setRolloutMode("pilot", ACTOR, rpc), await real.addPilotStudio(STUDIO, ACTOR, rpc), await real.removePilotStudio(STUDIO, ACTOR, rpc)]) {
        expect(out.kind).toBe(kind);
      }
    });
  }
  it("the mocked module is not the one under test (guard against testing the mock)", () => {
    expect(setRolloutMode).not.toBe(real.setRolloutMode);
    expect(addPilotStudio).not.toBe(real.addPilotStudio);
    expect(removePilotStudio).not.toBe(real.removePilotStudio);
  });
});
