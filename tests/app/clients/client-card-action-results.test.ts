// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// HON-124 item 19 (PR-3): the client cards and the laser logging form. The actions RETURN a sentence instead of throwing (production redacts a
// thrown message); the clinical write itself is untouched: a refusal reaches no RPC/insert, a success still makes the SAME single call. The
// components keep what was typed, show only the sentence, and never print an error's own text.
const state = { role: "owner" as "owner" | "practitioner", rpcError: null as null | { code: string; message: string }, rpcCalls: [] as Array<{ name: string; args: unknown }>, inserted: 0 };
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({ practitioner: { id: "p1", role: state.role, active: true }, studio: { id: "s1" } }),
}));
const builder: Record<string, unknown> = {};
for (const k of ["select", "eq", "insert", "update", "delete", "order", "limit", "in", "is"]) builder[k] = (..._a: unknown[]) => { if (k === "insert") state.inserted += 1; return builder; };
builder.maybeSingle = async () => ({ data: { id: "c1", status: "open" }, error: null });
builder.single = async () => ({ data: { id: "n1", text: "t", created_by_practitioner_id: "p1" }, error: null });
(builder as { then: unknown }).then = (res: (v: unknown) => void) => res({ data: [], error: null });
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from: () => builder, rpc: async (name: string, args: unknown) => { state.rpcCalls.push({ name, args }); return { data: "e1", error: state.rpcError }; } }) }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => ({ from: () => builder, rpc: async () => ({ data: null, error: null }) }) }));

import { addClientPricingAction, addClientTagAction, removeClientTagAction } from "@/app/(app)/clients/[id]/actions";
import { addClientPinnedNoteAction, editClientPinnedNoteAction, removeClientPinnedNoteAction } from "@/app/(app)/clients/[id]/pinned-notes-actions";
import { addLaserEntryAction, softDeleteSessionAction, updateSessionPerformerAction } from "@/app/(app)/clients/[id]/sessions/[sessionId]/actions";

const form = (e: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(e)) f.set(k, v); return f; };
const RAW = /Error:|PGRST|42501|23505|violates|Failed to |rpc|omitted in production/i;
const sentence = (r: unknown) => { expect(r).toMatchObject({ ok: false }); const e = (r as { error: string }).error; expect(e.length).toBeGreaterThan(12); expect(e).not.toMatch(RAW); return e; };
beforeEach(() => { state.role = "owner"; state.rpcError = null; state.rpcCalls = []; state.inserted = 0; vi.spyOn(console, "error").mockImplementation(() => {}); });

describe("validation and refusals are returned sentences, and reach no write", () => {
  it("price, tag, note, laser, performer, delete", async () => {
    expect(sentence(await addClientPricingAction(form({ client_id: "c1", service_name: "", price: "10" })))).toMatch(/service name/);
    expect(sentence(await addClientPricingAction(form({ client_id: "c1", service_name: "Cut", price: "abc" })))).toMatch(/number/);
    state.role = "practitioner";
    expect(sentence(await addClientPricingAction(form({ client_id: "c1", service_name: "Cut", price: "10" })))).toMatch(/studio owner/);
    state.role = "owner";
    expect(sentence(await addClientTagAction(form({ client_id: "c1", label: " " })))).toMatch(/Enter a tag/);
    expect(sentence(await addClientTagAction(form({ client_id: "c1", label: "x".repeat(61) })))).toMatch(/60/);
    expect(sentence(await removeClientTagAction(form({ client_id: "c1" })))).toMatch(/Reload/);
    expect(sentence(await addClientPinnedNoteAction(form({ client_id: "c1", text: "" })))).toMatch(/Write the note/);
    expect(sentence(await addClientPinnedNoteAction(form({ client_id: "c1", text: "x".repeat(201) })))).toMatch(/200/);
    expect(sentence(await editClientPinnedNoteAction(form({ client_id: "c1", note_id: "n1", text: "a" })))).toMatch(/latest version/);
    state.role = "practitioner";
    expect(sentence(await removeClientPinnedNoteAction(form({ client_id: "c1", note_id: "n1" })))).toMatch(/studio owner/);
    state.role = "owner";
    expect(sentence(await addLaserEntryAction(form({ session_id: "s", client_id: "c1", zone: "" })))).toMatch(/treatment zone/);
    expect(sentence(await updateSessionPerformerAction(form({ client_id: "c1" })))).toMatch(/Reload/);
    expect(sentence(await softDeleteSessionAction(form({ session_id: "s", client_id: "c1", delete_reason: "short" })))).toMatch(/at least 10 characters/);
    expect(state.inserted).toBe(0);
    expect(state.rpcCalls).toHaveLength(0);
  });
});

