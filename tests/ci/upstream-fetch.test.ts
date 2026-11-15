import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { fetchUpstreamOnce, isConnectionReset, totalRetries, type UpstreamTally } from "../../e2e/helpers/upstream-fetch";

// The helper only touches `route.fetch`, so a scripted fake route simulates the driver-side
// socket reset deterministically (the real one happens inside Playwright's driver process
// and cannot be provoked from a spec).
const reset = () => Object.assign(new Error("route.fetch: read ECONNRESET"), { code: "ECONNRESET" });
const scripted = (outcomes: Array<"ok" | Error>) => {
  let calls = 0;
  return {
    get calls() { return calls; },
    fetch: async () => {
      const next = outcomes[calls++];
      if (next === undefined) throw new Error("fetch called more often than scripted");
      if (next instanceof Error) throw next;
      return { ok: true };
    },
  };
};
const fresh = (): UpstreamTally => ({ retriesPerFetch: [] });

describe("fetchUpstreamOnce", () => {
  it("passes a clean fetch through once and counts no retry", async () => {
    const route = scripted(["ok"]); const t = fresh();
    await expect(fetchUpstreamOnce(route, t)).resolves.toEqual({ ok: true });
    expect(route.calls).toBe(1);
    expect(t.retriesPerFetch).toEqual([0]);
  });

  it("retries ONE ECONNRESET, returns the second response, and counts it", async () => {
    const route = scripted([reset(), "ok"]); const t = fresh();
    await expect(fetchUpstreamOnce(route, t)).resolves.toEqual({ ok: true });
    expect(route.calls).toBe(2);
    expect(t.retriesPerFetch).toEqual([1]);
    expect(totalRetries(t)).toBe(1);
  });

  it("a second ECONNRESET is NOT retried again: the bound is one", async () => {
    const route = scripted([reset(), reset(), "ok"]); const t = fresh();
    await expect(fetchUpstreamOnce(route, t)).rejects.toThrow(/ECONNRESET/);
    expect(route.calls).toBe(2);
    expect(t.retriesPerFetch).toEqual([]);
  });

  it("any other error fails at once with NO retry", async () => {
    for (const failure of [new Error("route.fetch: socket hang up"), Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }), new Error("net::ERR_FAILED")]) {
      const route = scripted([failure, "ok"]); const t = fresh();
      await expect(fetchUpstreamOnce(route, t)).rejects.toBe(failure);
      expect(route.calls).toBe(1);
      expect(t.retriesPerFetch).toEqual([]);
    }
  });

  it("a non-reset failure on the retry attempt propagates and is not counted as a pass", async () => {
    const route = scripted([reset(), new Error("500 from upstream")]); const t = fresh();
    await expect(fetchUpstreamOnce(route, t)).rejects.toThrow(/500/);
    expect(t.retriesPerFetch).toEqual([]);
  });

  it("keeps a per-fetch record across several upstream fetches in one test", async () => {
    const t = fresh();
    await fetchUpstreamOnce(scripted(["ok"]), t);
    await fetchUpstreamOnce(scripted([reset(), "ok"]), t);
    expect(t.retriesPerFetch).toEqual([0, 1]);
    expect(totalRetries(t)).toBe(1);
  });

  it("recognises a reset by its code, or by Playwright's exact message form", () => {
    expect(isConnectionReset(reset())).toBe(true);
    expect(isConnectionReset(Object.assign(new Error("anything"), { code: "ECONNRESET" }))).toBe(true);
    expect(isConnectionReset(new Error("route.fetch: read ECONNRESET"))).toBe(true);
    expect(isConnectionReset(new Error("read ECONNRESET"))).toBe(true);
    expect(isConnectionReset(new Error("route.fetch: read ECONNRESET\nCall log:\n  - → POST http://localhost:3111/x"))).toBe(true);
    expect(isConnectionReset(new Error("ECONNREFUSED"))).toBe(false);
    expect(isConnectionReset(null)).toBe(false);
    expect(isConnectionReset("read ECONNRESET")).toBe(false);
  });

  it("a message that merely MENTIONS ECONNRESET is not a reset and is not retried", async () => {
    for (const message of [
      "the action failed; a previous ECONNRESET was logged",
      "upstream returned 500 after read ECONNRESET on another request",
      "route.fetch: socket hang up (not an ECONNRESET)",
      "Error: something read ECONNRESET happened",
    ]) {
      const failure = new Error(message);
      expect(isConnectionReset(failure)).toBe(false);
      const route = scripted([failure, "ok"]); const t = fresh();
      await expect(fetchUpstreamOnce(route, t)).rejects.toBe(failure);
      expect(route.calls).toBe(1);
    }
  });

  it("an error with the ECONNRESET code and an unrelated message IS retried", async () => {
    const route = scripted([Object.assign(new Error("fetch failed"), { code: "ECONNRESET" }), "ok"]); const t = fresh();
    await expect(fetchUpstreamOnce(route, t)).resolves.toEqual({ ok: true });
    expect(t.retriesPerFetch).toEqual([1]);
  });
});

describe("the native 3G intercept uses it, and the no-retry rule is untouched", () => {
  const spec = fs.readFileSync("e2e/machine-create-mode-journey.spec.ts", "utf8") as string;
  const ci = fs.readFileSync(".github/workflows/ci.yml", "utf8") as string;
  it("the lost-response intercept fetches upstream only through the helper", () => {
    expect(spec).toContain("fetchUpstreamOnce(route, lost)");
    expect(spec).toContain("expect(lost.retriesPerFetch.every((n) => n === 0 || n === 1)");
    expect(spec).toContain("upstream-econnreset-retry");
    const intercept = spec.slice(spec.indexOf("const lost = {"), spec.indexOf("const readIdentities"));
    expect(intercept).not.toMatch(/await route\.fetch\(/);
  });
  it("the step still runs with zero test retries and stops at the first failure", () => {
    const line = ci.split("\n").find((l) => l.includes("native 3G (durability")) ?? "";
    expect(line).toContain("--retries=0");
    expect(line).toContain("--max-failures=1");
  });
});
