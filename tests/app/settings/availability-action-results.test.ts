import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// HON-124 item 19 (PR-2): the five availability actions behind AvailabilityClient RETURN a sentence instead of throwing (production redacts a
// thrown message). A refusal writes nothing, no database text or code reaches the sentence, and the client keeps the typed input.
const scenario = { role: "owner" as "owner" | "practitioner", rpc: "ok" as string | null, rpcError: null as null | { code: string; message: string }, deleteError: null as null | { code: string; message: string } };
const rpcCalls: string[] = [];
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({ practitioner: { id: "p1", role: scenario.role, active: true }, studio: { id: "s1", timezone: "UTC" } }),
}));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({ rpc: async (name: string) => { rpcCalls.push(name); return { data: scenario.rpc, error: scenario.rpcError }; } }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: () => ({ delete: () => ({ eq: () => ({ eq: async () => ({ error: scenario.deleteError }) }) }) }) }),
}));

import { deleteBlockoutAction, deleteOverrideAction, saveWeeklyDefaultsAction, upsertDayDefaultAction, upsertOverrideAction } from "@/app/(app)/settings/availability/actions";

const form = (e: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(e)) f.set(k, v); return f; };
const week = (over: Record<string, string> = {}) => form({ ...Object.fromEntries([0, 1, 2, 3, 4, 5, 6].flatMap((d) => [[`is_open_${d}`, "true"], [`open_time_${d}`, "09:00"], [`close_time_${d}`, "17:00"]])), ...over });
beforeEach(() => { scenario.role = "owner"; scenario.rpc = "ok"; scenario.rpcError = null; scenario.deleteError = null; rpcCalls.length = 0; vi.spyOn(console, "error").mockImplementation(() => {}); });
const RAW = /Error:|PGRST|42501|23505|violates|rpc|admin|upsert_availability/i;
const fail = (r: unknown) => { expect(r).toMatchObject({ ok: false }); const e = (r as { error: string }).error; expect(e.length).toBeGreaterThan(10); expect(e).not.toMatch(RAW); return e; };

describe("a non-owner is refused with a sentence, and nothing is written", () => {
  it.each([
    ["upsertDayDefaultAction", () => upsertDayDefaultAction(form({ day_of_week: "1", is_open: "false" }))],
    ["saveWeeklyDefaultsAction", () => saveWeeklyDefaultsAction(week())],
    ["upsertOverrideAction", () => upsertOverrideAction(form({ effective_date: "2027-01-05", is_open: "false" }))],
    ["deleteOverrideAction", () => deleteOverrideAction(form({ id: "o1" }))],
    ["deleteBlockoutAction", () => deleteBlockoutAction(form({ id: "b1" }))],
  ])("%s", async (_n, run) => {
    scenario.role = "practitioner";
    expect(fail(await run())).toMatch(/studio owner/);
    expect(rpcCalls).toHaveLength(0);
  });
});

describe("validation names the fix and writes nothing", () => {
  it("day: open without times, bad format, close before open, bad weekday", async () => {
    expect(fail(await upsertDayDefaultAction(form({ day_of_week: "1", is_open: "true" })))).toMatch(/opening and a closing time/);
    expect(fail(await upsertDayDefaultAction(form({ day_of_week: "1", is_open: "true", open_time: "9am", close_time: "17:00" })))).toMatch(/09:00/);
    expect(fail(await upsertDayDefaultAction(form({ day_of_week: "1", is_open: "true", open_time: "17:00", close_time: "09:00" })))).toMatch(/after the opening/);
    expect(fail(await upsertDayDefaultAction(form({ day_of_week: "9", is_open: "false" })))).toMatch(/day of the week/);
    expect(rpcCalls).toHaveLength(0);
  });
  it("week and override", async () => {
    expect(fail(await saveWeeklyDefaultsAction(week({ close_time_2: "08:00" })))).toMatch(/after the opening/);
    expect(fail(await upsertOverrideAction(form({ is_open: "false" })))).toMatch(/Choose the date/);
    expect(fail(await upsertOverrideAction(form({ effective_date: "2027-01-05", is_open: "true", open_time: "10:00" })))).toMatch(/opening and a closing/);
    expect(rpcCalls).toHaveLength(0);
  });
  it("delete without an id", async () => {
    expect(fail(await deleteOverrideAction(form({})))).toMatch(/Reload the page/);
    expect(fail(await deleteBlockoutAction(form({})))).toMatch(/Reload the page/);
  });
});

