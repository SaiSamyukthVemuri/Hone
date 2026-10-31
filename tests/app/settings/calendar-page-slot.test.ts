import { beforeEach, describe, expect, it, vi } from "vitest";

// The Calendar page is owner-only until a per-practitioner slot exists
// (personal-slot.tsx, owned by WS-C). Display preferences are owner-only
// whatever the slot says.

const scenario = { role: "owner" as "owner" | "practitioner" };
const redirect = vi.fn((to: string) => {
  throw new Error(`REDIRECT:${to}`);
});
const slotState: { slot: null | { sections: []; Content: () => string } } = { slot: null };

vi.mock("next/navigation", () => ({ redirect: (to: string) => redirect(to) }));
vi.mock("@/lib/supabase/queries", () => ({
  requirePractitionerWithStudio: async () => ({
    practitioner: { role: scenario.role },
    studio: { birthday_reminder_color: "purple", time_format_preference: "12h" },
  }),
}));
vi.mock("@/app/(app)/settings/calendar/StudioDisplayPreferencesForm", () => ({
  StudioDisplayPreferencesForm: () => "DISPLAY_FORM",
}));
vi.mock("@/app/(app)/settings/calendar/personal-slot", () => ({
  get personalCalendarSlot() {
    return slotState.slot;
  },
}));

import CalendarSettingsPage from "@/app/(app)/settings/calendar/page";

const flat = (n: unknown): string => JSON.stringify(n, (_k, v) => (typeof v === "function" ? v.name || "fn" : v));

beforeEach(() => {
  scenario.role = "owner";
  slotState.slot = null;
  redirect.mockClear();
});

describe("Calendar settings page access", () => {
  it("with no slot, a practitioner is sent to Profile", async () => {
    scenario.role = "practitioner";
    await expect(CalendarSettingsPage()).rejects.toThrow("REDIRECT:/settings/profile");
  });

  it("an owner sees Display preferences labelled for the whole studio", async () => {
    const tree = flat(await CalendarSettingsPage());
    expect(tree).toContain("Applies to the whole studio.");
    expect(tree).toContain("display-preferences");
  });

  it("with a slot, a practitioner sees the slot and NOT Display preferences", async () => {
    scenario.role = "practitioner";
    slotState.slot = { sections: [], Content: () => "SLOT" };
    const tree = flat(await CalendarSettingsPage());
    expect(redirect).not.toHaveBeenCalled();
    expect(tree).not.toContain("Applies to the whole studio.");
    expect(tree).not.toContain("display-preferences");
  });

  it("with a slot, an owner sees both", async () => {
    slotState.slot = { sections: [], Content: () => "SLOT" };
    const tree = flat(await CalendarSettingsPage());
    expect(tree).toContain("display-preferences");
    expect(tree).toContain("Content");
  });
});
