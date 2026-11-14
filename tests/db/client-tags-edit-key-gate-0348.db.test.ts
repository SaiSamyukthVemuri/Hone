import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, asRole, asUser, closePool, seedMember, seedStudio, type SeededStudio } from "./helpers/harness";

// 0348: client tags can be written only by someone the engine allows client.edit_tags. Synthetic data only.
// "Restricted" = the key is released AND the practitioner role is stored Off for that studio (the same activation shape 0343 uses).

const KEY = "client.edit_tags";
let saved: Array<{ key: string; released_at: string | null; release_tag: string; release_kind: string }> = [];

beforeAll(async () => {
  saved = (await adminQuery("select key, released_at::text released_at, release_tag, release_kind from public.permission_key_release where key = any($1)", [[KEY, "client.view_tags"]])).rows;
  for (const k of [KEY, "client.view_tags"]) {
    await adminQuery("delete from public.permission_key_release where key=$1", [k]);
    await adminQuery("insert into public.permission_key_release(key,released_at,release_tag,release_kind) values ($1,'2000-01-01T00:00:00Z','T0348','full')", [k]);
  }
});
afterAll(async () => {
  await adminQuery("delete from public.permission_key_release where key = any($1)", [[KEY, "client.view_tags"]]);
  for (const r of saved) await adminQuery("insert into public.permission_key_release(key,released_at,release_tag,release_kind) values ($1,$2,$3,$4)", [r.key, r.released_at, r.release_tag, r.release_kind]);
  await closePool();
});

async function setStored(studioId: string, key: string, scope: "studio" | "off"): Promise<void> {
  await adminQuery(
    "insert into public.studio_role_permissions(studio_id,role,key,scope,set_at) values ($1,'practitioner',$2,$3, now()) on conflict (studio_id,role,key) do update set scope=$3, set_at=now()",
    [studioId, key, scope],
  );
}
type Fix = { s: SeededStudio; member: { userId: string; practitionerId: string } };
async function seed(label: string, restricted = false): Promise<Fix> {
  const s = await seedStudio(label);
  const member = await seedMember(s, `${label}m`);
  if (restricted) await setStored(s.studioId, KEY, "off");
  return { s, member };
}
async function attempt(userId: string, q: string, p: unknown[]): Promise<string | null> {
  try { await asUser(userId, async (run) => { await run(q, p); }); return null; } catch (e) { return String(e); }
}
const insTag = (f: Fix, id = randomUUID()): [string, unknown[]] => [
  "insert into public.client_tags (id, studio_id, client_id, label) values ($1,$2,$3,'synthetic')", [id, f.s.studioId, f.s.clientId],
];
const rmTag = (f: Fix, id: string, by: string): [string, unknown[]] => [
  "update public.client_tags set deleted_at = now(), deleted_by = $3 where id = $1 and studio_id = $2 and deleted_at is null", [id, f.s.studioId, by],
];
const seedTag = async (f: Fix): Promise<string> => {
  const id = randomUUID();
  await adminQuery("insert into public.client_tags (id, studio_id, client_id, label, created_by) values ($1,$2,$3,'seed',$4)", [id, f.s.studioId, f.s.clientId, f.s.practitionerId]);
  return id;
};
const tagState = async (id: string) => (await adminQuery("select label, deleted_at from public.client_tags where id=$1", [id])).rows[0];
const count = async (f: Fix) => (await adminQuery("select count(*)::int n from public.client_tags where client_id=$1", [f.s.clientId])).rows[0].n as number;
const DENIED = /row-level security|permission denied/i;

describe("0348 default: nothing narrowed, nothing changes", () => {
  it("a practitioner with the key unset can add and remove a tag, exactly as before", async () => {
    const f = await seed("t48-default");
    expect(await attempt(f.member.userId, ...insTag(f))).toBeNull();
    expect(await count(f)).toBe(1);
    const id = await seedTag(f);
    expect(await attempt(f.member.userId, ...rmTag(f, id, f.member.practitionerId))).toBeNull();
    expect((await tagState(id)).deleted_at).not.toBeNull();
  });
  it("the owner can always add and remove", async () => {
    const f = await seed("t48-owner");
    expect(await attempt(f.s.userId, ...insTag(f))).toBeNull();
    const id = await seedTag(f);
    expect(await attempt(f.s.userId, ...rmTag(f, id, f.s.practitionerId))).toBeNull();
  });
});