describe("a failed write is a sentence with the next step and no database text", () => {
  it("rpc error, rpc non-ok result, delete error", async () => {
    scenario.rpcError = { code: "42501", message: "permission denied for function upsert_availability_day_locked" };
    expect(fail(await upsertDayDefaultAction(form({ day_of_week: "1", is_open: "false" })))).toMatch(/Try again/);
    expect(fail(await saveWeeklyDefaultsAction(week()))).toMatch(/contact support/);
    expect(fail(await upsertOverrideAction(form({ effective_date: "2027-01-05", is_open: "false" })))).toMatch(/Try again/);
    expect(fail(await deleteOverrideAction(form({ id: "o1" })))).toMatch(/Try again/);
    scenario.rpcError = null; scenario.rpc = "capacity_conflict";
    expect(fail(await saveWeeklyDefaultsAction(week()))).toMatch(/Try again/);
    scenario.deleteError = { code: "23505", message: "violates foreign key studio_blockouts_x_fkey" };
    expect(fail(await deleteBlockoutAction(form({ id: "b1" })))).toMatch(/Try again/);
  });
  it("success returns ok", async () => {
    expect(await upsertDayDefaultAction(form({ day_of_week: "1", is_open: "false" }))).toEqual({ ok: true });
    expect(await saveWeeklyDefaultsAction(week())).toEqual({ ok: true });
    expect(await upsertOverrideAction(form({ effective_date: "2027-01-05", is_open: "false" }))).toEqual({ ok: true });
    expect(await deleteOverrideAction(form({ id: "o1" }))).toEqual({ ok: true });
    expect(await deleteBlockoutAction(form({ id: "b1" }))).toEqual({ ok: true });
  });
});

describe("the client reads the result and keeps the typed input", () => {
  const src = readFileSync(path.resolve(__dirname, "../../../app/(app)/settings/availability/AvailabilityClient.tsx"), "utf8");
  it("each call site checks result.ok and no caught error's text is shown", () => {
    for (const a of ["upsertDayDefaultAction", "saveWeeklyDefaultsAction", "upsertOverrideAction"]) {
      expect(src).toMatch(new RegExp(`const result = await ${a}\\(`));
    }
    expect(src.match(/if \(!result\.ok\)/g)?.length).toBeGreaterThanOrEqual(4);
    expect(src).not.toMatch(/\b(?:e|err|error)\.message\b/);
    expect(src).toContain("actionFailureMessage(e");
  });
  it("the editor, override form and week stay as typed on a failure (they close/clear only on success)", () => {
    const day = src.slice(src.indexOf("const result = await upsertDayDefaultAction"));
    expect(day.indexOf("closeEditor()")).toBeGreaterThan(day.indexOf("if (!result.ok)"));
    const ov = src.slice(src.indexOf("const result = await upsertOverrideAction"));
    expect(ov.indexOf("onDone()")).toBeGreaterThan(ov.indexOf("if (!result.ok)"));
    const wk = src.slice(src.indexOf("const result = await saveWeeklyDefaultsAction"));
    expect(wk.indexOf("setDays(next)")).toBeGreaterThan(wk.indexOf("if (!result.ok)"));
  });
  it("Remove (override and blockout) goes through RemoveRowForm: a pending button and an in-place alert", () => {
    expect(src).not.toMatch(/<form action=\{delete(?:Override|Blockout)Action\}>/);
    expect(src.match(/<RemoveRowForm action=\{delete(?:Override|Blockout)Action\}/g)?.length).toBe(2);
    const comp = src.slice(src.indexOf("function RemoveRowForm"));
    expect(comp).toContain("<PendingButton");
    expect(comp).toContain('role="alert"');
  });
});
