import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

// The platform admin's Front Desk controls (0390). Admin identity comes from the authenticated session, never the request; a reason is required and is
// never echoed back; the key can never be put in "all" mode from here.

const S = vi.hoisted(() => ({ user: null as null | { id: string; email: string | null }, admins: ["op@example.invalid"], calls: [] as unknown[][] }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: S.user } }) } }) }));
vi.mock("@/lib/admin", () => ({ isAdmin: (e: string | null | undefined) => !!e && S.admins.includes(e) }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => { throw new Error("no real client"); } }));
vi.mock("@/lib/rollouts/front-desk-admin", async (orig) => {
  const real = await orig<typeof import("@/lib/rollouts/front-desk-admin")>();
  return {
    ...real,
    setFrontDeskKeyPilot: vi.fn(async (...a: unknown[]) => { S.calls.push(["pilot", ...a]); return { kind: "ok", value: "changed" }; }),
    enableFrontDeskForStudio: vi.fn(async (...a: unknown[]) => { S.calls.push(["on", ...a]); return { kind: "ok", value: "added" }; }),
    disableFrontDeskForStudio: vi.fn(async (...a: unknown[]) => { S.calls.push(["off", ...a]); return { kind: "ok", value: "removed" }; }),
    grantFrontDeskSeats: vi.fn(async (...a: unknown[]) => { S.calls.push(["grant", ...a]); return { kind: "ok", value: "11111111-aaaa-4aaa-8aaa-111111111111" }; }),
    revokeFrontDeskSeats: vi.fn(async (...a: unknown[]) => { S.calls.push(["revoke", ...a]); return { kind: "ok", status: "revoked", seatsOverLimit: 2 }; }),
  };
});

import { grantSeatsAction, revokeSeatsAction, setStudioFrontDeskAction } from "@/app/admin/front-desk/actions";

const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const ADMIN = { id: "11111111-1111-4111-8111-111111111111", email: "op@example.invalid" };
const STUDIO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SEAT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SECRET = "synthetic-reason-text-that-must-not-travel";
const future = () => new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10);
beforeEach(() => { S.user = ADMIN; S.calls = []; });

