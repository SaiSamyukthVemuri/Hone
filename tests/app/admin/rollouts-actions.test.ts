import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const S = vi.hoisted(() => ({ user: null as null | { id: string; email: string | null }, admins: ["op@example.invalid"], calls: [] as unknown[][] }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: S.user } }) } }) }));
vi.mock("@/lib/admin", () => ({ isAdmin: (e: string | null | undefined) => !!e && S.admins.includes(e) }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => { throw new Error("no real client"); } }));
vi.mock("@/lib/rollouts/admin-commands", async (orig) => {
  const real = await orig<typeof import("@/lib/rollouts/admin-commands")>();
  return {
    ...real,
    setRolloutMode: vi.fn(async (...a: unknown[]) => { S.calls.push(["set", ...a]); return { kind: "ok", value: "changed" }; }),
    addPilotStudio: vi.fn(async (...a: unknown[]) => { S.calls.push(["add", ...a]); return { kind: "ok", value: "added" }; }),
    removePilotStudio: vi.fn(async (...a: unknown[]) => { S.calls.push(["remove", ...a]); return { kind: "ok", value: "removed" }; }),
    logBlockedAttempt: vi.fn(async (...a: unknown[]) => { S.calls.push(["blocked", ...a]); }),
  };
});

import { addPilotStudioAction, removePilotStudioAction, setRolloutModeAction } from "@/app/admin/rollouts/actions";

const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const ADMIN = { id: "11111111-1111-4111-8111-111111111111", email: "op@example.invalid" };
const STUDIO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
beforeEach(() => { S.user = ADMIN; S.calls = []; });

