import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

// HON-58 Q1: the owner-only switch for receptionist access to client legal names (0266).
// Default OFF, never turned on by the app, owner only, signed-in client only, audited by the RPC.

const h = vi.hoisted(() => ({
  role: "owner" as string,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  rpcResult: { data: true as unknown, error: null as null | { code: string } },
  rows: null as null | { receptionist_access: boolean },
  readError: false,
  revalidated: [] as string[],
}));

vi.mock("next/cache", () => ({ revalidatePath: (p: string) => { h.revalidated.push(p); } }));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => { throw new Error("the legal-name switch must never use the service role"); },
}));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({ practitioner: { id: "p1", role: h.role }, studio: { id: "studio-A" } }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => { h.rpcCalls.push({ fn, args }); return h.rpcResult; },
  }),
}));

import { setReceptionistLegalNameAccessAction } from "@/app/(app)/settings/team/legal-name-access-actions";
const OWNER_ONLY_LEGAL_NAME_MESSAGE = "Only studio owners can change this setting.";
import { readReceptionistLegalNameAccess } from "@/lib/clients/legal-name-access";

function fd(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

beforeEach(() => {
  h.role = "owner";
  h.rpcCalls = [];
  h.rpcResult = { data: true, error: null };
  h.revalidated = [];
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("setReceptionistLegalNameAccessAction", () => {
  it("an owner turning it ON (confirmed) calls the 0266 RPC for their OWN studio, never one from the form", async () => {
    const r = await setReceptionistLegalNameAccessAction(fd({ enabled: "on", confirm: "yes", studio_id: "studio-OTHER" }));
    expect(r).toEqual({ ok: true, receptionistAccess: true, changed: true });
    expect(h.rpcCalls).toEqual([{ fn: "set_receptionist_legal_name_access", args: { p_studio_id: "studio-A", p_enabled: true } }]);
    expect(h.revalidated).toContain("/settings/team");
  });

  it("turning it OFF needs no confirmation and a no-op reports changed: false", async () => {
    h.rpcResult = { data: false, error: null };
    const r = await setReceptionistLegalNameAccessAction(fd({ enabled: "off" }));
    expect(r).toEqual({ ok: true, receptionistAccess: false, changed: false });
    expect(h.rpcCalls[0].args).toEqual({ p_studio_id: "studio-A", p_enabled: false });
  });

  it.each([
    ["no value", {}],
    ["a truthy-looking value", { enabled: "true" }],
    ["1", { enabled: "1" }],
    ["empty", { enabled: "" }],
  ])("%s is refused and nothing is written (it can never default to ON)", async (_l, fields) => {
    const r = await setReceptionistLegalNameAccessAction(fd(fields));
    expect(r.ok).toBe(false);
    expect(h.rpcCalls).toHaveLength(0);
  });

  it("ON without the explicit confirmation is refused and nothing is written", async () => {
    for (const confirm of [undefined, "no", "on", "true"]) {
      const r = await setReceptionistLegalNameAccessAction(fd({ enabled: "on", ...(confirm ? { confirm } : {}) }));
      expect(r.ok).toBe(false);
    }
    expect(h.rpcCalls).toHaveLength(0);
  });

  it.each(["practitioner", "receptionist", "", "admin"])("role %j is refused before the database is called", async (role) => {
    h.role = role;
    const r = await setReceptionistLegalNameAccessAction(fd({ enabled: "on", confirm: "yes" }));
    expect(r).toEqual({ ok: false, error: OWNER_ONLY_LEGAL_NAME_MESSAGE });
    expect(h.rpcCalls).toHaveLength(0);
  });

  it("the database's own refusal (42501) surfaces as the owner-only message, any other failure is generic and carries only a code", async () => {
    h.rpcResult = { data: null, error: { code: "42501" } };
    expect(await setReceptionistLegalNameAccessAction(fd({ enabled: "on", confirm: "yes" }))).toEqual({ ok: false, error: OWNER_ONLY_LEGAL_NAME_MESSAGE });
    h.rpcResult = { data: null, error: { code: "57014" } };
    const r = await setReceptionistLegalNameAccessAction(fd({ enabled: "off" }));
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/Couldn.t change this setting/) });
  });
});

