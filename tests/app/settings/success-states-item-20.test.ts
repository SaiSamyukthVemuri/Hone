// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// HON-124 item 20: a save is confirmed only AFTER the server returned ok, and the confirmation names what happened. A refusal is a returned sentence.
const state = { role: "owner" as "owner" | "practitioner", writes: 0, dbError: null as null | { code: string; message: string } };
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(), useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/supabase/queries", () => ({ getCurrentPractitionerWithStudio: async () => ({ practitioner: { id: "p1", role: state.role }, studio: { id: "s1" } }) }));
const q: Record<string, unknown> = {};
for (const k of ["select", "eq", "order", "limit", "not", "is"]) q[k] = () => q;
for (const k of ["insert", "update"]) q[k] = () => { state.writes += 1; return q; };
q.maybeSingle = async () => ({ data: { sort_order: 10 }, error: null });
(q as { then: unknown }).then = (res: (v: unknown) => void) => res({ error: state.dbError, data: null });
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from: () => q, rpc: async () => { state.writes += 1; return { data: null, error: state.dbError }; } }) }));

import { createServiceAction, updateServiceAction, toggleServiceActiveAction } from "@/app/(app)/settings/services/actions";

const form = (e: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(e)) f.set(k, v); return f; };
const RAW = /Error:|PGRST|42501|violates|Failed to |omitted in production/i;
const sentence = (r: unknown) => { expect(r).toMatchObject({ ok: false }); const e = (r as { error: string }).error; expect(e).not.toMatch(RAW); return e; };
beforeEach(() => { state.role = "owner"; state.writes = 0; state.dbError = null; vi.spyOn(console, "error").mockImplementation(() => {}); });

describe("services: every refusal is a returned sentence, and a refusal writes nothing", () => {
  it("validation and the owner gate", async () => {
    expect(sentence(await createServiceAction(form({ name: "", default_duration_minutes: "30" })))).toBe("Enter the service name, then save again.");
    expect(sentence(await createServiceAction(form({ name: "Cut", default_duration_minutes: "2" })))).toMatch(/between 5 and 480 minutes/);
    expect(sentence(await createServiceAction(form({ name: "Cut", default_duration_minutes: "30", calendar_color: "rose-neon" })))).toMatch(/calendar colour/);
    expect(sentence(await updateServiceAction(form({ name: "Cut", default_duration_minutes: "30" })))).toMatch(/Reload/);
    expect(state.writes).toBe(0);
    state.role = "practitioner";
    expect(sentence(await createServiceAction(form({ name: "Cut", default_duration_minutes: "30" })))).toBe("Only the studio owner can change services.");
    expect(sentence(await updateServiceAction(form({ id: "x", name: "Cut", default_duration_minutes: "30" })))).toMatch(/studio owner/);
    expect(sentence(await toggleServiceActiveAction(form({ id: "x", active: "false" })))).toMatch(/studio owner/);
    expect(state.writes).toBe(0);
  });
  it("a database failure is a sentence without a code; success is ok", async () => {
    state.dbError = { code: "42501", message: "permission denied secret" };
    expect(sentence(await updateServiceAction(form({ id: "x", name: "Cut", default_duration_minutes: "30" })))).toMatch(/permission to save the service/);
    expect(sentence(await toggleServiceActiveAction(form({ id: "x", active: "false" })))).toMatch(/permission to hide the service/);
    state.dbError = null;
    expect(await updateServiceAction(form({ id: "x", name: "Cut", default_duration_minutes: "30" }))).toEqual({ ok: true });
    expect(await createServiceAction(form({ name: "Cut", default_duration_minutes: "30" }))).toEqual({ ok: true });
    expect(await toggleServiceActiveAction(form({ id: "x", active: "false" }))).toEqual({ ok: true });
  });
});

describe("the aftercare mark: failure is said, confirmation only after ok", () => {
  async function mount(result: unknown) {
    const { createElement, act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const { AftercareExplainedToggle } = await import("@/app/(app)/records/record-forms");
    const action = vi.fn(async () => { if (result instanceof Error) throw result; return result as never; });
    const host = document.createElement("div"); document.body.appendChild(host);
    await act(async () => { createRoot(host).render(createElement(AftercareExplainedToggle, { sessionId: "s1", explainedAt: null, action })); });
    await act(async () => { host.querySelector("button")!.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    return host;
  }
  it("a refused mark shows a sentence and no confirmation", async () => {
    const host = await mount({ ok: false, error: "Couldn't save this record. Please try again." });
    expect(host.querySelector('[role="alert"]')!.textContent).toMatch(/Could not update this aftercare mark/);
    expect(host.textContent).not.toMatch(/Marked:/);
  });
  it("a thrown error shows a sentence, never its text", async () => {
    const host = await mount(new Error("An error occurred in the Server Components render"));
    expect(host.querySelector('[role="alert"]')!.textContent).toMatch(/Could not update this aftercare mark/);
    expect(host.textContent).not.toContain("Server Components");
  });
  it("ok confirms after the result and names what happened", async () => {
    const host = await mount({ ok: true });
    expect(host.querySelector('[role="status"]')!.textContent).toMatch(/Marked: procedure risks explained and aftercare information provided\./);
  });
});

describe("source pins", () => {
  const read = (p: string) => readFileSync(path.resolve(__dirname, "../../..", p), "utf8");
  it("ServiceSaveForm reads the result before onSaved, and onSaved names the service", () => {
    const s = read("app/(app)/settings/services/ServiceOrderList.tsx");
    expect(s.indexOf("isActionFailure(result)")).toBeGreaterThan(0);
    expect(s.indexOf("onSaved(serviceId")).toBeGreaterThan(s.indexOf("isActionFailure(result)"));
    expect(s).toContain("Added ${name} to your booking menu.");
    expect(s).toContain("Saved changes to ${name}.");
    expect(s).not.toMatch(/\b(?:e|err|error)\.message\b/);
  });
  it("the settings forms confirm with a sentence that names what was saved, after the ok check", () => {
    for (const [f, text] of [
      ["app/(app)/settings/studio/StudioSettingsForm.tsx", "Studio details saved."],
      ["app/(app)/settings/studio/PolicySettingsForm.tsx", "Cancellation and no-show policy saved."],
      ["app/(app)/settings/studio/PostcareSettingsForm.tsx", "Postcare settings saved."],
      ["app/(app)/settings/calendar/StudioDisplayPreferencesForm.tsx", "Calendar display preferences saved."],
      ["app/(app)/settings/studio/EmailSettingsForm.tsx", "Email settings saved."],
      ["app/(app)/settings/studio/SmsSettingsForm.tsx", "Text message settings saved."],
      ["app/(app)/settings/studio/ClientSelfServiceForm.tsx", "Client self-service settings saved."],
      ["app/(app)/settings/profile/ColorPicker.tsx", "Calendar colour saved."],
    ] as const) expect(read(f), f).toContain(text);
  });
  it("no settings form still shows a bare Saved", () => {
    for (const f of ["EmailSettingsForm", "SmsSettingsForm", "ClientSelfServiceForm"]) expect(read(`app/(app)/settings/studio/${f}.tsx`)).not.toMatch(/setHint\("Saved"\)/);
  });
});
