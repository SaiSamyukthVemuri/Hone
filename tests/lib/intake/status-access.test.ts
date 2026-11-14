import { readFileSync } from "node:fs";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";

const asked: string[] = [];
let held = new Set<string>();
vi.mock("@/lib/permissions/require-permission", () => ({
  requirePermission: vi.fn(async (_db: unknown, _studio: string, key: string) => { asked.push(key); return { allowed: held.has(key), mode: "enforce", engine: true }; }),
}));
import { canReadIntakeStatus } from "@/lib/intake/status-access";
import { getMissingRecordsAssistant } from "@/lib/dashboard/missing-records-assistant";

beforeEach(() => { asked.length = 0; held = new Set(); });

describe("canReadIntakeStatus: owner, status key or answers key; nobody else", () => {
  it("truth table", async () => {
    expect(await canReadIntakeStatus({} as never, "s", true)).toBe(true);
    expect(asked).toEqual([]); // the owner spends no permission call
    held = new Set(["clin.view_intake_status"]);
    expect(await canReadIntakeStatus({} as never, "s", false)).toBe(true);
    held = new Set(["clin.view_intake"]);
    expect(await canReadIntakeStatus({} as never, "s", false)).toBe(true);
    held = new Set(["clin.view_records", "clin.view_photos"]);
    expect(await canReadIntakeStatus({} as never, "s", false)).toBe(false);
  });
  it("asks exactly the two intake keys (a swapped key fails)", async () => {
    await canReadIntakeStatus({} as never, "s", false);
    expect([...asked].sort()).toEqual(["clin.view_intake", "clin.view_intake_status"]);
  });
});

// The missing-records assistant with a scripted client: records key held, intake keys per test.
const rpcCalls: string[] = [];
function client() {
  const empty = (): unknown => new Proxy({}, { get: (_t, p) => (p === "then" ? (r: (v: unknown) => unknown) => r({ data: [], error: null }) : () => empty()) });
  return { from: () => empty(), rpc: (fn: string) => { rpcCalls.push(fn); return { range: async () => ({ data: [], error: null }) }; } };
}
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => client() }));

describe("getMissingRecordsAssistant: intake part (RO-1)", () => {
  beforeEach(() => { rpcCalls.length = 0; });
  it("a viewer with clin.view_records but neither intake key gets intakeNotAvailable, and the intake status is NOT read", async () => {
    held = new Set(["clin.view_records"]);
    const r = await getMissingRecordsAssistant("s", "2026-10-24T12:00:00.000Z");
    expect(r.intakeNotAvailable).toBe(true);
    expect(r.notAvailable).toBeUndefined();
    expect(rpcCalls).toEqual([]);
  });
  it("controls: a status-key holder, and an answers-key holder, are not flagged; a viewer without clin.view_records still gets notAvailable", async () => {
    for (const k of ["clin.view_intake_status", "clin.view_intake"]) {
      held = new Set(["clin.view_records", k]);
      expect((await getMissingRecordsAssistant("s", "2026-10-24T12:00:00.000Z")).intakeNotAvailable).toBeUndefined();
    }
    held = new Set();
    expect((await getMissingRecordsAssistant("s", "2026-10-24T12:00:00.000Z")).notAvailable).toBe(true);
  });
});

describe("source pins: the dashboard surfaces use the shared gate and the one restricted display", () => {
  const code = (f: string) => ts.transpileModule(readFileSync(f, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ESNext, removeComments: true } }).outputText;
  it("Today: the loader asks canReadIntakeStatus before it reads and returns the restricted result; the row shows RestrictedNote, offers no action, and ranks neutrally", () => {
    const page = code("app/(app)/dashboard/page.tsx");
    const loader = page.slice(page.indexOf("async function loadIntakeStatusByClient"));
    expect(loader.indexOf("canReadIntakeStatus(supabase, studioId, isOwner)")).toBeGreaterThan(0);
    expect(loader.indexOf("canReadIntakeStatus(")).toBeLessThan(loader.indexOf("readIntakeStatusProjection("));
    expect(loader).toMatch(/return GATED_RESTRICTED/);
    expect(page).toMatch(/intakeLoad\.kind === "restricted"/);
    expect(page).toMatch(/intakeRestricted \? "reviewed"/); // neutral ranking: the order reveals no intake state
    expect(page).toMatch(/intakeRestricted \? null : intakeStatus/); // no review action
    // JSX is transpiled away in `page`, so the row's markup is pinned on the source text
    expect(readFileSync("app/(app)/dashboard/page.tsx", "utf8")).toMatch(/\{intakeRestricted \? <RestrictedNote testId="today-intake-not-available"[^>]*\/> : <IntakePill status=\{intakeStatus\} \/>\}/);
  });
  it("Needs attention: the follow-up assistant's intakeNotAvailable reaches intakeReviewNotAvailable", () => {
    expect(code("app/(app)/dashboard/secondary-stack.tsx")).toMatch(/intakeReviewNotAvailable: intakesRestricted \|\| followUpAssistant\.intakeNotAvailable === true/);
  });
  it("the assistant reads the projection only after the gate", () => {
    const f = code("lib/dashboard/missing-records-assistant.ts");
    expect(f.indexOf("canReadIntakeStatus(")).toBeGreaterThan(0);
    expect(f).toMatch(/intakeAllowed && scanClientIds\.length > 0/);
    expect(f).toMatch(/intakeAllowed \? built : \{ \.\.\.built, intakeNotAvailable: true \}/);
  });
});
