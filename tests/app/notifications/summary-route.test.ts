import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { IdentityRefusalError } from "@/lib/supabase/identity-refusal";

// The summary route: a signed-in member's persisted unread count and newest ids, scoped like the layout's badge. The REAL route runs
// against a recording fake of the session client.

const STUDIO = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const STAFF = "33333333-3333-4333-8333-333333333333";
const ROW = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

type Call = [string, ...unknown[]];
let calls: Call[] = [];
let user: { id: string } | null = { id: "u" };
let identity: () => Promise<unknown>;
let readResult: { data: Array<{ id: string }> | null; count: number | null; error: unknown } = { data: [], count: 0, error: null };
let usedAdmin = false;

function query() {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "order", "limit", "not", "or"]) q[m] = (...a: unknown[]) => (calls.push([m, ...a]), q);
  q.then = (resolve: (v: unknown) => unknown) => resolve(readResult);
  return q;
}
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user } }) }, from: (t: string) => (calls.push(["from", t]), query()) }),
}));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => ((usedAdmin = true), {}) }));
vi.mock("@/lib/supabase/queries", () => ({ getCurrentPractitionerWithStudio: () => identity() }));

import { GET } from "@/app/api/notifications/summary/route";

const ident = (id: string, role: string) => async () => ({ studio: { id: STUDIO }, practitioner: { id, role } });

beforeEach(() => {
  calls = [];
  user = { id: "u" };
  identity = ident(OWNER, "owner");
  readResult = { data: [], count: 0, error: null };
  usedAdmin = false;
});

describe("GET /api/notifications/summary", () => {
  it("answers the count and the newest ids, nothing else, uncached", async () => {
    readResult = { data: [{ id: ROW(1) }, { id: ROW(2) }], count: 7, error: null };
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store, private");
    const body = (await res.json()) as { unread: number; ids: string[]; viewer: string };
    expect(body).toEqual({ unread: 7, ids: [ROW(1), ROW(2)], viewer: expect.stringMatching(/^[0-9a-f]{16}$/) });
    // opaque: never the practitioner id itself
    expect(JSON.stringify(body)).not.toContain(OWNER);
  });

  it("reads only this studio's UNREAD rows, newest first, bounded, with the session client", async () => {
    await GET();
    expect(calls).toContainEqual(["from", "practitioner_notifications"]);
    expect(calls).toContainEqual(["eq", "studio_id", STUDIO]);
    expect(calls).toContainEqual(["is", "read_at", null]);
    expect(calls).toContainEqual(["order", "created_at", { ascending: false }]);
    expect(calls).toContainEqual(["limit", 20]);
    expect(usedAdmin).toBe(false);
  });

  it("scopes to the viewer exactly as the layout badge does: a non-owner excludes owner-only events, an owner does not", async () => {
    identity = ident(STAFF, "practitioner");
    await GET();
    expect(calls.some((c) => c[0] === "not" && c[1] === "event_type" && String(c[3]).includes("card_added"))).toBe(true);
    expect(calls.some((c) => c[0] === "or" && String(c[1]).includes(`practitioner_id.eq.${STAFF}`))).toBe(true);
    calls = [];
    identity = ident(OWNER, "owner");
    await GET();
    expect(calls.some((c) => c[0] === "not")).toBe(false);
  });

  it("takes no request parameter: the studio and viewer come from the session", () => {
    expect(readFileSync("app/api/notifications/summary/route.ts", "utf8")).toMatch(/export async function GET\(\)/);
  });

  it("the viewer marker is stable for a person and differs between people", async () => {
    const a1 = ((await (await GET()).json()) as { viewer: string }).viewer;
    const a2 = ((await (await GET()).json()) as { viewer: string }).viewer;
    identity = ident(STAFF, "practitioner");
    const b1 = ((await (await GET()).json()) as { viewer: string }).viewer;
    expect(a1).toBe(a2);
    expect(b1).not.toBe(a1);
  });

  it("every ERROR response is also no-store, private (401, 403, 503, 500)", async () => {
    const NS = "no-store, private";
    user = null;
    expect((await GET()).headers.get("Cache-Control")).toBe(NS);
    user = { id: "u" };
    identity = async () => { throw new IdentityRefusalError("no-active-practitioner", "nope"); };
    expect((await GET()).headers.get("Cache-Control")).toBe(NS);
    identity = async () => { throw new Error("db down"); };
    expect((await GET()).headers.get("Cache-Control")).toBe(NS);
    identity = ident(OWNER, "owner");
    readResult = { data: null, count: null, error: { code: "XX000", message: "x" } };
    expect((await GET()).headers.get("Cache-Control")).toBe(NS);
    identity = async () => { throw Object.assign(new Error("r"), { digest: "NEXT_REDIRECT;replace;/login" }); };
    expect((await GET()).headers.get("Cache-Control")).toBe(NS);
  });

  it("401 for no user, 403 for a controlled identity refusal, 503 for an infrastructure error, with no read at all", async () => {
    user = null;
    expect((await GET()).status).toBe(401);
    user = { id: "u" };
    identity = async () => { throw new IdentityRefusalError("no-active-practitioner", "nope"); };
    expect((await GET()).status).toBe(403);
    identity = async () => { throw new Error("db down"); };
    const res = await GET();
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain("db down");
    expect(calls.some((c) => c[0] === "from")).toBe(false);
  });

  it("a NEXT_REDIRECT from the identity layer is an authentication answer", async () => {
    identity = async () => { throw Object.assign(new Error("r"), { digest: "NEXT_REDIRECT;replace;/login" }); };
    expect((await GET()).status).toBe(401);
  });

  it("a failed read is a plain 500 with no detail", async () => {
    readResult = { data: null, count: null, error: { code: "XX000", message: "secret db text" } };
    const res = await GET();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("secret");
  });
});
