import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const WHO = vi.hoisted(() => ({ role: "owner" as string }));
const RPC = vi.hoisted(() => ({ calls: [] as Array<{ fn: string; args?: Record<string, unknown> }>, choices: [] as unknown[] }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/queries", () => ({ requirePractitionerWithStudio: async () => ({ practitioner: { role: WHO.role }, studio: { id: "studio-1" } }) }));
vi.mock("@/lib/machines/studio-machine-rpc", () => ({
  studioMachineRpc: async (fn: string, args?: Record<string, unknown>) => {
    RPC.calls.push({ fn, args });
    return fn === "get_studio_machine_choices" ? { data: RPC.choices, error: null } : { data: "changed", error: null };
  },
}));

const actions = await import("@/app/(app)/settings/machines/studio-machine-actions");
const PUR = "dectro-apilus:xcell-pur";

beforeEach(() => {
  WHO.role = "owner";
  RPC.calls = [];
  RPC.choices = [{ studio_id: "studio-1", profile_id: PUR, enabled: true, is_default: true }];
});

describe("the studio machine server actions (module scope: nothing captured from a render)", () => {
  it("an owner's change goes to the command for the SESSION's studio and returns the fresh state", async () => {
    const out = await actions.setStudioMachineModelAction(PUR, false);
    expect(RPC.calls[0]).toEqual({ fn: "set_studio_machine_model", args: { p_studio: "studio-1", p_profile: PUR, p_enabled: false } });
    expect(out).toMatchObject({ ok: true });
    const d = await actions.setStudioMachineDefaultAction(null);
    expect(RPC.calls.find((c) => c.fn === "set_studio_machine_default")?.args).toEqual({ p_studio: "studio-1", p_profile: null, p_ask: true });
    expect(d).toMatchObject({ ok: true });
  });
  it("a non-owner is refused before any command runs", async () => {
    WHO.role = "practitioner";
    expect(await actions.setStudioMachineModelAction(PUR, false)).toEqual({ ok: false, error: "Only studio owners can change machines." });
    expect(await actions.setStudioMachineDefaultAction(PUR)).toMatchObject({ ok: false });
    expect(RPC.calls).toEqual([]);
  });
  it("the page passes these module-scope actions and defines no inline server action that closes over render-local functions", () => {
    const page = readFileSync("app/(app)/settings/machines/page.tsx", "utf8");
    expect(page).toContain("setModel={setStudioMachineModelAction}");
    expect(page).toContain("setDefault={setStudioMachineDefaultAction}");
    expect(page).not.toMatch(/function afterWrite|function setModel|function setDefault/);
    // the only inline action left (register) takes its two fields and captures nothing local
    expect((page.match(/"use server"/g) ?? []).length).toBe(1);
    const src = readFileSync("app/(app)/settings/machines/studio-machine-actions.ts", "utf8");
    expect(src.startsWith('"use server";')).toBe(true);
    expect(src.match(/^export (?!async function)/gm)).toBeNull();
  });
});
