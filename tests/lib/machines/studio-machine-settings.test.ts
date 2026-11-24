import { describe, expect, it } from "vitest";
import { readStudioMachineSettings, setStudioMachineDefault, setStudioMachineModel } from "../../../lib/machines/studio-machine-settings";

const S = "11111111-1111-4111-8111-111111111111";
const PUR = "dectro-apilus:xcell-pur";
const SEN = "dectro-apilus:senior-3g";
const ok = (data: unknown) => async () => ({ data, error: null });

describe("reading the switches", () => {
  it("lists this studio's enabled models in the fixed order and the default; another studio's rows never count", async () => {
    const r = await readStudioMachineSettings(S, ok([
      { studio_id: S, profile_id: SEN, is_default: false },
      { studio_id: S, profile_id: PUR, is_default: true },
      { studio_id: "other", profile_id: "dectro-apilus:junior-3g", is_default: true },
    ]));
    expect(r).toEqual({ enabled: [PUR, SEN], defaultProfileId: PUR });
  });
  it("no default row means null (ask at each visit); an unknown profile id is ignored", async () => {
    expect(await readStudioMachineSettings(S, ok([{ studio_id: S, profile_id: SEN, is_default: false }, { studio_id: S, profile_id: "x", is_default: true }]))).toEqual({ enabled: [SEN], defaultProfileId: null });
  });
  it("a failed, thrown or malformed read is null, never an empty 'nothing enabled'", async () => {
    expect(await readStudioMachineSettings(S, async () => ({ data: null, error: { message: "x" } }))).toBeNull();
    expect(await readStudioMachineSettings(S, async () => { throw new Error("down"); })).toBeNull();
    expect(await readStudioMachineSettings(S, ok({}))).toBeNull();
  });
});

describe("writing the switches", () => {
  it("sends exactly the command arguments, with ask true only for a null default", async () => {
    const calls: unknown[] = [];
    const rpc = async (fn: string, args?: Record<string, unknown>) => { calls.push([fn, args]); return { data: "changed", error: null }; };
    expect(await setStudioMachineModel(S, SEN, true, rpc)).toEqual({ ok: true });
    expect(await setStudioMachineDefault(S, null, rpc)).toEqual({ ok: true });
    expect(await setStudioMachineDefault(S, PUR, rpc)).toEqual({ ok: true });
    expect(calls).toEqual([
      ["set_studio_machine_model", { p_studio: S, p_profile: SEN, p_enabled: true }],
      ["set_studio_machine_default", { p_studio: S, p_profile: null, p_ask: true }],
      ["set_studio_machine_default", { p_studio: S, p_profile: PUR, p_ask: false }],
    ]);
  });
  it("an unknown model is refused without a call; a database refusal gives one generic message that leaks nothing", async () => {
    let n = 0;
    const rpc = async () => { n++; return { data: null, error: { message: "Not available.", code: "42501" } }; };
    expect(await setStudioMachineModel(S, "evil", true, rpc)).toMatchObject({ ok: false });
    expect(n).toBe(0);
    const r = await setStudioMachineModel(S, PUR, false, rpc);
    expect(r).toEqual({ ok: false, error: "Your machine settings could not be saved. Nothing was changed." });
    const t = await setStudioMachineDefault(S, PUR, async () => { throw new Error("db password"); });
    expect(JSON.stringify(t)).not.toMatch(/password/);
  });
});
