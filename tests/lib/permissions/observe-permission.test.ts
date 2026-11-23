import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import {
  OBSERVED_KEY_CONTEXT,
  OBSERVE_TIMEOUT_MS,
  isEngineAbsent,
  observePermission,
  resetEngineAbsentNotice,
  type ObserveDb,
  type ObservedPermission,
} from "@/lib/permissions/observe-permission";

const STUDIO = "5f0c1a2e-1111-4222-8333-444455556666";
const APPT = "8a0c1a2e-1111-4222-8333-444455556666";
const PRAC = "9b0c1a2e-1111-4222-8333-444455556666";

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetEngineAbsentNotice();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const dbReturning = (result: { data: unknown; error: unknown }): ObserveDb & { rpc: ReturnType<typeof vi.fn> } => ({
  rpc: vi.fn(() => Promise.resolve(result)),
});
const logged = () => warn.mock.calls.map((c) => String(c[0]));
const book: ObservedPermission = { key: "appt.book", practitionerId: PRAC };

describe("observePermission is observe-only by construction", () => {
  it("returns nothing for every engine answer, so no caller can branch on it", async () => {
    for (const result of [
      { data: true, error: null },
      { data: false, error: null },
      { data: null, error: null },
      { data: "yes", error: null },
      { data: null, error: { code: "42501", message: "permission denied" } },
      { data: null, error: { code: "PGRST202", message: "not found" } },
    ]) {
      await expect(observePermission(dbReturning(result), STUDIO, "practitioner", book)).resolves.toBeUndefined();
    }
  });

  it("never throws: a throwing rpc, a rejecting rpc and a client with no rpc at all", async () => {
    const throwing: ObserveDb = { rpc: () => { throw new Error("boom"); } };
    const rejecting: ObserveDb = { rpc: () => Promise.reject(new Error("boom")) };
    const noRpc = {} as unknown as ObserveDb;
    for (const db of [throwing, rejecting, noRpc]) {
      await expect(observePermission(db, STUDIO, "owner", book)).resolves.toBeUndefined();
    }
    expect(logged().every((l) => l.includes('"outcome":"unreadable"'))).toBe(true);
  });

  it("stays silent when the engine allows", async () => {
    await observePermission(dbReturning({ data: true, error: null }), STUDIO, "owner", book);
    expect(warn).not.toHaveBeenCalled();
  });

  it("records would_deny for false, and unreadable for null, a non-boolean, a non-absent error and a partial apply", async () => {
    const cases: Array<[{ data: unknown; error: unknown }, string]> = [
      [{ data: false, error: null }, "would_deny"],
      [{ data: null, error: null }, "unreadable"],
      [{ data: "true", error: null }, "unreadable"],
      [{ data: null, error: { code: "42501", message: "permission denied for function" } }, "unreadable"],
      [{ data: null, error: { code: "42883", message: "function public.perm_actor(uuid) does not exist" } }, "unreadable"],
    ];
    for (const [result, outcome] of cases) {
      warn.mockClear();
      await observePermission(dbReturning(result), STUDIO, "practitioner", book);
      expect(logged()[0], JSON.stringify(result)).toContain(`"outcome":"${outcome}"`);
    }
  });

  it("notes an absent engine once per process, not per request", async () => {
    const absent = { data: null, error: { code: "PGRST202", message: "Could not find the function public.has_studio_permission" } };
    await observePermission(dbReturning(absent), STUDIO, "owner", book);
    await observePermission(dbReturning(absent), STUDIO, "owner", book);
    expect(logged()).toHaveLength(1);
    expect(logged()[0]).toContain('"outcome":"engine_absent"');
  });

  it("gives up after the timeout and records unreadable, without waiting on a stuck engine", async () => {
    vi.useFakeTimers();
    const stuck: ObserveDb = { rpc: () => new Promise(() => {}) };
    const pending = observePermission(stuck, STUDIO, "practitioner", book);
    await vi.advanceTimersByTimeAsync(OBSERVE_TIMEOUT_MS);
    await expect(pending).resolves.toBeUndefined();
    expect(logged()[0]).toContain('"outcome":"unreadable"');
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears its timer on a normal answer", async () => {
    vi.useFakeTimers();
    await observePermission(dbReturning({ data: true, error: null }), STUDIO, "owner", book);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("the call shape each key needs", () => {
  const cases: Array<[ObservedPermission, Record<string, unknown>]> = [
    [{ key: "appt.book", practitionerId: PRAC }, { p_appointment: null, p_practitioner: PRAC }],
    [{ key: "appt.move", appointmentId: APPT }, { p_appointment: APPT, p_practitioner: null }],
    [{ key: "appt.reassign" }, { p_appointment: null, p_practitioner: null }],
  ];
  it.each(cases)("%j asks has_studio_permission with exactly its own-scope context", async (ask, context) => {
    const db = dbReturning({ data: true, error: null });
    await observePermission(db, STUDIO, "practitioner", ask);
    expect(db.rpc).toHaveBeenCalledTimes(1);
    expect(db.rpc).toHaveBeenCalledWith("has_studio_permission", { p_studio: STUDIO, p_key: ask.key, p_client: null, ...context });
  });

  it("the documented context table covers exactly the observed keys", () => {
    expect(Object.keys(OBSERVED_KEY_CONTEXT).sort()).toEqual(cases.map(([a]) => a.key).sort());
  });
});

describe("what reaches the logs", () => {
  it("carries the key, outcome and role, and no studio, appointment or practitioner id", async () => {
    await observePermission(dbReturning({ data: false, error: null }), STUDIO, "practitioner", { key: "appt.move", appointmentId: APPT });
    const line = logged()[0];
    expect(line).toContain('"key":"appt.move"');
    expect(line).toContain('"actorRole":"practitioner"');
    for (const id of [STUDIO, APPT, PRAC]) expect(line).not.toContain(id);
  });
});

describe("isEngineAbsent", () => {
  it("counts only a missing has_studio_permission", () => {
    expect(isEngineAbsent({ code: "PGRST202" })).toBe(true);
    expect(isEngineAbsent({ code: "42883", message: "function public.has_studio_permission(uuid, text) does not exist" })).toBe(true);
    expect(isEngineAbsent({ code: "42883", message: "function public.perm_actor(uuid) does not exist" })).toBe(false);
    expect(isEngineAbsent({ code: "42501", message: "permission denied" })).toBe(false);
    expect(isEngineAbsent(null)).toBe(false);
    expect(isEngineAbsent("nope")).toBe(false);
  });
});

// The statement-only rule, resolved with the TypeScript parser rather than by spelling: every call to
// observePermission anywhere in app/ or lib/ must be an `await` expression statement, so its result (nothing)
// cannot feed a branch, and the engine cannot become a decision by accident.
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

describe("every call site is statement-only", () => {
  const root = process.cwd();
  const sites: Array<{ file: string; ok: boolean }> = [];
  for (const file of [...sourceFiles(join(root, "app")), ...sourceFiles(join(root, "lib"))]) {
    if (file.endsWith("lib/permissions/observe-permission.ts")) continue;
    const text = readFileSync(file, "utf8");
    if (!text.includes("observePermission")) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "observePermission") {
        const parent = node.parent;
        const awaited = ts.isAwaitExpression(parent) && ts.isExpressionStatement(parent.parent);
        sites.push({ file: file.slice(root.length + 1), ok: awaited });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  it("finds the known call sites (the check is not vacuous)", () => {
    const files = new Set(sites.map((s) => s.file));
    expect(files.has("app/(app)/calendar/actions.ts")).toBe(true);
    expect(files.has("app/(app)/calendar/move-appointment-actions.ts")).toBe(true);
    expect(sites.length).toBeGreaterThanOrEqual(3);
  });

  it("uses no result: each call is `await observePermission(...);` on its own", () => {
    expect(sites.filter((s) => !s.ok)).toEqual([]);
  });
});
