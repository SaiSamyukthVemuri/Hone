// HON-50 (Sam, 24 Oct, decision B). The team's calendar subscription feed MAY
// carry the studio address, whatever the owner's visibility choice, PROVIDED the
// owner-facing setting discloses that destination and that connected calendar
// services can retain it. This file proves the three halves without editing the
// feed (Machines' file):
//
//   1. scoping is unchanged: only a valid, active practitioner token reaches an
//      address, and only its OWN studio's (unknown token, inactive practitioner
//      and a token for another studio never see this studio's address);
//   2. the feed's behaviour is today's: it reads only `address`, so no
//      visibility value changes it (existing defaults preserved);
//   3. Settings > Booking discloses the feed and the retention, in the address
//      help and in the visibility help, and never calls the private option
//      "email only".
//
// All values are synthetic.

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ADDRESS_A = "100 Synthetic Studio A Lane";
const ADDRESS_B = "200 Synthetic Studio B Road";

const world = vi.hoisted(() => ({
  practitioner: null as null | { id: string; studio_id: string; active: boolean },
  studioReads: [] as Array<[string, unknown]>,
}));

function builder(table: string) {
  const filters: Array<[string, unknown]> = [];
  const b: Record<string, unknown> = {};
  for (const m of ["select", "in", "gte", "order"]) b[m] = () => b;
  b.eq = (col: string, val: unknown) => {
    filters.push([col, val]);
    if (table === "studios") world.studioReads.push([col, val]);
    return b;
  };
  const result = () => {
    if (table === "practitioners") return { data: world.practitioner, error: null };
    if (table === "appointments")
      return {
        data: [{ id: "00000000-0000-4000-8000-0000000000b1", starts_at: "2031-03-04T15:00:00.000Z", ends_at: "2031-03-04T16:00:00.000Z" }],
        error: null,
      };
    if (table === "studios") {
      const id = filters.find(([c]) => c === "id")?.[1];
      const address = id === "studio-a" ? ADDRESS_A : id === "studio-b" ? ADDRESS_B : null;
      return { data: address ? { address } : null, error: null };
    }
    return { data: null, error: null };
  };
  b.maybeSingle = () => Promise.resolve(result());
  b.then = (f: (v: unknown) => unknown, r?: (e: unknown) => unknown) => Promise.resolve(result()).then(f, r);
  return b;
}

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({ from: (t: string) => builder(t) }),
}));
vi.mock("@/lib/app-origin", () => ({ getRequiredAppOrigin: () => "https://hone.care" }));

const { GET } = await import("@/app/calendar-feed/[token]/route");
const TOKEN = "SyntheticFeedToken_0123456789abcdef";

async function feed(token = TOKEN): Promise<{ status: number; body: string }> {
  const res = await GET(new Request(`https://hone.care/calendar-feed/${token}.ics`), {
    params: Promise.resolve({ token: `${token}.ics` }),
  });
  return { status: res.status, body: await res.text() };
}

beforeEach(() => {
  world.practitioner = null;
  world.studioReads.length = 0;
});

describe("1. scoping: only a valid active token, and only its own studio", () => {
  it("a studio-A practitioner's feed carries studio A's address and never studio B's", async () => {
    world.practitioner = { id: "p-a", studio_id: "studio-a", active: true };
    const { status, body } = await feed();
    expect(status).toBe(200);
    expect(body).toContain("LOCATION:100 Synthetic Studio A Lane");
    expect(body).not.toContain("Studio B");
    expect(world.studioReads).toEqual([["id", "studio-a"]]);
  });

  it("a studio-B practitioner's feed carries only studio B's address (wrong-studio viewer of A)", async () => {
    world.practitioner = { id: "p-b", studio_id: "studio-b", active: true };
    const { body } = await feed();
    expect(body).not.toContain("Studio A");
    expect(world.studioReads).toEqual([["id", "studio-b"]]);
  });

  it("an unknown token: 404, no address, the studio is never read", async () => {
    const { status, body } = await feed();
    expect(status).toBe(404);
    expect(body).not.toMatch(/Synthetic Studio/);
    expect(world.studioReads).toEqual([]);
  });

  it("an inactive practitioner's token: 404, no address", async () => {
    world.practitioner = { id: "p-a", studio_id: "studio-a", active: false };
    const { status, body } = await feed();
    expect(status).toBe(404);
    expect(body).not.toMatch(/Synthetic Studio/);
  });

  it("a malformed short token: 404 before any read", async () => {
    const { status } = await feed("short");
    expect(status).toBe(404);
    expect(world.studioReads).toEqual([]);
  });
});

describe("2. behaviour is today's: the feed reads only the address column", () => {
  it("selects `address` and nothing visibility-related", () => {
    const src = readFileSync("app/calendar-feed/[token]/route.ts", "utf8");
    expect(src).toMatch(/\.from\("studios"\)\s*\.select\("address"\)/);
    expect(src).not.toMatch(/address_visibility|arrival_instructions|studio-location/);
  });
});

describe("3. the owner-facing setting discloses the feed and what connected services keep", () => {
  const page = readFileSync("app/(app)/settings/booking/page.tsx", "utf8").replace(/\s+/g, " ");

  it("the visibility help names every destination", () => {
    const start = page.indexOf('id="address-visibility"');
    const help = page.slice(start, page.indexOf("</label>", start));
    for (const phrase of [
      "Your public booking page can be seen by anyone",
      "confirmation, reminder and appointment-update emails",
      "calendar invite attached to the confirmation",
      "confirmation screen shown to that client right after they book",
      "Whichever you choose, the address is also included in your team&rsquo;s calendar subscription feed",
      "calendar services connected to that feed (such as Google, Apple or Outlook Calendar) can keep a copy",
    ]) {
      expect(help, phrase).toContain(phrase);
    }
  });

  it("the private option is named for its real audience, never 'email only'", () => {
    expect(page).toContain("Booked-client communications only (not the public booking page)");
    expect(page).toContain("Public booking page and booked-client communications");
    expect(page).toContain("Public booking page only");
    expect(page).not.toMatch(/emails? only|email-only/i);
  });

  it("the address help (both variants) discloses the feed and retention", () => {
    const start = page.indexOf('id="public-address"');
    const help = page.slice(start, page.indexOf("</label>", start));
    expect(help.match(/calendar subscription feed/g)?.length).toBe(2);
    expect(help.match(/can keep a copy/g)?.length).toBe(2);
  });
});
