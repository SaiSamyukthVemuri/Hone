import { afterEach, describe, expect, it, vi } from "vitest";

// RBAC G9 (Team matrix C9): a REMOVED practitioner's calendar feed stops answering. The feed URL is a bearer secret stored by
// third-party calendars, so removal (practitioners.active = false) must make it a plain 404 at once, with no appointment read.
// Behavioural, not a source grep: the route runs against a mocked admin client.

const STATE = vi.hoisted(() => ({
  practitioner: { id: "p1", studio_id: "s1", active: true } as { id: string; studio_id: string; active: boolean } | null,
  appointmentReads: 0,
}));

function tableBuilder(table: string) {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "gte", "order"]) b[m] = () => b;
  const result = () => {
    if (table === "practitioners") return { data: STATE.practitioner, error: null };
    if (table === "appointments") {
      STATE.appointmentReads += 1;
      return { data: [{ id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", starts_at: "2026-07-01T15:00:00.000Z", ends_at: "2026-07-01T15:30:00.000Z" }], error: null };
    }
    return { data: { address: "123 Studio St" }, error: null };
  };
  b.maybeSingle = () => Promise.resolve(result());
  b.then = (f: (v: unknown) => unknown, r?: (e: unknown) => unknown) => Promise.resolve(result()).then(f, r);
  return b;
}

vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: vi.fn(() => ({ from: (t: string) => tableBuilder(t) })) }));
vi.mock("@/lib/app-origin", () => ({ getRequiredAppOrigin: vi.fn(() => "https://hone.care") }));

import { GET } from "@/app/calendar-feed/[token]/route";

afterEach(() => {
  STATE.practitioner = { id: "p1", studio_id: "s1", active: true };
  STATE.appointmentReads = 0;
});

const TOKEN = "a_valid_feed_token_1234567890";
const get = () =>
  GET(new Request(`http://localhost/calendar-feed/${TOKEN}.ics`), { params: Promise.resolve({ token: `${TOKEN}.ics` }) });

describe("calendar feed after removal", () => {
  it("CONTROL: an active practitioner's feed is served", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("BEGIN:VCALENDAR");
    expect(STATE.appointmentReads).toBe(1);
  });

  it("a removed (inactive) practitioner's feed is a plain 404 and reads no appointments", async () => {
    STATE.practitioner = { id: "p1", studio_id: "s1", active: false };
    const res = await get();
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not found");
    expect(STATE.appointmentReads).toBe(0);
  });

  it("an unknown token answers the same 404 (a removed person is not distinguishable from a wrong token)", async () => {
    STATE.practitioner = null;
    const res = await get();
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not found");
  });
});
