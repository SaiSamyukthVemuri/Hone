import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Settings redesign D1: the studio-wide display preferences (birthday colour,
// time format) are written by their own OWNER-ONLY action, and the studio-details
// action no longer reads or writes them.

const scenario = { role: "owner" as "owner" | "practitioner" };
type Update = { table: string; values: Record<string, unknown>; id: unknown };
const updates: Update[] = [];
let failTimeFormat: null | { code?: string; message: string } = null;

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({
    practitioner: { role: scenario.role },
    studio: { id: "studio-1" },
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => ({
      update: (values: Record<string, unknown>) => ({
        eq: async (_col: string, id: unknown) => {
          updates.push({ table, values, id });
          if ("time_format_preference" in values && failTimeFormat) {
            return { error: failTimeFormat };
          }
          return { error: null };
        },
      }),
    }),
  }),
}));
vi.mock("@/lib/booking/client-self-service-form", () => ({ parseClientSelfServiceForm: vi.fn() }));

import {
  updateStudioAction,
  updateStudioDisplayPreferencesAction,
} from "@/app/(app)/settings/studio/actions";

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  scenario.role = "owner";
  updates.length = 0;
  failTimeFormat = null;
});

describe("updateStudioAction (studio details)", () => {
  it("a studio-details save leaves non-default time format and birthday colour untouched", async () => {
    // The form no longer sends them, and a crafted POST that does must be ignored.
    await updateStudioAction(
      form({
        name: "Studio",
        legal_entity_name: "Entity",
        birthday_reminder_color: "orange",
        time_format: "24h",
      }),
    );
    expect(updates).toHaveLength(1);
    expect(Object.keys(updates[0].values).sort()).toEqual(["legal_entity_name", "name"]);
  });

  it("a save with NO display fields at all does not write the 12h / purple defaults", async () => {
    await updateStudioAction(form({ name: "Studio", legal_entity_name: "" }));
    const written = updates.flatMap((u) => Object.keys(u.values));
    expect(written).not.toContain("birthday_reminder_color");
    expect(written).not.toContain("time_format_preference");
  });

  it("still refuses a practitioner", async () => {
    scenario.role = "practitioner";
    await expect(updateStudioAction(form({ name: "Studio" }))).rejects.toThrow(
      "Only studio owners can change studio settings.",
    );
    expect(updates).toHaveLength(0);
  });
});

describe("updateStudioDisplayPreferencesAction", () => {
  it("a practitioner is refused and nothing is written", async () => {
    scenario.role = "practitioner";
    const result = await updateStudioDisplayPreferencesAction(
      form({ birthday_reminder_color: "blue", time_format: "24h" }),
    );
    expect(result.ok).toBe(false);
    expect(updates).toHaveLength(0);
  });

  it("an owner writes only the two display columns", async () => {
    const result = await updateStudioDisplayPreferencesAction(
      form({ birthday_reminder_color: "blue", time_format: "24h" }),
    );
    expect(result).toEqual({ ok: true });
    expect(updates.map((u) => u.values)).toEqual([
      { birthday_reminder_color: "blue" },
      { time_format_preference: "24h" },
    ]);
    expect(updates.every((u) => u.id === "studio-1" && u.table === "studios")).toBe(true);
  });

  it.each([
    ["unknown colour", { birthday_reminder_color: "red", time_format: "24h" }],
    ["unknown time format", { birthday_reminder_color: "blue", time_format: "36h" }],
    ["missing colour", { time_format: "24h" }],
    ["missing time format", { birthday_reminder_color: "blue" }],
  ])("refuses %s rather than defaulting over a saved value", async (_n, fields) => {
    const result = await updateStudioDisplayPreferencesAction(form(fields));
    expect(result.ok).toBe(false);
    expect(updates).toHaveLength(0);
  });

  it("tolerates a missing time_format_preference column (migration 0109 not applied yet)", async () => {
    failTimeFormat = { code: "42703", message: "column does not exist" };
    const result = await updateStudioDisplayPreferencesAction(
      form({ birthday_reminder_color: "green", time_format: "12h" }),
    );
    expect(result).toEqual({ ok: true });
  });

  it("surfaces any other time-format error", async () => {
    failTimeFormat = { code: "42501", message: "permission denied" };
    const result = await updateStudioDisplayPreferencesAction(
      form({ birthday_reminder_color: "green", time_format: "12h" }),
    );
    expect(result.ok).toBe(false);
  });
});

describe("the Studio form no longer carries the display controls", () => {
  const src = readFileSync(
    path.resolve(__dirname, "../../../app/(app)/settings/studio/StudioSettingsForm.tsx"),
    "utf8",
  );
  it("does not render or submit them", () => {
    expect(src).not.toMatch(/birthday_reminder_color|time_format|BIRTHDAY_REMINDER_COLORS/);
  });
});
