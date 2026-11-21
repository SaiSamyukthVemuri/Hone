import { describe, expect, it } from "vitest";
import { ensureOpenRound, tryOpenRound } from "@/lib/waitlist/auto-round";

const rpcReturning = (v: unknown) => ({ rpc: async () => v }) as never;

describe("tryOpenRound tells a refusal from a lost answer", () => {
  it("opened and round_already_open are `open`", async () => {
    for (const r of ["opened", "round_already_open"]) {
      expect(await tryOpenRound(rpcReturning({ data: [{ result: r }], error: null }), "s", "a")).toBe("open");
      expect(await tryOpenRound(rpcReturning({ data: r, error: null }), "s", "a")).toBe("open");
    }
  });
  it("any other closed answer is `refused`", async () => {
    for (const r of ["not_owner", "unknown_studio", "invalid_input", "something_new"]) {
      expect(await tryOpenRound(rpcReturning({ data: [{ result: r }], error: null }), "s", "a")).toBe("refused");
    }
  });
  it("an error or an unreadable answer is `unknown`", async () => {
    expect(await tryOpenRound(rpcReturning({ data: null, error: { code: "57014" } }), "s", "a")).toBe("unknown");
    expect(await tryOpenRound(rpcReturning({ data: [{ nothing: 1 }], error: null }), "s", "a")).toBe("unknown");
    expect(await tryOpenRound(rpcReturning({ data: null, error: null }), "s", "a")).toBe("unknown");
  });
});

describe("the single invitation's ensureOpenRound is unchanged", () => {
  it("true only when a round is open; a refusal, an error and an unreadable answer are all false", async () => {
    expect(await ensureOpenRound(rpcReturning({ data: [{ result: "opened" }], error: null }), "s", "a")).toBe(true);
    expect(await ensureOpenRound(rpcReturning({ data: [{ result: "round_already_open" }], error: null }), "s", "a")).toBe(true);
    expect(await ensureOpenRound(rpcReturning({ data: [{ result: "not_owner" }], error: null }), "s", "a")).toBe(false);
    expect(await ensureOpenRound(rpcReturning({ data: null, error: { code: "57014" } }), "s", "a")).toBe(false);
    expect(await ensureOpenRound(rpcReturning({ data: [{ nothing: 1 }], error: null }), "s", "a")).toBe(false);
  });
  it("a thrown call still propagates to its caller, as before", async () => {
    await expect(ensureOpenRound({ rpc: async () => { throw new Error("x"); } } as never, "s", "a")).rejects.toThrow("x");
  });
});
