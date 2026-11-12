import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const tableReads: string[] = [];
vi.mock("@/lib/intake/queries", () => ({
  getLatestIntakeForClient: vi.fn(async (_s: string, c: string) => { tableReads.push(c); return { id: "f1", client_id: c, status: "submitted", responses: { a: 1 } }; }),
}));
import { loadIntakeForViewer } from "@/lib/intake/viewer-intake";

const rpcCalls: Array<Record<string, unknown>> = [];
let projection: Array<{ client_id: string; status: string; created_at: string }> = [];
const db = {
  rpc: (_fn: string, args: Record<string, unknown>) => ({ range: async () => { rpcCalls.push(args); return { data: projection, error: null }; } }),
};
beforeEach(() => { tableReads.length = 0; rpcCalls.length = 0; projection = [{ client_id: "c1", status: "submitted", created_at: "2030-01-01T00:00:00Z" }]; });

describe("loadIntakeForViewer (I2-1): both pages read the intake through it", () => {
  it("clin.view_intake (with or without the status key): the whole row from the table, no projection call", async () => {
    for (const canViewStatus of [true, false]) {
      tableReads.length = 0;
      const r = await loadIntakeForViewer(db, "s", "c1", { canViewIntake: true, canViewStatus });
      expect(r.kind === "ok" && r.value.mode === "detail" && r.value.intake?.status).toBe("submitted");
      expect(tableReads).toEqual(["c1"]);
    }
    expect(rpcCalls).toEqual([]);
  });
  it("clin.view_intake_status ONLY: the status and the date from the projection; the table is NOT read and no answers come back", async () => {
    const r = await loadIntakeForViewer(db, "s", "c1", { canViewIntake: false, canViewStatus: true });
    expect(r).toEqual({ kind: "ok", value: { mode: "status", summary: { status: "submitted", createdAt: "2030-01-01T00:00:00Z" } } });
    expect(tableReads).toEqual([]);
    expect(rpcCalls).toEqual([{ p_studio_id: "s", p_client_ids: ["c1"] }]);
    expect(JSON.stringify(r)).not.toContain("responses");
  });
  it("status only and the projection finds none: summary null (a true 'no intake' for an authorized reader)", async () => {
    projection = [];
    expect(await loadIntakeForViewer(db, "s", "c1", { canViewIntake: false, canViewStatus: true })).toEqual({ kind: "ok", value: { mode: "status", summary: null } });
  });
  it("NEITHER key: restricted, and nothing is read at all", async () => {
    expect(await loadIntakeForViewer(db, "s", "c1", { canViewIntake: false, canViewStatus: false })).toEqual({ kind: "restricted" });
    expect(tableReads).toEqual([]);
    expect(rpcCalls).toEqual([]);
  });
  it("a failed projection read throws a fixed message (never an empty result)", async () => {
    const bad = { rpc: () => ({ range: async () => ({ data: null, error: { message: "secret detail" } }) }) };
    await expect(loadIntakeForViewer(bad, "s", "c1", { canViewIntake: false, canViewStatus: true })).rejects.toThrow(/^Failed to load intake status$/);
  });
});

describe("source pins: the two pages (status-only, neither, both)", () => {
  const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const client = strip(readFileSync("app/(app)/clients/[id]/page.tsx", "utf8"));
  const cal = strip(readFileSync("app/(app)/calendar/[id]/page.tsx", "utf8"));
  it("neither page reads the intake table (or getLatestIntakeForClient) directly", () => {
    for (const code of [client, cal]) {
      expect(code).not.toMatch(/getLatestIntakeForClient\(/);
      expect(code).not.toMatch(/from\(\s*["']client_intake_forms["']\s*\)/);
      expect(code).toMatch(/loadIntakeForViewer\(/);
    }
  });
  it("both pages ask BOTH keys (a swapped key fails)", () => {
    expect(client).toMatch(/"clin\.view_intake_status"/);
    expect(client).toMatch(/"clin\.view_intake"/);
    expect(cal).toMatch(/"clin\.view_intake_status"/);
    expect(cal).toMatch(/"clin\.view_intake"/);
  });
  it("restricted renders RestrictedNote on both pages; status-only has its own line; neither offers an action", () => {
    expect(client).toMatch(/intakeRestricted && <RestrictedNote testId="health-intake-not-available"/);
    expect(client).toMatch(/data-testid="health-intake-status-only"/);
    expect(client).toMatch(/\{!intake && !intakeRestricted && !intakeStatusMode && \(/); // the start-intake CTA
    expect(cal).toMatch(/if \(restricted\) return <RestrictedNote testId="briefing-intake-not-available"/);
    expect(cal).toMatch(/data-testid="briefing-intake-status-only"/);
  });
  it("the profile's portal tasks card is told when intake is restricted (null, not 'no')", () => {
    expect(client).toMatch(/computePortalPendingTasks\(\{[\s\S]{0,200}intakeRestricted,/);
  });
});