describe("the clinical laser write is unchanged: a database failure is a sentence, a success is the same single call", () => {
  it("failure returns a sentence without a code; success returns ok after exactly one create_laser_entry", async () => {
    state.rpcError = { code: "42501", message: "permission denied for function create_laser_entry secret" };
    const bad = await addLaserEntryAction(form({ session_id: "s1", client_id: "c1", zone: "Upper lip", fluence: "12" }));
    expect(sentence(bad)).toMatch(/permission to add the entry/);
    expect(state.rpcCalls.filter((c) => c.name === "create_laser_entry")).toHaveLength(1);
    state.rpcError = null; state.rpcCalls = [];
    expect(await addLaserEntryAction(form({ session_id: "s1", client_id: "c1", zone: "Upper lip", fluence: "12" }))).toEqual({ ok: true });
    const calls = state.rpcCalls.filter((c) => c.name === "create_laser_entry");
    expect(calls).toHaveLength(1);
    expect((calls[0].args as { p_equipment_params: unknown }).p_equipment_params).toEqual({ fluence: "12" });
  });
});

describe("the components show only the sentence and keep what was typed", () => {
  it("AddPricingForm: a returned failure shows its sentence and the typed values stay; a throw shows the fixed fallback, never its text", async () => {
    const { createElement, act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const { AddPricingForm } = await import("@/components/add-pricing-form");
    const next: { v: unknown } = { v: { ok: false, error: "Only the studio owner can change prices." } };
    const action = vi.fn(async () => { if (next.v instanceof Error) throw next.v; return next.v as never; });
    const host = document.createElement("div"); document.body.appendChild(host);
    await act(async () => { createRoot(host).render(createElement(AddPricingForm, { clientId: "c1", action })); });
    const set = (el: HTMLInputElement, v: string) => { const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!; d.set!.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); };
    const inputs = host.querySelectorAll("input");
    await act(async () => { set(inputs[0] as HTMLInputElement, "Haircut"); set(inputs[1] as HTMLInputElement, "40"); });
    const submit = async () => { await act(async () => { host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }); await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); };
    await submit();
    expect(host.textContent).toContain("Only the studio owner can change prices.");
    expect((host.querySelectorAll("input")[0] as HTMLInputElement).value).toBe("Haircut");
    next.v = new Error("Failed to add pricing: 42501");
    await submit();
    expect(host.textContent).toContain("Could not add the price.");
    expect(host.textContent).not.toMatch(/42501|Failed to add pricing/);
    host.remove();
  });
});

describe("source pins: every converted component reads result.ok before it clears anything", () => {
  const read = (p: string) => readFileSync(path.resolve(__dirname, "../../..", p), "utf8");
  it.each([
    ["components/add-pricing-form.tsx", 'setService("")'],
    ["components/client-tags-card.tsx", 'setLabel("")'],
    ["components/client-pinned-notes-card.tsx", 'setText("")'],
    ["components/log-laser-entry-form.tsx", "setState(emptyState())"],
    ["components/session-performer-line.tsx", 'setState("saved")'],
  ])("%s", (file, clears) => {
    const s = read(file);
    expect(s).toContain("if (!result.ok)");
    expect(s.indexOf(clears)).toBeGreaterThan(s.indexOf("if (!result.ok)"));
    expect(s).not.toMatch(/\b(?:e|err|error)\.message\b/);
    expect(s).toContain("actionFailureMessage(");
  });
  it("DeleteSessionForm keeps the typed reason, treats a redirect as success, and prints no error text", () => {
    const s = read("app/(app)/clients/[id]/sessions/[sessionId]/DeleteSessionForm.tsx");
    expect(s).toContain("if (!result.ok)");
    expect(s).toContain("NEXT_REDIRECT");
    expect(s).not.toMatch(/\b(?:e|err|error)\.message\b/);
    expect(s).not.toContain('setReason("")\n      }'); // the reason is cleared only by Cancel
  });
});