describe("readReceptionistLegalNameAccess: no row is OFF, a failed read is unavailable", () => {
  function supa(result: { data: unknown; error: unknown }, seen: string[] = []) {
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (c: string, v: unknown) => { seen.push(`${c}=${String(v)}`); return q; },
      maybeSingle: async () => result,
    };
    return { from: (t: string) => { seen.push(t); return q; } } as never;
  }
  it("no row -> OFF", async () => {
    expect(await readReceptionistLegalNameAccess(supa({ data: null, error: null }), "studio-A")).toEqual({ ok: true, receptionistAccess: false });
  });
  it("a stored false -> OFF, a stored true -> ON, filtered to the studio", async () => {
    const seen: string[] = [];
    expect(await readReceptionistLegalNameAccess(supa({ data: { receptionist_access: false }, error: null }, seen), "studio-A")).toEqual({ ok: true, receptionistAccess: false });
    expect(await readReceptionistLegalNameAccess(supa({ data: { receptionist_access: true }, error: null }), "studio-A")).toEqual({ ok: true, receptionistAccess: true });
    expect(seen).toEqual(["studio_legal_name_access", "studio_id=studio-A"]);
  });
  it("a failed read is { ok: false }, never silently OFF or ON", async () => {
    expect(await readReceptionistLegalNameAccess(supa({ data: null, error: { code: "57014" } }), "studio-A")).toEqual({ ok: false });
  });
});

describe("source contract: owner-only, default OFF, nothing turns it on", () => {
  const page = readFileSync("app/(app)/settings/team/page.tsx", "utf8");
  const action = readFileSync("app/(app)/settings/team/legal-name-access-actions.ts", "utf8");
  const ui = readFileSync("app/(app)/settings/team/LegalNameAccessSwitch.tsx", "utf8");

  it("the switch renders only below the page's owner-only early return, reading the stored value", () => {
    expect(page.indexOf('practitioner.role !== "owner"')).toBeGreaterThan(-1);
    expect(page.indexOf("<LegalNameAccessSwitch")).toBeGreaterThan(page.indexOf('practitioner.role !== "owner"'));
    expect(page).toMatch(/<LegalNameAccessSwitch initialEnabled=\{legalNameAccess\.receptionistAccess\}/);
    expect(page).toMatch(/legal-name-access-unavailable/);
  });
  it("the wording says plainly that it lets receptionists see legal names", () => {
    expect(page).toMatch(/lets receptionists see client legal names/);
    expect(ui).toMatch(/receptionists will be able to see every client/);
  });
  it("nothing defaults it ON: the UI starts from the stored value, ON needs a checkbox, the action needs 'on' + 'yes'", () => {
    expect(ui).toMatch(/useState\(initialEnabled\)/);
    expect(ui).toMatch(/useState\(false\)/);
    expect(ui).not.toMatch(/initialEnabled=\{true\}|defaultChecked/);
    expect(action).toMatch(/requested !== "on" && requested !== "off"/);
    expect(action).toMatch(/formData\.get\("confirm"\) !== "yes"/);
  });
  it("the action uses the signed-in client and the one RPC; no admin client, no table write", () => {
    expect(action).not.toMatch(/admin-server|createAdminClient/);
    expect(action).toMatch(/rpc\("set_receptionist_legal_name_access"/);
    expect(action).not.toMatch(/\.from\(/);
  });
  it("no other app code calls the RPC or writes the switch table (so nothing turns it on)", () => {
    const hits = (readFileSync("lib/clients/legal-name-access.ts", "utf8").match(/\.(insert|update|upsert)\(/g) ?? []);
    expect(hits).toHaveLength(0);
  });
});

describe("the new server-action files only export async functions and types (next build refuses anything else)", () => {
  it.each([
    "app/(app)/settings/team/legal-name-access-actions.ts",
    "app/(app)/clients/[id]/legal-identity-actions.ts",
  ])("%s", async (file) => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(file, "utf8");
    expect(src.startsWith('"use server"')).toBe(true);
    const exports = src.match(/^export\s+.*$/gm) ?? [];
    for (const line of exports) expect(line).toMatch(/^export (async function|type) /);
  });
});
