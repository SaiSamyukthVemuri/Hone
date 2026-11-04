import { EDIT_RECORDS_REFUSAL } from "@/lib/permissions/refusal-copy";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Roles (NQ-11/12): starting a session creates a chart, so startSessionAction asks clin.edit_records before any read or write. A refusal
// touches nothing: no appointment lookup, no command, no redirect.

const rt = vi.hoisted(() => ({ allowed: true, from: vi.fn(), rpc: vi.fn(), asked: [] as string[] }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`REDIRECT:${url}`); } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from: rt.from, rpc: rt.rpc }) }));
vi.mock("@/lib/supabase/queries", () => ({ getCurrentPractitionerWithStudio: async () => ({ practitioner: { id: "p" }, studio: { id: "s" } }) }));
vi.mock("@/lib/permissions/require-permission", () => ({
  requirePermission: async (_db: unknown, _studio: string, key: string) => { rt.asked.push(key); return { allowed: rt.allowed }; },
}));
vi.mock("@/lib/analytics/server", () => ({ captureServerEvent: vi.fn() }));
vi.mock("@/lib/observability/perf-timing", () => ({ timed: async (_n: string, fn: () => unknown) => fn(), startPerfSpan: () => ({ end: vi.fn() }) }));

import { startSessionAction } from "@/app/(app)/clients/[id]/sessions/new/actions";

const form = () => { const f = new FormData(); f.set("client_id", "c1"); f.set("modality", "electrolysis"); return f; };

describe("startSessionAction asks the edit key first", () => {
  beforeEach(() => { rt.allowed = true; rt.asked.length = 0; rt.from.mockReset(); rt.rpc.mockReset(); });
  it("refuses with edit off, before any read, write or redirect", async () => {
    rt.allowed = false;
    await expect(startSessionAction(form())).rejects.toThrow(EDIT_RECORDS_REFUSAL);
    expect(rt.asked).toEqual(["clin.edit_records"]);
    expect(rt.from).not.toHaveBeenCalled();
    expect(rt.rpc).not.toHaveBeenCalled();
  });
  it("asks for the client being charted", async () => {
    rt.allowed = false;
    await expect(startSessionAction(form())).rejects.toBeTruthy();
    expect(rt.asked).toHaveLength(1);
  });
});
