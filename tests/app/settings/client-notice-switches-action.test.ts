import { beforeEach, describe, expect, it, vi } from "vitest";

// The email settings action and the two client-notice switches (0373): the owner saves each independently; a form that does not
// carry them leaves what the owner saved untouched (omission is never "off" for a switch that defaults ON); only owners may save.
// Fake database: nothing is written anywhere.

const h = vi.hoisted(() => ({
  role: "owner" as "owner" | "practitioner",
  // The studio row the action reads: after 0373 it carries both columns; before 0373 it does not.
  studioRow: { id: "s-1", send_moved_appointment_emails: true, send_client_cancellation_emails: true } as Record<string, unknown>,
  updates: [] as Array<Record<string, unknown>>,
  error: null as null | { code: string },
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({ practitioner: { id: "p-1", role: h.role }, studio: h.studioRow }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({
      update: (payload: Record<string, unknown>) => {
        h.updates.push(payload);
        return { eq: async () => ({ error: h.error }) };
      },
    }),
  }),
}));

import { setStudioEmailSettingsAction } from "@/app/(app)/settings/studio/actions";

const MOVED = "send_moved_appointment_emails";
const CANCEL = "send_client_cancellation_emails";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  h.role = "owner";
  h.studioRow = { id: "s-1", send_moved_appointment_emails: true, send_client_cancellation_emails: true };
  h.updates.length = 0;
  h.error = null;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("saving the two client-notice switches", () => {
  it("each is saved on its own value, independent of the other and of booking confirmations", async () => {
    await setStudioEmailSettingsAction(form({ send_confirmation_emails: "false", [MOVED]: "true", [CANCEL]: "false" }));
    expect(h.updates[0]).toMatchObject({ send_confirmation_emails: false, [MOVED]: true, [CANCEL]: false });
    await setStudioEmailSettingsAction(form({ send_confirmation_emails: "true", [MOVED]: "false", [CANCEL]: "true" }));
    expect(h.updates[1]).toMatchObject({ send_confirmation_emails: true, [MOVED]: false, [CANCEL]: true });
  });

  it("turning booking confirmations off does not turn either notice off (the form carries their saved values)", async () => {
    await setStudioEmailSettingsAction(form({ send_confirmation_emails: "false", [MOVED]: "true", [CANCEL]: "true" }));
    expect(h.updates[0][MOVED]).toBe(true);
    expect(h.updates[0][CANCEL]).toBe(true);
  });

  it("a form that does not carry the switches (an older page, a crafted post) leaves both exactly as saved: they are not in the write", async () => {
    await setStudioEmailSettingsAction(form({ send_confirmation_emails: "false" }));
    expect(Object.keys(h.updates[0])).not.toContain(MOVED);
    expect(Object.keys(h.updates[0])).not.toContain(CANCEL);
  });

  it("only the literal true or false is a choice: anything else is ignored, never coerced", async () => {
    await setStudioEmailSettingsAction(form({ [MOVED]: "yes", [CANCEL]: "" }));
    expect(Object.keys(h.updates[0])).not.toContain(MOVED);
    expect(Object.keys(h.updates[0])).not.toContain(CANCEL);
  });

  it("before 0373 is applied (the studio row has no such columns) the other settings still save and the switches are left out", async () => {
    h.studioRow = { id: "s-1" };
    const r = await setStudioEmailSettingsAction(form({ send_confirmation_emails: "false", [MOVED]: "false", [CANCEL]: "false" }));
    expect(r).toEqual({ ok: true });
    expect(h.updates[0]).toMatchObject({ send_confirmation_emails: false });
    expect(Object.keys(h.updates[0])).not.toContain(MOVED);
    expect(Object.keys(h.updates[0])).not.toContain(CANCEL);
  });

  it("after 0373 (the studio row carries the columns) both are written", async () => {
    await setStudioEmailSettingsAction(form({ [MOVED]: "false", [CANCEL]: "true" }));
    expect(h.updates[0]).toMatchObject({ [MOVED]: false, [CANCEL]: true });
  });

  it("a member cannot save them, and nothing is written", async () => {
    h.role = "practitioner";
    const r = await setStudioEmailSettingsAction(form({ [MOVED]: "false", [CANCEL]: "false" }));
    expect(r).toMatchObject({ ok: false });
    expect(h.updates).toEqual([]);
  });

  it("a refused write is reported, with no database detail", async () => {
    h.error = { code: "XX000" };
    const r = await setStudioEmailSettingsAction(form({ [MOVED]: "false" }));
    expect(r).toEqual({ ok: false, error: "Could not save settings. Please try again." });
  });
});
