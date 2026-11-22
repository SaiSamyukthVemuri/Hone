import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => { throw new Error("no real client in unit tests"); } }));
vi.mock("@/lib/ops/alerts", () => ({ recordOpsAlert: vi.fn(async () => undefined) }));

import { readChartingRollout, chartingRolloutFor, xcellRouteDecision, resetRolloutAlertWindowForTests, CHARTING_ROLLOUT_KEY } from "@/lib/rollouts/charting-rollout";

const STUDIO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // synthetic
beforeEach(() => resetRolloutAlertWindowForTests());

describe("the resolver fails closed", () => {
  it("true is on, false is off, with the key and studio passed to the database command", async () => {
    const rpc = vi.fn(async () => ({ data: true, error: null }));
    expect(await readChartingRollout(STUDIO, { rpc })).toBe("on");
    expect(rpc).toHaveBeenCalledWith("platform_rollout_enabled_for", { p_key: CHARTING_ROLLOUT_KEY, p_studio: STUDIO });
    expect(await readChartingRollout(STUDIO, { rpc: async () => ({ data: false, error: null }) })).toBe("off");
  });
  it("no studio id is off and makes no call", async () => {
    const rpc = vi.fn();
    for (const id of [null, undefined, ""]) expect(await readChartingRollout(id, { rpc })).toBe("off");
    expect(rpc).not.toHaveBeenCalled();
  });
  it("an error, a thrown failure and any non-boolean answer are 'error', which display treats as OFF", async () => {
    for (const rpc of [async () => ({ data: null, error: { message: "boom" } }), async () => { throw new Error("down"); }, async () => ({ data: "true", error: null }), async () => ({ data: null, error: null }), async () => ({ data: 1, error: null })]) {
      expect(await readChartingRollout(STUDIO, { rpc, alert: () => undefined })).toBe("error");
      expect(await chartingRolloutFor(STUDIO, { rpc, alert: () => undefined })).toBe(false);
    }
  });
  it("never cached: a second read asks again and sees the new answer", async () => {
    let v = true;
    const rpc = vi.fn(async () => ({ data: v, error: null }));
    expect(await readChartingRollout(STUDIO, { rpc })).toBe("on");
    v = false;
    expect(await readChartingRollout(STUDIO, { rpc })).toBe("off");
    expect(rpc).toHaveBeenCalledTimes(2);
  });
});

describe("a failed read raises ONE rate-limited ops alert (an outage is not silently 'off')", () => {
  it("alerts on the first failure, not again inside the window, and again after it", async () => {
    const alert = vi.fn();
    let t = 1_000_000;
    const deps = { rpc: async () => ({ data: null, error: { message: "x" } }), alert, now: () => t };
    await readChartingRollout(STUDIO, deps);
    await readChartingRollout(STUDIO, deps);
    t += 60_000;
    await readChartingRollout(STUDIO, deps);
    expect(alert).toHaveBeenCalledTimes(1);
    t += 5 * 60_000;
    await readChartingRollout(STUDIO, deps);
    expect(alert).toHaveBeenCalledTimes(2);
  });
  it("the alert text carries no studio id and no database message", async () => {
    const alert = vi.fn();
    await readChartingRollout(STUDIO, { rpc: async () => ({ data: null, error: { message: "secret detail" } }), alert });
    expect(String(alert.mock.calls[0][0])).not.toMatch(/secret detail|aaaaaaaa/);
  });
  it("a success never alerts", async () => {
    const alert = vi.fn();
    await readChartingRollout(STUDIO, { rpc: async () => ({ data: true, error: null }), alert });
    expect(alert).not.toHaveBeenCalled();
  });
});

describe("the new-setup route decision: an existing block keeps its machine, a new setup follows the rollout", () => {
  it("an EXISTING MultiPlex block keeps its route whatever the rollout says, including a failed read", () => {
    for (const rollout of ["on", "off", "error"] as const) expect(xcellRouteDecision({ existingBlockUsesXcellPur: true, rollout })).toBe("offer");
  });
  it("a new setup: on offers, off hides, a failed read REFUSES (never degrades to the legacy machine)", () => {
    expect(xcellRouteDecision({ existingBlockUsesXcellPur: false, rollout: "on" })).toBe("offer");
    expect(xcellRouteDecision({ existingBlockUsesXcellPur: false, rollout: "off" })).toBe("hide");
    expect(xcellRouteDecision({ existingBlockUsesXcellPur: false, rollout: "error" })).toBe("refuse");
  });
});

describe("no environment variable anywhere", () => {
  it("the resolver and the registration gate read no environment variable", () => {
    for (const f of ["lib/rollouts/charting-rollout.ts", "lib/machines/xcell-registration-gate.ts"]) {
      expect(readFileSync(f, "utf8").replace(/\/\/.*$/gm, ""), f).not.toMatch(/process\.env/);
    }
  });
});
