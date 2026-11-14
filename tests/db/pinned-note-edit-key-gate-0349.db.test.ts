import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, asRole, asUser, closePool, seedMember, seedStudio, type SeededStudio } from "./helpers/harness";

// 0349: editing a pinned caution through edit_client_pinned_note requires client.edit_allergies_cautions. Synthetic data only.
const KEY = "client.edit_allergies_cautions";
const PREREQ = "client.view_allergies_cautions";
let saved: Array<{ key: string; released_at: string | null; release_tag: string; release_kind: string }> = [];
beforeAll(async () => {
  saved = (await adminQuery("select key, released_at::text released_at, release_tag, release_kind from public.permission_key_release where key = any($1)", [[KEY, PREREQ]])).rows;
  for (const k of [KEY, PREREQ]) {
    await adminQuery("delete from public.permission_key_release where key=$1", [k]);
    await adminQuery("insert into public.permission_key_release(key,released_at,release_tag,release_kind) values ($1,'2000-01-01T00:00:00Z','T0349','full')", [k]);
  }
});
afterAll(async () => {
  await adminQuery("delete from public.permission_key_release where key = any($1)", [[KEY, PREREQ]]);
  for (const r of saved) await adminQuery("insert into public.permission_key_release(key,released_at,release_tag,release_kind) values ($1,$2,$3,$4)", [r.key, r.released_at, r.release_tag, r.release_kind]);
  await closePool();
});
async function setStored(studioId: string, scope: "studio" | "off"): Promise<void> {
  await adminQuery(
    "insert into public.studio_role_permissions(studio_id,role,key,scope,set_at) values ($1,'practitioner',$2,$3, now()) on conflict (studio_id,role,key) do update set scope=$3, set_at=now()",
    [studioId, KEY, scope],
  );
}
type Fix = { s: SeededStudio; member: { userId: string; practitionerId: string }; noteId: string };
async function seed(label: string, restricted = false, author: "member" | "owner" = "member"): Promise<Fix> {
  const s = await seedStudio(label);
  const member = await seedMember(s, `${label}m`);
  if (restricted) await setStored(s.studioId, "off");
  const noteId = randomUUID();
  await adminQuery("insert into public.client_pinned_notes (id, client_id, studio_id, text, created_by_practitioner_id) values ($1,$2,$3,'ORIG',$4)", [
    noteId, s.clientId, s.studioId, author === "member" ? member.practitionerId : s.practitionerId,
  ]);
  return { s, member, noteId };
}
const edit = (userId: string, f: Fix, text = "EDITED", studio = f.s.studioId) =>
  asUser(userId, async (q) => (await q("select public.edit_client_pinned_note($1,$2,$3,'ORIG',$4) r", [studio, f.s.clientId, f.noteId, text])).rows[0].r as boolean);
const noteText = async (f: Fix) => (await adminQuery("select text from public.client_pinned_notes where id=$1", [f.noteId])).rows[0].text as string;
const auditCount = async (f: Fix) => (await adminQuery("select count(*)::int n from public.audit_logs where entity_id=$1 and action='pinned_note_edited'", [f.noteId])).rows[0].n as number;

describe("0349 default: nothing narrowed, nothing changes", () => {
  it("an author with the key unset edits their own note, and the audit row is written", async () => {
    const f = await seed("t49-def");
    expect(await edit(f.member.userId, f)).toBe(true);
    expect(await noteText(f)).toBe("EDITED");
    expect(await auditCount(f)).toBe(1);
  });
  it("the owner edits any note", async () => {
    const f = await seed("t49-own");
    expect(await edit(f.s.userId, f)).toBe(true);
    expect(await noteText(f)).toBe("EDITED");
  });
  it("a non-owner still cannot edit someone else's note (the author rule is unchanged)", async () => {
    const f = await seed("t49-auth", false, "owner");
    expect(await edit(f.member.userId, f)).toBe(false);
    expect(await noteText(f)).toBe("ORIG");
  });
});