describe("0348 restricted: the key is Off for practitioners", () => {
  it("a restricted practitioner cannot add a tag (nothing is written)", async () => {
    const f = await seed("t48-r-ins", true);
    expect(await attempt(f.member.userId, ...insTag(f))).toMatch(DENIED);
    expect(await count(f)).toBe(0);
  });
  it("a restricted practitioner cannot remove a tag (the row is unchanged)", async () => {
    const f = await seed("t48-r-rm", true);
    const id = await seedTag(f);
    const before = await tagState(id);
    await attempt(f.member.userId, ...rmTag(f, id, f.member.practitionerId)); // an UPDATE filtered to zero rows by the policy: no error, no change
    expect(await tagState(id)).toEqual(before);
    expect(before.deleted_at).toBeNull();
  });
  it("a restricted practitioner cannot rename a tag either", async () => {
    const f = await seed("t48-r-ren", true);
    const id = await seedTag(f);
    await attempt(f.member.userId, "update public.client_tags set label = 'renamed' where id = $1", [id]);
    expect((await tagState(id)).label).toBe("seed");
  });
  it("the same practitioner can still READ the tags (read is a separate permission and is not changed here)", async () => {
    const f = await seed("t48-r-read", true);
    const id = await seedTag(f);
    const r = await asUser(f.member.userId, async (run) => (await run("select id from public.client_tags where id=$1", [id])).rows);
    expect(r.length).toBe(1);
  });
  it("the owner is not narrowed by the practitioner setting", async () => {
    const f = await seed("t48-r-owner", true);
    expect(await attempt(f.s.userId, ...insTag(f))).toBeNull();
  });
  it("the setting is per studio: another studio's practitioner is unaffected", async () => {
    const a = await seed("t48-iso-a", true);
    const b = await seed("t48-iso-b", false);
    expect(await attempt(a.member.userId, ...insTag(a))).toMatch(DENIED);
    expect(await attempt(b.member.userId, ...insTag(b))).toBeNull();
  });
  it("turning the key back on restores writing (the stored value is what decides)", async () => {
    const f = await seed("t48-r-back", true);
    expect(await attempt(f.member.userId, ...insTag(f))).toMatch(DENIED);
    await setStored(f.s.studioId, KEY, "studio");
    expect(await attempt(f.member.userId, ...insTag(f))).toBeNull();
  });
});

describe("0348 other paths are untouched", () => {
  it("the service role still writes tags whatever the practitioner setting", async () => {
    const f = await seed("t48-svc", true);
    const n = await asRole("service_role", async (q) => {
      await q("insert into public.client_tags (studio_id, client_id, label) values ($1,$2,'svc')", [f.s.studioId, f.s.clientId]);
      return (await q("select count(*)::int n from public.client_tags where client_id=$1", [f.s.clientId])).rows[0].n as number;
    });
    expect(n).toBe(1);
  });
  it("a member of another studio cannot write this studio's tags (isolation still holds)", async () => {
    const a = await seed("t48-x-a");
    const b = await seed("t48-x-b");
    expect(await attempt(b.member.userId, "insert into public.client_tags (studio_id, client_id, label) values ($1,$2,'x')", [a.s.studioId, a.s.clientId])).toMatch(DENIED);
  });
  it("DELETE stays closed for members, as before", async () => {
    const f = await seed("t48-del");
    const id = await seedTag(f);
    await attempt(f.member.userId, "delete from public.client_tags where id=$1", [id]);
    expect(await tagState(id)).toBeDefined();
  });
  it("a studio with no recorded policy row behaves as the existing-studio default (writes allowed while the key is unset)", async () => {
    const f = await seed("t48-unseeded");
    await adminQuery("delete from public.studio_permission_policy where studio_id=$1", [f.s.studioId]);
    expect(await attempt(f.member.userId, ...insTag(f))).toBeNull();
    expect(await count(f)).toBe(1);
  });
});

describe("0348 census", () => {
  it("exactly one INSERT and one UPDATE policy on client_tags name the key, and no DELETE or ALL policy exists", async () => {
    const r = (await adminQuery(
      `select polcmd, pg_get_expr(polqual, polrelid) q, pg_get_expr(polwithcheck, polrelid) w from pg_policy where polrelid = 'public.client_tags'::regclass order by polcmd`,
    )).rows;
    const cmds = r.map((x: { polcmd: string }) => x.polcmd).sort();
    expect(cmds).toEqual(["a", "r", "w"]);
    for (const x of r.filter((y: { polcmd: string }) => y.polcmd !== "r")) expect(`${x.q ?? ""} ${x.w ?? ""}`).toMatch(/has_studio_permission[\s\S]*client\.edit_tags/);
    const sel = r.find((y: { polcmd: string }) => y.polcmd === "r");
    expect(`${sel.q ?? ""}`).not.toMatch(/has_studio_permission/);
  });
});
