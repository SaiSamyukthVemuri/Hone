import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// SETTINGS-SMS. Owner switches for the three existing SMS columns. Synthetic ids only.

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  role: "owner" as string,
  error: null as { code?: string; message: string } | null,
  updates: [] as Array<{ patch: Record<string, unknown>; id: string }>,
  revalidated: [] as string[],
}));

vi.mock("next/cache", () => ({ revalidatePath: (p: string) => state.revalidated.push(p) }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({ practitioner: { role: state.role }, studio: { id: "studio-a" } }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({
      update: (patch: Record<string, unknown>) => ({
        eq: async (_c: string, id: string) => {
          state.updates.push({ patch, id });
          return { error: state.error };
        },
      }),
    }),
  }),
}));

import { setStudioSmsSettingsAction } from "@/app/(app)/settings/studio/sms-settings-actions";

function form(v: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, val] of Object.entries(v)) f.set(k, val);
  return f;
}
const ALL = { send_confirmation_sms: "true", send_24h_sms_reminders: "false", send_2h_sms_reminders: "true" };

beforeEach(() => {
  state.role = "owner";
  state.error = null;
  state.updates.length = 0;
  state.revalidated.length = 0;
});

describe("setStudioSmsSettingsAction", () => {
  it("an owner writes exactly the three columns, for their own studio only", async () => {
    const r = await setStudioSmsSettingsAction(form(ALL));
    expect(r).toEqual({ ok: true });
    expect(state.updates).toEqual([
      { id: "studio-a", patch: { send_confirmation_sms: true, send_24h_sms_reminders: false, send_2h_sms_reminders: true } },
    ]);
    expect(state.revalidated).toEqual(["/settings/studio"]);
  });

  it("a practitioner or receptionist cannot change it and nothing is written", async () => {
    for (const role of ["practitioner", "receptionist"]) {
      state.role = role;
      const r = await setStudioSmsSettingsAction(form(ALL));
      expect(r.ok).toBe(false);
    }
    expect(state.updates).toEqual([]);
  });

  it("a partial or malformed submission is refused, never read as false", async () => {
    for (const bad of [
      { send_confirmation_sms: "true" },
      { ...ALL, send_2h_sms_reminders: "yes" },
      { ...ALL, send_24h_sms_reminders: "" },
    ]) {
      const r = await setStudioSmsSettingsAction(form(bad));
      expect(r.ok).toBe(false);
    }
    expect(state.updates).toEqual([]);
  });

  it("a database failure returns a fixed sentence, no database text", async () => {
    state.error = { code: "XX000", message: "relation secret.table column leak@example.test" };
    const r = await setStudioSmsSettingsAction(form(ALL));
    expect(r).toEqual({ ok: false, error: "Could not save settings. Please try again." });
    expect(JSON.stringify(r)).not.toContain("leak@example.test");
  });
});

describe("cross-studio isolation (action level)", () => {
  it("a submitted studio id is ignored: the write targets only the session's studio", async () => {
    const f = form({ ...ALL, studio_id: "studio-b", id: "studio-b" });
    await setStudioSmsSettingsAction(f);
    expect(state.updates.map((u) => u.id)).toEqual(["studio-a"]);
    expect(Object.keys(state.updates[0].patch).sort()).toEqual([
      "send_24h_sms_reminders",
      "send_2h_sms_reminders",
      "send_confirmation_sms",
    ]);
  });
});

describe("both states render", () => {
  it("shows each toggle as on or off from the stored value, and nothing is pre-enabled", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { SmsSettingsForm } = await import("@/app/(app)/settings/studio/SmsSettingsForm");
    const off = renderToStaticMarkup(
      createElement(SmsSettingsForm, { initial: { send_confirmation_sms: false, send_24h_sms_reminders: false, send_2h_sms_reminders: false } }),
    );
    expect(off.match(/aria-pressed="false"/g)?.length).toBe(3);
    expect(off).not.toContain('aria-pressed="true"');
    const mixed = renderToStaticMarkup(
      createElement(SmsSettingsForm, { initial: { send_confirmation_sms: true, send_24h_sms_reminders: false, send_2h_sms_reminders: true } }),
    );
    expect(mixed.match(/aria-pressed="true"/g)?.length).toBe(2);
    expect(mixed.match(/aria-pressed="false"/g)?.length).toBe(1);
  });
});

describe("source contract", () => {
  const read = (p: string) => readFileSync(path.join(__dirname, "../../..", p), "utf8");
  it("the page renders the card with the stored values and the send gate is unchanged", () => {
    const page = read("app/(app)/settings/studio/page.tsx");
    expect(page).toContain("<SmsSettingsForm");
    for (const k of ["send_confirmation_sms", "send_24h_sms_reminders", "send_2h_sms_reminders"]) {
      expect(page).toContain(`${k}: studio.${k}`);
    }
    const gate = read("lib/sms/send-appointment.ts");
    expect(gate).toContain("client_no_consent");
    expect(gate).toContain("client_opted_out");
  });
  it("the card says texts go only to consenting clients and does not pre-enable anything", () => {
    const form = read("app/(app)/settings/studio/SmsSettingsForm.tsx");
    expect(form).toContain("agreed to receive them");
    expect(form).not.toMatch(/useState\(\{[^}]*: true/);
  });
});