describe("0349 restricted: the allergies-and-cautions edit key is Off for practitioners", () => {
  it("the author is refused: false, the note is unchanged, no audit row", async () => {
    const f = await seed("t49-r1", true);
    expect(await edit(f.member.userId, f)).toBe(false);
    expect(await noteText(f)).toBe("ORIG");
    expect(await auditCount(f)).toBe(0);
  });
  it("the refusal looks like a missing note (same answer), so nothing is disclosed", async () => {
    const f = await seed("t49-r2", true);
    const missing = await asUser(f.member.userId, async (q) => (await q("select public.edit_client_pinned_note($1,$2,$3,'ORIG','X') r", [f.s.studioId, f.s.clientId, randomUUID()])).rows[0].r);
    expect(await edit(f.member.userId, f)).toBe(missing);
  });
  it("the owner is not narrowed", async () => {
    const f = await seed("t49-r3", true);
    expect(await edit(f.s.userId, f)).toBe(true);
  });
  it("the setting is per studio", async () => {
    const a = await seed("t49-iso-a", true);
    const b = await seed("t49-iso-b", false);
    expect(await edit(a.member.userId, a)).toBe(false);
    expect(await edit(b.member.userId, b)).toBe(true);
  });
  it("turning the key back on restores editing", async () => {
    const f = await seed("t49-back", true);
    expect(await edit(f.member.userId, f)).toBe(false);
    await setStored(f.s.studioId, "studio");
    expect(await edit(f.member.userId, f)).toBe(true);
  });
});

describe("0349 the key is its own: the clinical-record key does not decide this edit", () => {
  it("clinical-record Off does not block a pinned-caution edit while the safety edit key is on", async () => {
    const f = await seed("t49-indep");
    await adminQuery("insert into public.permission_key_release(key,released_at,release_tag,release_kind) values ('clin.view_records','2000-01-01T00:00:00Z','T0349','full') on conflict (key) do update set released_at='2000-01-01T00:00:00Z'");
    await adminQuery("insert into public.studio_role_permissions(studio_id,role,key,scope,set_at) values ($1,'practitioner','clin.view_records','off', now()) on conflict (studio_id,role,key) do update set scope='off', set_at=now()", [f.s.studioId]);
    expect(await edit(f.member.userId, f)).toBe(true);
    await adminQuery("delete from public.permission_key_release where key='clin.view_records'");
  });
});

describe("0349 other behaviour is unchanged", () => {
  it("a member of another studio gets false for this studio's note", async () => {
    const a = await seed("t49-x-a");
    const b = await seed("t49-x-b");
    expect(await edit(b.member.userId, a)).toBe(false);
    expect(await noteText(a)).toBe("ORIG");
  });
  it("an inactive practitioner gets false", async () => {
    const f = await seed("t49-inact");
    await adminQuery("update public.practitioners set active=false where id=$1", [f.member.practitionerId]);
    expect(await edit(f.member.userId, f)).toBe(false);
  });
  it("text length bounds and a stale original are still refused", async () => {
    const f = await seed("t49-len");
    expect(await edit(f.member.userId, f, "")).toBe(false);
    expect(await edit(f.member.userId, f, "x".repeat(201))).toBe(false);
    expect(await asUser(f.member.userId, async (q) => (await q("select public.edit_client_pinned_note($1,$2,$3,'STALE','Y') r", [f.s.studioId, f.s.clientId, f.noteId])).rows[0].r)).toBe(false);
  });
});

describe("0349 posture", () => {
  it("only authenticated may execute the function; anon and service_role may not; it is still SECURITY DEFINER with a fixed search_path", async () => {
    const r = (await adminQuery(
      `select p.prosecdef, p.proconfig::text cfg,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') a, has_function_privilege('anon', p.oid, 'EXECUTE') n, has_function_privilege('service_role', p.oid, 'EXECUTE') s
         from pg_proc p where p.oid = 'public.edit_client_pinned_note(uuid,uuid,uuid,text,text)'::regprocedure`,
    )).rows[0];
    expect(r).toMatchObject({ prosecdef: true, a: true, n: false, s: false });
    expect(r.cfg).toMatch(/search_path/);
    await expect(asRole("anon", (q) => q("select public.edit_client_pinned_note($1,$1,$1,'a','b')", [randomUUID()]))).rejects.toThrow(/permission denied/i);
  });
});
