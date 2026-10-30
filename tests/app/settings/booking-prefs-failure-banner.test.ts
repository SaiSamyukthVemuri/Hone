import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { captureConsole } from "../../lib/sms/helpers/log-capture";

// MSG-LOG-RAW-ERROR R1 (F5). updateStudioBookingPrefsAction returns a thrown
// message to the person as the banner AND puts it in the redirect query, so a
// database message there reached the page and the URL. The fallback is now a
// fixed sentence; the log carries the SQLSTATE only. Synthetic values only.

vi.mock("server-only", () => ({}));

const EMAIL = "leak.probe@example.test";
const HOSTILE = `invalid input syntax for type uuid: "${EMAIL}" +1 555 010 0199`;

const state = vi.hoisted(() => ({ error: null as { code?: string; message: string } | null, redirects: [] as string[] }));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    state.redirects.push(url);
    throw new Error("NEXT_REDIRECT");
  },
}));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({ practitioner: { role: "owner" }, studio: { id: "s1", slug: "willow-studio" } }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({ update: () => ({ eq: async () => ({ error: state.error }) }) }),
  }),
}));

function form(): FormData {
  const f = new FormData();
  f.set("timezone", "America/Toronto");
  f.set("default_appointment_duration_minutes", "60");
  f.set("buffer_minutes", "15");
  f.set("public_booking_horizon_months", "3");
  f.set("slug", "willow-studio");
  return f;
}

let logs: ReturnType<typeof captureConsole>;
beforeEach(() => {
  state.redirects.length = 0;
  logs = captureConsole();
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function run(): Promise<string> {
  const { updateStudioBookingPrefsAction } = await import("@/app/(app)/settings/booking/actions");
  await expect(updateStudioBookingPrefsAction(form())).rejects.toThrow("NEXT_REDIRECT");
  expect(state.redirects).toHaveLength(1);
  return state.redirects[0];
}

describe("the booking-settings failure banner", () => {
  it("a database error carrying a value leaves the banner and the URL with the code only", async () => {
    state.error = { code: "22P02", message: HOSTILE };
    const url = await run();
    expect(url).toBe("/settings/booking?error=save_failed");
    expect(url).not.toContain("leak");
    expect(url).not.toContain("5550100199");
    expect(logs.text()).toContain("booking_settings_update_failed");
    expect(logs.text()).toContain("22P02");
    expect(logs.text()).not.toContain("leak.probe");
  });

  it("an error with no usable code is logged as unknown", async () => {
    state.error = { code: HOSTILE, message: HOSTILE };
    const url = await run();
    expect(url).toBe("/settings/booking?error=save_failed");
    expect(logs.text()).toContain("unknown");
    expect(logs.text()).not.toContain("leak.probe");
  });

  it("the deliberate sentences are unchanged (codes: slug taken, timezone conflict)", async () => {
    state.error = { code: "23505", message: HOSTILE };
    expect(await run()).toBe("/settings/booking?error=slug_taken");
    state.redirects.length = 0;
    state.error = { code: "23P01", message: HOSTILE };
    expect(await run()).toBe("/settings/booking?error=timezone_conflict");
  });
});