describe("the actor is taken from the authenticated session AFTER isAdmin, never from arguments or form data", () => {
  it("a form that carries actor-looking fields is ignored: the command gets the SESSION's id and email", async () => {
    await setRolloutModeAction(form({ mode: "pilot", actorEmail: "attacker@example.invalid", actor_user_id: "ffffffff-ffff-4fff-8fff-ffffffffffff", email: "x@y.z", userId: "evil" }));
    await addPilotStudioAction(form({ studioId: STUDIO, actorEmail: "attacker@example.invalid", userId: "evil" }));
    await removePilotStudioAction(form({ studioId: STUDIO, actorEmail: "attacker@example.invalid", userId: "evil" }));
    expect(S.calls).toHaveLength(3);
    for (const c of S.calls) expect(c.find((x) => typeof x === "object" && x !== null && "userId" in (x as object))).toEqual({ userId: ADMIN.id, email: ADMIN.email });
  });
  it("source: the actions read only mode, confirm and studioId from the form, and the actor only from getUser", () => {
    const src = readFileSync("app/admin/rollouts/actions.ts", "utf8").replace(/\/\/.*$/gm, "");
    expect([...src.matchAll(/formData\.get\("(\w+)"\)/g)].map((m) => m[1]).sort()).toEqual(["confirm", "mode", "studioId", "studioId"]);
    expect(src.match(/auth\.getUser\(\)/g)?.length).toBe(1); // one helper every action goes through
    expect(src).not.toMatch(/formData\.(getAll|entries|keys)|Object\.fromEntries/);
  });
  it("every action goes through the authorize helper before any command", () => {
    const src = readFileSync("app/admin/rollouts/actions.ts", "utf8");
    for (const n of ["setRolloutModeAction", "addPilotStudioAction", "removePilotStudioAction"]) {
      const body = src.slice(src.indexOf(`export async function ${n}`));
      expect(body.indexOf("await authorize(")).toBeGreaterThan(-1);
      expect(body.indexOf("await authorize(")).toBeLessThan(body.search(/await (setRolloutMode|addPilotStudio|removePilotStudio)\(/));
    }
  });
});

describe("blocked callers", () => {
  it("a signed-in NON-admin: refused, logged by user id only, and no command runs", async () => {
    S.user = { id: "22222222-2222-4222-8222-222222222222", email: "someone@example.invalid" };
    for (const r of [await setRolloutModeAction(form({ mode: "all", confirm: "ALL STUDIOS" })), await addPilotStudioAction(form({ studioId: STUDIO })), await removePilotStudioAction(form({ studioId: STUDIO }))]) expect(r).toEqual({ ok: false, message: "Not authorized." });
    expect(S.calls.map((c) => c[0])).toEqual(["blocked", "blocked", "blocked"]);
    for (const c of S.calls) expect(JSON.stringify(c)).not.toContain("someone@example.invalid"); // the email is never passed
  });
  it("no session: refused and NOTHING is written or logged", async () => {
    S.user = null;
    expect(await setRolloutModeAction(form({ mode: "all", confirm: "ALL STUDIOS" }))).toEqual({ ok: false, message: "Not authorized." });
    expect(S.calls).toEqual([]);
  });
  it("an admin-listed user with no email on the session is refused (no email to record)", async () => {
    S.user = { id: ADMIN.id, email: null };
    expect((await setRolloutModeAction(form({ mode: "pilot" }))).ok).toBe(false);
    expect(S.calls.every((c) => c[0] === "blocked")).toBe(true);
  });
});

describe("typed confirmation for All is enforced in the ACTION", () => {
  it("All without the exact phrase is refused and runs nothing; with it, it runs", async () => {
    for (const confirm of ["", "all", "ALL STUDIOS ", "all studios", "ALL"]) expect((await setRolloutModeAction(form({ mode: "all", confirm }))).ok, confirm).toBe(false);
    expect((await setRolloutModeAction(form({ mode: "all" }))).ok).toBe(false);
    expect(S.calls).toEqual([]);
    expect((await setRolloutModeAction(form({ mode: "all", confirm: "ALL STUDIOS" }))).ok).toBe(true);
    expect(S.calls).toHaveLength(1);
  });
  it("Off and Pilot need no phrase; an unknown mode is refused", async () => {
    expect((await setRolloutModeAction(form({ mode: "off" }))).ok).toBe(true);
    expect((await setRolloutModeAction(form({ mode: "pilot" }))).ok).toBe(true);
    for (const mode of ["sometimes", "ALL", "", "pilot,all"]) expect((await setRolloutModeAction(form({ mode }))).ok, mode).toBe(false);
  });
  it("a studio id must be a plain uuid", async () => {
    for (const studioId of ["", "not-an-id", `${STUDIO}'; drop table x;--`, "all"]) {
      expect((await addPilotStudioAction(form({ studioId }))).ok, studioId).toBe(false);
      expect((await removePilotStudioAction(form({ studioId }))).ok, studioId).toBe(false);
    }
    expect(S.calls).toEqual([]);
  });
});

describe("gates and render path", () => {
  it("the layout, the page and every action each check admin", () => {
    expect(readFileSync("app/admin/layout.tsx", "utf8")).toMatch(/isAdmin\(user\.email\)/);
    expect(readFileSync("app/admin/rollouts/page.tsx", "utf8")).toContain("await requirePlatformAdmin()");
    expect(readFileSync("app/admin/rollouts/actions.ts", "utf8").match(/isAdmin\(/g)?.length).toBe(1);
  });
  it("the page shows no studio id, owner email or machine data (names only; an id only in a hidden form value)", () => {
    const page = readFileSync("app/admin/rollouts/page.tsx", "utf8");
    expect(page.replace(/\/\/.*$/gm, '')).not.toMatch(/owner_email|studio_machines|from\(\"clients\"\)|>\s*\{(p|s)\.(studio_)?id\}|\{p\.studio_id\} </);
    expect(page).toMatch(/\.select\("id, name"\)/);
  });
  it("RENDER-PATH INVARIANT: the resolver only READS (one read-only rpc), so rendering Settings > Machines or the session page writes nothing", () => {
    const src = readFileSync("lib/rollouts/charting-rollout.ts", "utf8").replace(/\/\/.*$/gm, "");
    expect([...src.matchAll(/rpc\("(\w+)"/g)].map((m) => m[1])).toEqual(["platform_rollout_enabled_for"]);
    expect(src).not.toMatch(/\.(insert|update|upsert|delete)\(|set_platform_rollout|add_platform_rollout|remove_platform_rollout/);
    const gate = readFileSync("lib/machines/xcell-registration-gate.ts", "utf8");
    expect(gate).not.toMatch(/\.(insert|update|upsert|delete)\(|registerStudioMachine/);
  });
});