describe("who may act", () => {
  it("a signed-in NON-admin, and no session at all: refused, and no command runs", async () => {
    for (const user of [{ id: "22222222-2222-4222-8222-222222222222", email: "someone@example.invalid" }, null]) {
      S.user = user;
      for (const r of [
        await setStudioFrontDeskAction(form({ studioId: STUDIO, on: "true" })),
        await grantSeatsAction(form({ studioId: STUDIO, seats: "1", source: "pilot", reason: "r" })),
        await revokeSeatsAction(form({ seatId: SEAT, reason: "r", studioId: STUDIO })),
      ]) expect(r).toEqual({ ok: false, message: "Not authorized." });
    }
    expect(S.calls).toEqual([]);
  });

  it("the actor is the SESSION's id and email, whatever the form claims", async () => {
    await grantSeatsAction(form({ studioId: STUDIO, seats: "1", source: "pilot", reason: "r", actorEmail: "attacker@example.invalid", userId: "evil" }));
    await revokeSeatsAction(form({ seatId: SEAT, reason: "r", actorEmail: "attacker@example.invalid", userId: "evil" }));
    await setStudioFrontDeskAction(form({ studioId: STUDIO, on: "true", actorEmail: "attacker@example.invalid", userId: "evil" }));
    expect(S.calls.length).toBeGreaterThanOrEqual(4);
    for (const c of S.calls) {
      const actor = c.find((x) => typeof x === "object" && x !== null && "userId" in (x as object) && "email" in (x as object));
      expect(actor).toEqual({ userId: ADMIN.id, email: ADMIN.email });
    }
  });

  it("source: the actions read only the named fields, and every action authorizes before any command", () => {
    const src = readFileSync("app/admin/front-desk/actions.ts", "utf8").replace(/\/\/.*$/gm, "");
    expect([...src.matchAll(/(?:formData|fd)\.get\("(\w+)"\)/g)].map((m) => m[1]).sort()).toEqual(["expiresAt", "on", "reason", "seatId", "seats", "source", "studioId"]);
    expect(src).not.toMatch(/formData\.(getAll|entries|keys)|Object\.fromEntries/);
    for (const n of ["setStudioFrontDeskAction", "grantSeatsAction", "revokeSeatsAction"]) {
      const body = src.slice(src.indexOf(`export async function ${n}`));
      expect(body.indexOf("await authorize(")).toBeGreaterThan(-1);
      expect(body.indexOf("await authorize(")).toBeLessThan(body.search(/await (setFrontDeskKeyPilot|enableFrontDeskForStudio|disableFrontDeskForStudio|grantFrontDeskSeats|revokeFrontDeskSeats)\(/));
    }
  });
});

describe("the switch", () => {
  it("turning a studio on makes sure the key is in PILOT mode (never all) and lists the studio; off only removes it", async () => {
    expect(await setStudioFrontDeskAction(form({ studioId: STUDIO, on: "true" }))).toMatchObject({ ok: true });
    expect(S.calls.map((c) => c[0])).toEqual(["pilot", "on"]);
    S.calls = [];
    expect(await setStudioFrontDeskAction(form({ studioId: STUDIO, on: "false" }))).toMatchObject({ ok: true });
    expect(S.calls.map((c) => c[0])).toEqual(["off"]);
  });
  it("source: this screen has no way to ask for mode all", () => {
    const files = ["app/admin/front-desk/actions.ts", "app/admin/front-desk/page.tsx", "lib/rollouts/front-desk-admin.ts"].map((f) => readFileSync(f, "utf8").replace(/\/\/.*$/gm, ""));
    for (const src of files) expect(src).not.toMatch(/["']all["']|ALL STUDIOS/);
    expect([...files[2].matchAll(/p_mode:\s*("[a-z]+")/g)].map((m) => m[1])).toEqual(['"pilot"']);
  });
  it("a studio id that is not a uuid, and an on/off that is neither, are refused before any command", async () => {
    expect(await setStudioFrontDeskAction(form({ studioId: "not-a-uuid", on: "true" }))).toMatchObject({ ok: false });
    expect(await setStudioFrontDeskAction(form({ studioId: STUDIO, on: "maybe" }))).toMatchObject({ ok: false });
    expect(S.calls).toEqual([]);
  });
});

describe("seat grants", () => {
  it("a valid grant passes studio, seats, source, the reason and a future expiry as the END of that UTC day", async () => {
    const out = await grantSeatsAction(form({ studioId: STUDIO, seats: "2", source: "custom_agreed", reason: SECRET, expiresAt: future() }));
    expect(out).toEqual({ ok: true, message: "Seats granted." });
    const [, args] = S.calls[0] as [string, { studioId: string; seats: number; source: string; reason: string; expiresAt: string }];
    expect(args).toMatchObject({ studioId: STUDIO, seats: 2, source: "custom_agreed", reason: SECRET });
    expect(args.expiresAt.endsWith("T23:59:59.000Z")).toBe(true);
  });
  it("a reason is required, trimmed, and at most 500 characters; seats 1 to 50; a known source; a future date", async () => {
    const base = { studioId: STUDIO, seats: "1", source: "pilot", reason: "ok" };
    for (const bad of <Record<string, string>[]>[{ reason: "" }, { reason: "   " }, { reason: "x".repeat(501) }, { seats: "0" }, { seats: "51" }, { seats: "1.5" }, { seats: "abc" }, { source: "free" }, { source: "" }, { expiresAt: "2001-01-01" }, { expiresAt: "tomorrow" }]) {
      expect(await grantSeatsAction(form({ ...base, ...bad })), JSON.stringify(bad)).toMatchObject({ ok: false });
    }
    expect(S.calls).toEqual([]);
  });
  it("the reason is never echoed back in a notice, whatever the outcome", async () => {
    const outcomes = [
      await grantSeatsAction(form({ studioId: STUDIO, seats: "1", source: "pilot", reason: SECRET })),
      await revokeSeatsAction(form({ seatId: SEAT, reason: SECRET })),
    ];
    for (const o of outcomes) expect(JSON.stringify(o)).not.toContain(SECRET);
  });
});

describe("revoking", () => {
  it("needs a reason, and says how many receptionists are now over the limit without deleting anything", async () => {
    expect(await revokeSeatsAction(form({ seatId: SEAT, reason: "" }))).toMatchObject({ ok: false });
    expect(S.calls).toEqual([]);
    const out = await revokeSeatsAction(form({ seatId: SEAT, reason: "agreed end" }));
    expect(out.ok).toBe(true);
    expect(out.message).toMatch(/2 receptionists are now over the seat limit/);
    expect(out.message).toMatch(/Nothing was deleted/);
  });
  it("a grant id that is not a uuid is refused before any command", async () => {
    expect(await revokeSeatsAction(form({ seatId: "x", reason: "r" }))).toMatchObject({ ok: false });
    expect(S.calls).toEqual([]);
  });
});
