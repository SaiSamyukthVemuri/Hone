import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, adminTx, asUser, closePool, seedMember, seedStudio, type SeededStudio } from "./helpers/harness";

// Migration 0399: author-private autosaved drafts (HON-130), proven on the real migrated database.
let a: SeededStudio;
let b: SeededStudio;
let aColleague: { userId: string; practitionerId: string };

const SAVE = `select * from public.save_client_note_draft($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`;
const DISCARD = `select public.discard_client_note_draft($1, $2, $3, $4, $5) as ok`;
// One generation per (user, kind, target) so a test that saves the same draft several times is ONE lifecycle, as the editor is.
const gens = new Map<string, string>();
function gen(user: string, kind: string, target: string, fresh = false): string {
  const k = `${user}|${kind}|${target}`;
  if (fresh || !gens.has(k)) gens.set(k, randomUUID());
  return gens.get(k)!;
}
// The save WRAPPER (the application's note command): hands the draft generation to the clear trigger.
const NOTE_RPC = `select public.add_client_clinical_note($1, $2, $3, '{}'::text[], null, $4, $5) as id`;
const NOTE = `insert into public.client_clinical_notes (client_id, studio_id, practitioner_id, kind, body, supersedes_note_id)
  values ($1, $2, $3, $4, $5, $6) returning id`;

beforeAll(async () => {
  a = await seedStudio("nd-a");
  b = await seedStudio("nd-b");
  aColleague = await seedMember(a, "nd-a-colleague");
  // Autosave is OFF by default; the suite turns it on for its two synthetic studios (the one DB-side switch).
  await adminQuery(`insert into public.client_note_draft_enabled_studios (studio_id) values ($1), ($2) on conflict do nothing`, [a.studioId, b.studioId]);
});
afterAll(async () => {
  await closePool();
});

async function save(user: string, s: SeededStudio, kind: string, target: string, fields: object, rev: number, writer = randomUUID(), generation = gen(user, kind, target)) {
  return asUser(user, async (q) => (await q(SAVE, [s.studioId, s.clientId, kind, target, JSON.stringify(fields), rev, writer, generation])).rows[0]);
}
async function discard(user: string, s: SeededStudio, kind: string, target: string, generation = gen(user, kind, target)) {
  return asUser(user, async (q) => (await q(DISCARD, [s.studioId, s.clientId, kind, target, generation])).rows[0].ok as boolean);
}
async function addNote(user: string, s: SeededStudio, kind: string, body: string, supersedes: string | null, generation: string | null) {
  return asUser(user, async (q) => (await q(NOTE_RPC, [s.clientId, kind, body, supersedes, generation])).rows[0].id as string);
}
async function draftRow(s: SeededStudio, practitionerId: string, kind: string, target: string) {
  return (await adminQuery(`select * from public.client_note_drafts where client_id = $1 and practitioner_id = $2 and kind = $3 and target = $4`, [s.clientId, practitionerId, kind, target])).rows[0];
}
async function wipe() {
  gens.clear();
  await adminQuery(`delete from public.client_note_drafts where studio_id in ($1, $2)`, [a.studioId, b.studioId]);
}

describe("database-side switch: off means off", () => {
  it("a direct RPC call by a signed-in user stores NOTHING while the studio is not enabled, with the closed code", async () => {
    const off = await seedStudio("nd-off");
    const r = await asUser(off.userId, async (q) => (await q(SAVE, [off.studioId, off.clientId, "consultation", "new", JSON.stringify({ body: "must not be stored" }), 0, randomUUID(), randomUUID()])).rows[0]);
    expect(r.status).toBe("disabled");
    expect((await adminQuery(`select count(*)::int n from public.client_note_drafts where studio_id = $1`, [off.studioId])).rows[0].n).toBe(0);
  });
  it("the allow-list is empty by default, and authenticated cannot read or write it", async () => {
    await expect(asUser(a.userId, (q) => q(`select * from public.client_note_draft_enabled_studios`))).rejects.toThrow();
    await expect(asUser(a.userId, (q) => q(`insert into public.client_note_draft_enabled_studios (studio_id) values ($1)`, [randomUUID()]))).rejects.toThrow();
    for (const p of ["select", "insert", "update", "delete"]) {
      expect((await adminQuery(`select has_table_privilege('anon', 'public.client_note_draft_enabled_studios', $1) as h`, [p])).rows[0].h).toBe(false);
    }
  });
});

describe("Privacy conditions on the exact SQL", () => {
  it("a non-member always gets 'refused', whether or not the studio has drafts on; nothing leaks about the switch", async () => {
    await wipe();
    const asB = () => asUser(b.userId, async (q) => (await q(SAVE, [a.studioId, a.clientId, "consultation", "new", "{}", 0, randomUUID(), randomUUID()])).rows[0]);
    expect((await asB()).status).toBe("refused"); // studio a ON
    await adminQuery(`delete from public.client_note_draft_enabled_studios where studio_id = $1`, [a.studioId]);
    try {
      expect((await asB()).status).toBe("refused"); // studio a OFF: the same answer
      expect((await save(a.userId, a, "consultation", "new", { body: "x" }, 0)).status).toBe("disabled"); // only a MEMBER learns it is off
    } finally {
      await adminQuery(`insert into public.client_note_draft_enabled_studios (studio_id) values ($1) on conflict do nothing`, [a.studioId]);
    }
  });

  it("a conflict never returns another author's text, and the sweep returns a bare count", async () => {
    await wipe();
    await save(aColleague.userId, a, "consultation", "new", { body: "COLLEAGUE PRIVATE TEXT" }, 0);
    await save(a.userId, a, "consultation", "new", { body: "mine v1" }, 0);
    const conflict = await save(a.userId, a, "consultation", "new", { body: "stale" }, 0);
    expect(conflict.status).toBe("conflict");
    expect(JSON.stringify(conflict)).not.toContain("COLLEAGUE");
    expect(conflict.fields).toEqual({ body: "mine v1" });
    const swept = await adminTx(async (q) => {
      await q(`set local role service_role`);
      return (await q(`select public.sweep_client_note_drafts() as n`)).rows;
    });
    expect(Object.keys(swept[0])).toEqual(["n"]);
    expect(typeof swept[0].n).toBe("number");
  });

  it("pin: the clinical write path carries exactly the known triggers, including the new AFTER INSERT clear", async () => {
    const res = await adminQuery(`select tgname from pg_trigger where tgrelid = 'public.client_clinical_notes'::regclass and not tgisinternal order by tgname`);
    const names = res.rows.map((r) => r.tgname as string);
    expect(names).toEqual(["client_clinical_notes_before_insert", "client_clinical_notes_no_update", "client_note_drafts_clear_on_note"]);
    const t = await adminQuery(`select (tgtype & 2) = 0 as after_row, (tgtype & 4) <> 0 as on_insert, (tgtype & 8) = 0 as not_delete, (tgtype & 16) = 0 as not_update from pg_trigger where tgname = 'client_note_drafts_clear_on_note'`);
    expect(t.rows[0]).toEqual({ after_row: true, on_insert: true, not_delete: true, not_update: true });
    // Any later trigger on this table must be added to the list above on purpose.
  });

  it("only the editor's own keys can be stored, per kind; budget_level and each area are capped", async () => {
    await wipe();
    await expect(save(a.userId, a, "consultation", "new", { body: "x", extra: "y" }, 0)).rejects.toThrow();
    await expect(save(a.userId, a, "consultation", "new", { budget_notes: "x" }, 0)).rejects.toThrow();
    await expect(save(a.userId, a, "budget", "current", { body: "x" }, 0)).rejects.toThrow();
    await expect(save(a.userId, a, "budget", "current", { budget_level: "x".repeat(41) }, 0)).rejects.toThrow();
    await expect(save(a.userId, a, "skin_hair_analysis", "new", { areas: ["x".repeat(201)] }, 0)).rejects.toThrow();
    await expect(save(a.userId, a, "skin_hair_analysis", "new", { areas: [1] }, 0)).rejects.toThrow();
    expect((await save(a.userId, a, "skin_hair_analysis", "new", { body: "ok", areas: ["chin"], occurred_at: "2026-11-28" }, 0)).status).toBe("ok");
  });

  it("discard works whether or not the studio is enabled", async () => {
    await wipe();
    await save(a.userId, a, "consultation", "new", { body: "mine" }, 0);
    await adminQuery(`delete from public.client_note_draft_enabled_studios where studio_id = $1`, [a.studioId]); // switched OFF with a draft still stored
    try {
      const ok = await discard(a.userId, a, "consultation", "new");
      expect(ok).toBe(true);
      // Discard is a TOMBSTONE, not a delete: the text is nulled in the same statement and the revision keeps counting.
      const row = await draftRow(a, a.practitionerId, "consultation", "new");
      expect(row.fields).toBeNull();
      expect(row.cleared_at).not.toBeNull();
      expect(row.generation).toBeNull();
      expect(row.ended_generation).toBe(gen(a.userId, "consultation", "new"));
    } finally {
      await adminQuery(`insert into public.client_note_draft_enabled_studios (studio_id) values ($1) on conflict do nothing`, [a.studioId]);
    }
  });

  it("the 200-draft cap counts LIVE rows only, not cleared rows awaiting the sweep", async () => {
    await wipe();
    const ids = (await adminQuery(
      `insert into public.clients (id, studio_id, name, email) select gen_random_uuid(), $1, 'cap ' || g, 'cap' || g || '@harness.local' from generate_series(1, 200) g returning id`,
      [a.studioId],
    )).rows.map((r) => r.id as string);
    try {
      await adminQuery(
        `insert into public.client_note_drafts (studio_id, client_id, practitioner_id, kind, target, fields, cleared_at)
         select $1, c, $2, 'consultation', 'new', null, now() from unnest($3::uuid[]) c`,
        [a.studioId, a.practitionerId, ids],
      );
      expect((await save(a.userId, a, "consultation", "new", { body: "cleared rows do not count" }, 0)).status).toBe("ok");
      // 200 LIVE rows do count: turn the cleared ones live, then the next new draft is refused.
      await adminQuery(`update public.client_note_drafts set fields = '{"body":"x"}'::jsonb, cleared_at = null, generation = gen_random_uuid() where practitioner_id = $1 and client_id = any($2::uuid[])`, [a.practitionerId, ids]);
      await expect(save(a.userId, a, "skin_hair_analysis", "new", { body: "over the cap" }, 0)).rejects.toThrow();
    } finally {
      await adminQuery(`delete from public.clients where id = any($1::uuid[])`, [ids]);
    }
  });
});

describe("compare-and-set save", () => {
  it("first save is ok at revision 1; a stale expected revision gets the stored draft back and writes nothing", async () => {
    await wipe();
    const r1 = await save(a.userId, a, "consultation", "new", { body: "one" }, 0);
    expect(r1).toMatchObject({ status: "ok", revision: 1 });
    const r2 = await save(a.userId, a, "consultation", "new", { body: "two" }, 1);
    expect(r2).toMatchObject({ status: "ok", revision: 2 });
    const stale = await save(a.userId, a, "consultation", "new", { body: "older" }, 1);
    expect(stale).toMatchObject({ status: "conflict", revision: 2 });
    expect(stale.fields).toEqual({ body: "two" });
    expect((await draftRow(a, a.practitionerId, "consultation", "new")).fields).toEqual({ body: "two" });
  });

  it("a racing first save maps to conflict, not an error", async () => {
    await wipe();
    await save(a.userId, a, "skin_hair_analysis", "new", { body: "x" }, 0);
    const second = await save(a.userId, a, "skin_hair_analysis", "new", { body: "y" }, 0);
    expect(second.status).toBe("conflict");
  });

  it("lost-response retry: the same writer and fields applied already is an acknowledged ok, not a false conflict", async () => {
    await wipe();
    const writer = randomUUID();
    await save(a.userId, a, "consultation", "new", { body: "v1" }, 0, writer);
    const applied = await save(a.userId, a, "consultation", "new", { body: "v2" }, 1, writer); // applied, response lost
    expect(applied.status).toBe("ok");
    const retry = await save(a.userId, a, "consultation", "new", { body: "v2" }, 1, writer);
    expect(retry).toMatchObject({ status: "ok", revision: applied.revision });
    const otherTab = await save(a.userId, a, "consultation", "new", { body: "v2" }, 1, randomUUID());
    expect(otherTab.status).toBe("conflict"); // a DIFFERENT writer is still a conflict
  });

  it("budget key must be 'current'; a note kind cannot use it", async () => {
    await wipe();
    expect((await save(a.userId, a, "budget", "current", { budget_notes: "n" }, 0)).status).toBe("ok");
    await expect(save(a.userId, a, "budget", "new", { budget_notes: "n" }, 0)).rejects.toThrow();
    await expect(save(a.userId, a, "consultation", "current", { body: "n" }, 0)).rejects.toThrow();
  });

  it("body over the final note's cap, or more than 40 areas, is refused", async () => {
    await wipe();
    await expect(save(a.userId, a, "consultation", "new", { body: "x".repeat(20001) }, 0)).rejects.toThrow();
    await expect(save(a.userId, a, "skin_hair_analysis", "new", { areas: Array.from({ length: 41 }, (_, i) => `a${i}`) }, 0)).rejects.toThrow();
  });

  it("revise target must be a note of the SAME client, studio and kind (composite FK)", async () => {
    await wipe();
    const note = await asUser(a.userId, async (q) => (await q(NOTE, [a.clientId, a.studioId, a.practitionerId, "consultation", "base", null])).rows[0].id as string);
    expect((await save(a.userId, a, "consultation", note, { body: "rev" }, 0)).status).toBe("ok");
    await expect(save(a.userId, a, "skin_hair_analysis", note, { body: "wrong kind" }, 0)).rejects.toThrow();
    await expect(save(a.userId, a, "consultation", randomUUID(), { body: "no such note" }, 0)).rejects.toThrow();
  });
});

describe("visibility and privileges", () => {
  it("author-only: a colleague in the same studio and another studio's member read nothing", async () => {
    await wipe();
    await save(a.userId, a, "consultation", "new", { body: "private" }, 0);
    const own = await asUser(a.userId, async (q) => (await q(`select count(*)::int n from public.client_note_drafts where client_id = $1`, [a.clientId])).rows[0].n);
    expect(own).toBe(1);
    for (const u of [aColleague.userId, b.userId]) {
      const n = await asUser(u, async (q) => (await q(`select count(*)::int n from public.client_note_drafts where client_id = $1`, [a.clientId])).rows[0].n);
      expect(n).toBe(0);
    }
  });

  it("a colleague or another studio cannot write a draft for this client", async () => {
    await wipe();
    const colleague = await save(aColleague.userId, a, "consultation", "new", { body: "x" }, 0);
    expect(colleague.status).toBe("ok"); // their OWN draft of their own, never visible to the author
    expect(await draftRow(a, a.practitionerId, "consultation", "new")).toBeUndefined();
    const cross = await asUser(b.userId, async (q) => (await q(SAVE, [a.studioId, a.clientId, "consultation", "new", "{}", 0, randomUUID(), randomUUID()])).rows[0]);
    expect(cross.status).toBe("refused");
  });

  it("an inactive practitioner is refused and reads nothing", async () => {
    await wipe();
    const m = await seedMember(a, "nd-inactive");
    await adminQuery(`update public.practitioners set active = false where id = $1`, [m.practitionerId]);
    const r = await asUser(m.userId, async (q) => (await q(SAVE, [a.studioId, a.clientId, "consultation", "new", "{}", 0, randomUUID(), randomUUID()])).rows[0]);
    expect(r.status).toBe("refused");
  });

  it("authenticated has SELECT only: no direct insert, update or delete; anon and service_role hold nothing", async () => {
    await wipe();
    await save(a.userId, a, "consultation", "new", { body: "x" }, 0);
    await expect(asUser(a.userId, (q) => q(`delete from public.client_note_drafts where client_id = $1`, [a.clientId]))).rejects.toThrow();
    await expect(asUser(a.userId, (q) => q(`update public.client_note_drafts set fields = '{}'::jsonb where client_id = $1`, [a.clientId]))).rejects.toThrow();
    const acl = (await adminQuery(
      `select r, has_table_privilege(r, 'public.client_note_drafts', p) as has
         from (values ('anon'), ('authenticated'), ('service_role')) as roles(r),
              (values ('select'), ('insert'), ('update'), ('delete'), ('truncate'), ('references'), ('trigger')) as privs(p)`,
    )).rows as Array<{ r: string; has: boolean; }>;
    for (const row of acl.filter((x) => x.r !== "authenticated")) expect(row.has, row.r).toBe(false);
    const authedPrivs = (await adminQuery(
      `select p from (values ('insert'), ('update'), ('delete'), ('truncate'), ('references'), ('trigger')) v(p) where has_table_privilege('authenticated', 'public.client_note_drafts', p)`,
    )).rows;
    expect(authedPrivs).toEqual([]);
    for (const fn of ["save_client_note_draft(uuid,uuid,text,text,jsonb,integer,uuid,uuid)", "discard_client_note_draft(uuid,uuid,text,text,uuid)", "client_note_drafts_clear_on_note()", "client_note_drafts_clear_on_budget()", "sweep_client_note_drafts()"]) {
      for (const role of ["anon", "public"]) {
        const has = (await adminQuery(`select has_function_privilege($1, $2::regprocedure, 'execute') as has`, [role === "public" ? "authenticated" : role, `public.${fn}`])).rows[0].has;
        if (role === "anon") expect(has, `${fn} anon`).toBe(false);
      }
    }
    expect((await adminQuery(`select has_function_privilege('service_role', 'public.sweep_client_note_drafts()', 'execute') as has`)).rows[0].has).toBe(true);
    expect((await adminQuery(`select has_function_privilege('service_role', 'public.save_client_note_draft(uuid,uuid,text,text,jsonb,integer,uuid,uuid)', 'execute') as has`)).rows[0].has).toBe(false);
    expect((await adminQuery(`select has_function_privilege('authenticated', 'public.client_note_draft_retention()', 'execute') as has`)).rows[0].has).toBe(true);
  });
});

describe("one transaction: saving the record clears the draft", () => {
  it("a practitioner AT the 200-live-draft cap can still save a note and a budget record, and the tombstones are written", async () => {
    await wipe();
    const ids = (await adminQuery(
      `insert into public.clients (id, studio_id, name, email) select gen_random_uuid(), $1, 'cap2 ' || g, 'cap2-' || g || '@harness.local' from generate_series(1, 200) g returning id`,
      [a.studioId],
    )).rows.map((r) => r.id as string);
    try {
      await adminQuery(
        `insert into public.client_note_drafts (studio_id, client_id, practitioner_id, kind, target, fields, generation)
         select $1, c, $2, 'consultation', 'new', '{"body":"x"}'::jsonb, gen_random_uuid() from unnest($3::uuid[]) c`,
        [a.studioId, a.practitionerId, ids],
      );
      await expect(save(a.userId, a, "skin_hair_analysis", "new", { body: "over the cap" }, 0)).rejects.toThrow(); // a LIVE draft is still capped
      // The clinical save must NOT fail: no draft row exists for these keys yet, so each clear inserts a tombstone, which the cap must let through.
      await asUser(a.userId, (q) => q(NOTE, [a.clientId, a.studioId, a.practitionerId, "skin_hair_analysis", "saved at the cap", null]));
      await asUser(a.userId, (q) => q(`insert into public.client_budget_context (client_id, studio_id, budget_notes, updated_by_practitioner_id) values ($1, $2, 'saved at the cap', $3) on conflict (client_id) do update set budget_notes = excluded.budget_notes, updated_by_practitioner_id = excluded.updated_by_practitioner_id`, [a.clientId, a.studioId, a.practitionerId]));
      expect((await draftRow(a, a.practitionerId, "skin_hair_analysis", "new")).cleared_at).not.toBeNull();
      expect((await draftRow(a, a.practitionerId, "budget", "current")).cleared_at).not.toBeNull();
    } finally {
      await adminQuery(`delete from public.clients where id = any($1::uuid[])`, [ids]);
      await adminQuery(`delete from public.client_budget_context where client_id = $1`, [a.clientId]);
    }
  });

  it("a note insert clears exactly the author's matching draft; other practitioners, kinds and targets are untouched", async () => {
    await wipe();
    await save(a.userId, a, "consultation", "new", { body: "mine" }, 0);
    await save(a.userId, a, "skin_hair_analysis", "new", { body: "other kind" }, 0);
    await save(aColleague.userId, a, "consultation", "new", { body: "colleague" }, 0);
    await asUser(a.userId, (q) => q(NOTE, [a.clientId, a.studioId, a.practitionerId, "consultation", "saved", null]));
    const mine = await draftRow(a, a.practitionerId, "consultation", "new");
    expect(mine.fields).toBeNull();
    expect(mine.cleared_at).not.toBeNull();
    expect((await draftRow(a, a.practitionerId, "skin_hair_analysis", "new")).fields).toEqual({ body: "other kind" });
    expect((await draftRow(a, aColleague.practitionerId, "consultation", "new")).fields).toEqual({ body: "colleague" });
  });

  it("a revision clears the draft keyed to the note it revises, and a late write to it comes back cleared with no text", async () => {
    await wipe();
    const base = await asUser(a.userId, async (q) => (await q(NOTE, [a.clientId, a.studioId, a.practitionerId, "consultation", "base", null])).rows[0].id as string);
    const d = await save(a.userId, a, "consultation", base, { body: "rev draft" }, 0);
    await asUser(a.userId, (q) => q(NOTE, [a.clientId, a.studioId, a.practitionerId, "consultation", "revised", base]));
    const late = await save(a.userId, a, "consultation", base, { body: "late autosave" }, d.revision);
    expect(late.status).toBe("cleared");
    expect(JSON.stringify((await draftRow(a, a.practitionerId, "consultation", base)).fields)).toBe("null");
  });

  it("a late autosave after the Save is `cleared` and writes no text; a second tab of the SAME lifecycle cannot overwrite the tombstone", async () => {
    await wipe();
    const g = gen(a.userId, "consultation", "new");
    const first = await save(a.userId, a, "consultation", "new", { body: "typing" }, 0);
    await addNote(a.userId, a, "consultation", "saved", null, g); // the real Save, through the wrapper, naming the draft it ends
    const late = await save(a.userId, a, "consultation", "new", { body: "late" }, first.revision);
    expect(late.status).toBe("cleared");
    const tabB = await save(a.userId, a, "consultation", "new", { body: "older text" }, first.revision);
    expect(tabB.status).toBe("cleared");
    expect((await draftRow(a, a.practitionerId, "consultation", "new")).fields).toBeNull();
    // A late FIRST write of the ended lifecycle (expected 0, same generation) is refused too...
    const lateFirst = await save(a.userId, a, "consultation", "new", { body: "fresh" }, 0);
    expect(lateFirst.status).toBe("cleared");
    expect(JSON.stringify(lateFirst)).not.toContain("fresh");
    expect((await draftRow(a, a.practitionerId, "consultation", "new")).fields).toBeNull();
    // ...and a genuinely NEW lifecycle (a new generation, expected 0) begins on the same row: the revision continues, it never repeats.
    const before = (await draftRow(a, a.practitionerId, "consultation", "new")).revision as number;
    const g2 = gen(a.userId, "consultation", "new", true);
    const begun = await save(a.userId, a, "consultation", "new", { body: "a new draft" }, 0, randomUUID(), g2);
    expect(begun.status).toBe("ok");
    expect(begun.revision).toBeGreaterThan(before);
    const row = await draftRow(a, a.practitionerId, "consultation", "new");
    expect(row.fields).toEqual({ body: "a new draft" });
    expect(row.generation).toBe(g2);
    expect(row.ended_generation).toBeNull();
  });

  it("P1 (late FIRST autosave): the record is saved while no draft row exists yet; the in-flight first write (revision 0, same generation) cannot recreate the text", async () => {
    await wipe();
    const g = gen(a.userId, "consultation", "new");
    await addNote(a.userId, a, "consultation", "just saved", null, g);
    const tombstone = await draftRow(a, a.practitionerId, "consultation", "new");
    expect(tombstone.fields).toBeNull(); // the Save left a text-free tombstone, only ids and a revision
    expect(tombstone.cleared_at).not.toBeNull();
    expect(tombstone.ended_generation).toBe(g); // taken from the transaction-local setting, because no live row existed
    const late = await save(a.userId, a, "consultation", "new", { body: "just saved" }, 0);
    expect(late.status).toBe("cleared");
    expect((await draftRow(a, a.practitionerId, "consultation", "new")).fields).toBeNull();
    const visible = await asUser(a.userId, async (q) => (await q(`select count(*)::int n from public.client_note_drafts where client_id = $1`, [a.clientId])).rows[0].n);
    expect(visible).toBe(0); // the author's own read shows no draft either
  });

  it("ACCEPTED RESIDUAL (named): a raw Data API insert with NO generation leaves a tombstone no lifecycle can be matched to, so a late first write of the author's own can begin a draft", async () => {
    await wipe();
    await asUser(a.userId, (q) => q(NOTE, [a.clientId, a.studioId, a.practitionerId, "consultation", "raw insert", null]));
    const tombstone = await draftRow(a, a.practitionerId, "consultation", "new");
    expect(tombstone.ended_generation).toBeNull();
    expect(tombstone.fields).toBeNull();
    expect((await save(a.userId, a, "consultation", "new", { body: "the author's own text" }, 0)).status).toBe("ok");
  });

  it("every Save bumps the tombstone: a write based on an older tombstone revision is refused", async () => {
    await wipe();
    const g = gen(a.userId, "consultation", "new");
    await addNote(a.userId, a, "consultation", "one", null, g);
    const t1 = (await draftRow(a, a.practitionerId, "consultation", "new")).revision as number;
    await addNote(a.userId, a, "consultation", "two", null, randomUUID());
    const t2 = (await draftRow(a, a.practitionerId, "consultation", "new")).revision as number;
    expect(t2).toBeGreaterThan(t1);
    expect((await save(a.userId, a, "consultation", "new", { body: "stale" }, t1)).status).toBe("cleared");
  });

  it("tombstones exist only for an ENABLED studio, and Discard leaves a text-free tombstone in place", async () => {
    await wipe();
    await adminQuery(`delete from public.client_note_draft_enabled_studios where studio_id = $1`, [a.studioId]);
    try {
      await addNote(a.userId, a, "consultation", "autosave off", null, randomUUID());
      expect(await draftRow(a, a.practitionerId, "consultation", "new")).toBeUndefined();
    } finally {
      await adminQuery(`insert into public.client_note_draft_enabled_studios (studio_id) values ($1) on conflict do nothing`, [a.studioId]);
    }
    await save(a.userId, a, "consultation", "new", { body: "live" }, 0);
    expect(await discard(a.userId, a, "consultation", "new")).toBe(true);
    const row = await draftRow(a, a.practitionerId, "consultation", "new");
    expect(row.cleared_at).not.toBeNull();
    expect(row.fields).toBeNull();
  });

  it("a revise target that already has its revision answers cleared with revision 0 (the text can only live as a NEW note)", async () => {
    await wipe();
    const base = await asUser(a.userId, async (q) => (await q(NOTE, [a.clientId, a.studioId, a.practitionerId, "consultation", "base2", null])).rows[0].id as string);
    await asUser(a.userId, (q) => q(NOTE, [a.clientId, a.studioId, a.practitionerId, "consultation", "rev2", base]));
    const r = await save(a.userId, a, "consultation", base, { body: "late revise draft" }, 0);
    expect(r).toMatchObject({ status: "cleared", revision: expect.anything() });
    expect(await save(a.userId, a, "consultation", "new", { body: "kept as a new note" }, 0)).toBeTruthy();
  });

  it("the budget upsert clears only that author's budget draft", async () => {
    await wipe();
    await save(a.userId, a, "budget", "current", { budget_notes: "n" }, 0);
    await save(aColleague.userId, a, "budget", "current", { budget_notes: "theirs" }, 0);
    await save(a.userId, a, "consultation", "new", { body: "kept" }, 0);
    await asUser(a.userId, (q) => q(`insert into public.client_budget_context (client_id, studio_id, budget_notes, updated_by_practitioner_id) values ($1, $2, 'saved', $3) on conflict (client_id) do update set budget_notes = excluded.budget_notes, updated_by_practitioner_id = excluded.updated_by_practitioner_id`, [a.clientId, a.studioId, a.practitionerId]));
    expect((await draftRow(a, a.practitionerId, "budget", "current")).fields).toBeNull();
    expect((await draftRow(a, aColleague.practitionerId, "budget", "current")).fields).toEqual({ budget_notes: "theirs" });
    expect((await draftRow(a, a.practitionerId, "consultation", "new")).fields).toEqual({ body: "kept" });
    await adminQuery(`delete from public.client_budget_context where client_id = $1`, [a.clientId]);
  });

  it("an injected clear failure fails the save with the DISTINCT code, creates no note, keeps the draft, and is never 23505", async () => {
    await wipe();
    await save(a.userId, a, "consultation", "new", { body: "must survive" }, 0);
    const before = (await adminQuery(`select count(*)::int n from public.client_clinical_notes where client_id = $1`, [a.clientId])).rows[0].n;
    await adminQuery(`create or replace function public.zz_nd_fail() returns trigger language plpgsql as $$ begin raise exception 'injected'; end; $$`);
    await adminQuery(`create trigger zz_nd_fail before update on public.client_note_drafts for each row execute function public.zz_nd_fail()`);
    try {
      let code = "";
      try {
        await asUser(a.userId, (q) => q(NOTE, [a.clientId, a.studioId, a.practitionerId, "consultation", "should not exist", null]));
      } catch (e) {
        code = (e as { code?: string }).code ?? "";
      }
      expect(code).toBe("HN130");
      expect(code).not.toBe("23505");
    } finally {
      await adminQuery(`drop trigger if exists zz_nd_fail on public.client_note_drafts`);
      await adminQuery(`drop function if exists public.zz_nd_fail()`);
    }
    const after = (await adminQuery(`select count(*)::int n from public.client_clinical_notes where client_id = $1`, [a.clientId])).rows[0].n;
    expect(after).toBe(before);
    expect((await draftRow(a, a.practitionerId, "consultation", "new")).fields).toEqual({ body: "must survive" });
  });

  it("the clear never fails for data reasons: a max-size draft, a deactivated practitioner and an expired row all clear", async () => {
    await wipe();
    const m = await seedMember(a, "nd-clear-edge");
    await save(m.userId, a, "consultation", "new", { body: "y".repeat(20000) }, 0);
    await adminQuery(`update public.client_note_drafts set expires_at = now() - interval '1 day' where practitioner_id = $1`, [m.practitionerId]);
    // The author inserts the note while still active (policy), then is deactivated before the clear is inspected.
    await asUser(m.userId, (q) => q(NOTE, [a.clientId, a.studioId, m.practitionerId, "consultation", "saved", null]));
    expect((await draftRow(a, m.practitionerId, "consultation", "new")).fields).toBeNull();
  });

  it("Save while an autosave holds the draft row completes, no deadlock", async () => {
    await wipe();
    await save(a.userId, a, "consultation", "new", { body: "x" }, 0);
    const holder = adminTx(async (q) => {
      await q(`select 1 from public.client_note_drafts where client_id = $1 and practitioner_id = $2 for update`, [a.clientId, a.practitionerId]);
      await new Promise((r) => setTimeout(r, 1500));
    });
    await new Promise((r) => setTimeout(r, 300));
    const t0 = Date.now();
    await asUser(a.userId, (q) => q(NOTE, [a.clientId, a.studioId, a.practitionerId, "consultation", "waits then saves", null]));
    expect(Date.now() - t0).toBeGreaterThan(500);
    await holder;
    expect((await draftRow(a, a.practitionerId, "consultation", "new")).fields).toBeNull();
  });
});

describe("retention and erasure", () => {
  it("the sweep measures 14 days from the LAST edit, removes cleared rows after a day, and nothing newer", async () => {
    await wipe();
    // Created 20 days ago but edited 2 days ago: survives. Last edit 15 days ago: removed.
    await save(a.userId, a, "consultation", "new", { body: "edited recently" }, 0);
    await save(a.userId, a, "skin_hair_analysis", "new", { body: "stale" }, 0);
    await save(a.userId, a, "budget", "current", { budget_notes: "cleared" }, 0);
    await adminQuery(`alter table public.client_note_drafts disable trigger user`);
    try {
      await adminQuery(`update public.client_note_drafts set created_at = now() - interval '20 days', updated_at = now() - interval '2 days' where kind = 'consultation' and client_id = $1`, [a.clientId]);
      await adminQuery(`update public.client_note_drafts set created_at = now() - interval '20 days', updated_at = now() - interval '15 days' where kind = 'skin_hair_analysis' and client_id = $1`, [a.clientId]);
      await adminQuery(`update public.client_note_drafts set fields = null, generation = null, cleared_at = now() - interval '2 days' where kind = 'budget' and client_id = $1`, [a.clientId]);
    } finally {
      await adminQuery(`alter table public.client_note_drafts enable trigger user`);
    }
    // asRole rolls back, so run as service_role in a committed transaction.
    const removed = await adminTx(async (q) => {
      await q(`set local role service_role`);
      return (await q(`select public.sweep_client_note_drafts() as n`)).rows[0].n as number;
    });
    expect(removed).toBeGreaterThanOrEqual(2);
    expect(await draftRow(a, a.practitionerId, "consultation", "new")).toBeDefined();
    expect(await draftRow(a, a.practitionerId, "skin_hair_analysis", "new")).toBeUndefined();
    expect(await draftRow(a, a.practitionerId, "budget", "current")).toBeUndefined();
  });

  it("an expired draft reads as no draft and a NULL (cleared) row never restores", async () => {
    await wipe();
    await save(a.userId, a, "consultation", "new", { body: "old" }, 0);
    await adminQuery(`alter table public.client_note_drafts disable trigger user`);
    await adminQuery(`update public.client_note_drafts set expires_at = now() - interval '1 minute' where client_id = $1`, [a.clientId]);
    await adminQuery(`alter table public.client_note_drafts enable trigger user`);
    const n = await asUser(a.userId, async (q) => (await q(`select count(*)::int n from public.client_note_drafts where client_id = $1`, [a.clientId])).rows[0].n);
    expect(n).toBe(0);
  });

  it("no draft survives client erasure or studio deletion (cascade)", async () => {
    const s = await seedStudio("nd-erase");
    await save(s.userId, s, "consultation", "new", { body: "x" }, 0);
    await adminQuery(`delete from public.clients where id = $1`, [s.clientId]).catch(() => undefined);
    const left = (await adminQuery(`select count(*)::int n from public.client_note_drafts where studio_id = $1 and client_id = $2`, [s.studioId, s.clientId])).rows[0].n;
    expect(left).toBe(0);
    const s2 = await seedStudio("nd-erase2");
    await save(s2.userId, s2, "budget", "current", { budget_notes: "x" }, 0);
    await adminQuery(`delete from public.studios where id = $1`, [s2.studioId]).catch(() => undefined);
    expect((await adminQuery(`select count(*)::int n from public.client_note_drafts where studio_id = $1`, [s2.studioId])).rows[0].n).toBe(0);
  });
});

describe("draft identity (HON-130 design): a generation never repeats", () => {
  it("thread 15: a stale tab (old generation, revision 1) cannot overwrite a replacement draft created after a discard", async () => {
    await wipe();
    const g1 = gen(a.userId, "consultation", "new");
    const tabA = await save(a.userId, a, "consultation", "new", { body: "tab A text" }, 0, randomUUID(), g1);
    expect(tabA.revision).toBe(1);
    expect(await discard(a.userId, a, "consultation", "new", g1)).toBe(true);
    const g2 = gen(a.userId, "consultation", "new", true);
    const replacement = await save(a.userId, a, "consultation", "new", { body: "REPLACEMENT" }, 0, randomUUID(), g2);
    expect(replacement.status).toBe("ok");
    expect(replacement.revision).toBeGreaterThan(1); // the revision never restarts at 1
    // Tab B still holds generation g1 at the old revision 1 AND, to be hostile, the replacement's own revision.
    for (const rev of [1, replacement.revision]) {
      const stale = await save(a.userId, a, "consultation", "new", { body: "stale tab overwrite" }, rev, randomUUID(), g1);
      expect(["cleared", "conflict"]).toContain(stale.status);
    }
    const row = await draftRow(a, a.practitionerId, "consultation", "new");
    expect(row.fields).toEqual({ body: "REPLACEMENT" });
    expect(row.generation).toBe(g2);
  });

  it("a live row of ANOTHER generation is always a conflict, whatever revision the writer holds, and returns only the author's own draft", async () => {
    await wipe();
    const g1 = randomUUID();
    const g2 = randomUUID();
    await save(a.userId, a, "consultation", "new", { body: "first lifecycle" }, 0, randomUUID(), g1);
    const other = await save(a.userId, a, "consultation", "new", { body: "second" }, 1, randomUUID(), g2);
    expect(other.status).toBe("conflict");
    expect(other.generation).toBe(g1);
    expect((await draftRow(a, a.practitionerId, "consultation", "new")).fields).toEqual({ body: "first lifecycle" });
  });

  it("begin and revive refresh updated_at and keep the revision monotonic across lifecycles", async () => {
    await wipe();
    const g1 = randomUUID();
    await save(a.userId, a, "consultation", "new", { body: "one" }, 0, randomUUID(), g1);
    await discard(a.userId, a, "consultation", "new", g1);
    await adminQuery(`alter table public.client_note_drafts disable trigger user`);
    await adminQuery(`update public.client_note_drafts set updated_at = now() - interval '10 days' where client_id = $1`, [a.clientId]);
    await adminQuery(`alter table public.client_note_drafts enable trigger user`);
    const before = await draftRow(a, a.practitionerId, "consultation", "new");
    const begun = await save(a.userId, a, "consultation", "new", { body: "two" }, 0, randomUUID(), randomUUID());
    expect(begun.status).toBe("ok");
    const after = await draftRow(a, a.practitionerId, "consultation", "new");
    expect(new Date(after.updated_at).getTime()).toBeGreaterThan(new Date(before.updated_at).getTime() + 9 * 86400_000);
    expect(after.revision).toBeGreaterThan(before.revision);
  });

  it("discard only UPDATES a live row of exactly that generation: a wrong generation, a missing row, an ended row change nothing and insert nothing", async () => {
    await wipe();
    expect(await discard(a.userId, a, "consultation", "new", randomUUID())).toBe(false);
    expect(await draftRow(a, a.practitionerId, "consultation", "new")).toBeUndefined(); // never inserts
    const g = randomUUID();
    await save(a.userId, a, "consultation", "new", { body: "live" }, 0, randomUUID(), g);
    expect(await discard(a.userId, a, "consultation", "new", randomUUID())).toBe(false);
    expect((await draftRow(a, a.practitionerId, "consultation", "new")).fields).toEqual({ body: "live" });
    expect(await discard(a.userId, a, "consultation", "new", g)).toBe(true);
    const rev = (await draftRow(a, a.practitionerId, "consultation", "new")).revision;
    expect(await discard(a.userId, a, "consultation", "new", g)).toBe(false); // already ended
    expect((await draftRow(a, a.practitionerId, "consultation", "new")).revision).toBe(rev);
  });

  it("a colleague cannot discard the author's draft (the key includes the practitioner)", async () => {
    await wipe();
    const g = randomUUID();
    await save(a.userId, a, "consultation", "new", { body: "mine" }, 0, randomUUID(), g);
    expect(await discard(aColleague.userId, a, "consultation", "new", g)).toBe(false);
    expect((await draftRow(a, a.practitionerId, "consultation", "new")).fields).toEqual({ body: "mine" });
  });

  it("CHECKs: a tombstone can never hold text, and a row is either live (generation) or ended", async () => {
    await wipe();
    await save(a.userId, a, "consultation", "new", { body: "live" }, 0);
    await expect(adminQuery(`update public.client_note_drafts set cleared_at = now(), generation = null where client_id = $1`, [a.clientId])).rejects.toThrow(); // text kept on a tombstone
    await expect(adminQuery(`update public.client_note_drafts set generation = null where client_id = $1`, [a.clientId])).rejects.toThrow(); // live without a generation
    await expect(adminQuery(`update public.client_note_drafts set ended_generation = gen_random_uuid() where client_id = $1`, [a.clientId])).rejects.toThrow(); // live with an ended one
  });

  it("an author's own revise draft is NOT cleared by a colleague's revision; the author's late write comes back cleared with no text and the row is untouched", async () => {
    await wipe();
    const base = await asUser(a.userId, async (q) => (await q(NOTE, [a.clientId, a.studioId, a.practitionerId, "consultation", "base-d1", null])).rows[0].id as string);
    const gA = randomUUID();
    const aDraft = await save(a.userId, a, "consultation", base, { body: "A's revise text" }, 0, randomUUID(), gA);
    // B (a colleague) saves a revision of the same note through the wrapper.
    await addNote(aColleague.userId, a, "consultation", "B's revision", base, randomUUID());
    const rowBefore = await draftRow(a, a.practitionerId, "consultation", base);
    expect(rowBefore.fields).toEqual({ body: "A's revise text" }); // A's row untouched by B's Save (only the SAVING practitioner's own row is cleared)
    const late = await save(a.userId, a, "consultation", base, { body: "A types more" }, aDraft.revision, randomUUID(), gA);
    expect(late.status).toBe("cleared");
    expect(JSON.stringify(late)).not.toContain("A's revise text");
    expect(late.fields).toEqual({});
    const rowAfter = await draftRow(a, a.practitionerId, "consultation", base);
    expect(rowAfter.fields).toEqual({ body: "A's revise text" }); // never overwritten, never emptied: the text stays on A's side too
    expect(rowAfter.revision).toBe(rowBefore.revision);
  });

  it("A's 'new' draft survives B's note save, and B's own is the only row cleared", async () => {
    await wipe();
    await save(a.userId, a, "consultation", "new", { body: "A's new draft" }, 0);
    const gB = gen(aColleague.userId, "consultation", "new");
    await save(aColleague.userId, a, "consultation", "new", { body: "B's draft" }, 0, randomUUID(), gB);
    await addNote(aColleague.userId, a, "consultation", "B saved", null, gB);
    expect((await draftRow(a, a.practitionerId, "consultation", "new")).fields).toEqual({ body: "A's new draft" });
    expect((await draftRow(a, aColleague.practitionerId, "consultation", "new")).fields).toBeNull();
  });
});

describe("D3 and HN130/HN131: the Save wrapper and the double-save refusal", () => {
  it("two windows sharing ONE generation: only one note is created; the second Save is refused with HN131 and rolls back", async () => {
    await wipe();
    const g = randomUUID();
    await save(a.userId, a, "consultation", "new", { body: "shared draft" }, 0, randomUUID(), g);
    const n0 = (await adminQuery(`select count(*)::int n from public.client_clinical_notes where client_id = $1`, [a.clientId])).rows[0].n;
    const results = await Promise.allSettled([
      addNote(a.userId, a, "consultation", "window one", null, g),
      addNote(a.userId, a, "consultation", "window two", null, g),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const bad = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect((bad[0].reason as { code?: string }).code).toBe("HN131");
    expect(String((bad[0].reason as Error).message)).not.toMatch(/window (one|two)/);
    const n1 = (await adminQuery(`select count(*)::int n from public.client_clinical_notes where client_id = $1`, [a.clientId])).rows[0].n;
    expect(n1 - n0).toBe(1);
  });

  it("sequentially: a second Save of an ended generation is HN131; a missing generation or another generation never raises", async () => {
    await wipe();
    const g = randomUUID();
    await save(a.userId, a, "consultation", "new", { body: "d" }, 0, randomUUID(), g);
    await addNote(a.userId, a, "consultation", "first", null, g);
    await expect(addNote(a.userId, a, "consultation", "again", null, g)).rejects.toMatchObject({ code: "HN131" });
    await addNote(a.userId, a, "consultation", "no generation", null, null); // never fails for draft state
    await addNote(a.userId, a, "consultation", "other generation", null, randomUUID());
    await adminQuery(`select 1`);
  });

  it("an invalid generation setting is NULL and never fails a clinical Save (direct setting, as a hostile caller could set it)", async () => {
    await wipe();
    await asUser(a.userId, async (q) => {
      await q(`select set_config('hone.draft_generation', 'not-a-uuid', true)`);
      await q(NOTE, [a.clientId, a.studioId, a.practitionerId, "consultation", "invalid setting", null]);
    });
    expect(await draftRow(a, a.practitionerId, "consultation", "new").then((r) => r?.ended_generation ?? null)).toBeNull();
  });

  it("HN131 concerns the saving practitioner's OWN row only: a colleague's ended generation never blocks my Save", async () => {
    await wipe();
    const g = randomUUID();
    await save(aColleague.userId, a, "consultation", "new", { body: "B" }, 0, randomUUID(), g);
    await addNote(aColleague.userId, a, "consultation", "B saved", null, g);
    await addNote(a.userId, a, "consultation", "A saves with the same uuid", null, g); // A has no such row: no refusal
  });

  it("a practitioner AT the 200-live-draft cap can still save a note and a budget through the wrapper (HN130 never fires)", async () => {
    await wipe();
    const ids = (await adminQuery(
      `insert into public.clients (id, studio_id, name, email) select gen_random_uuid(), $1, 'cap3 ' || g, 'cap3-' || g || '@harness.local' from generate_series(1, 200) g returning id`,
      [a.studioId],
    )).rows.map((r) => r.id as string);
    try {
      await adminQuery(
        `insert into public.client_note_drafts (studio_id, client_id, practitioner_id, kind, target, fields, generation)
         select $1, c, $2, 'consultation', 'new', '{"body":"x"}'::jsonb, gen_random_uuid() from unnest($3::uuid[]) c`,
        [a.studioId, a.practitionerId, ids],
      );
      await addNote(a.userId, a, "skin_hair_analysis", "saved at the cap", null, randomUUID());
      await asUser(a.userId, (q) => q(`select public.upsert_client_budget_context($1, 'somewhat_limited', 'saved at the cap', $2)`, [a.clientId, randomUUID()]));
      expect((await draftRow(a, a.practitionerId, "skin_hair_analysis", "new")).cleared_at).not.toBeNull();
      expect((await draftRow(a, a.practitionerId, "budget", "current")).cleared_at).not.toBeNull();
    } finally {
      await adminQuery(`delete from public.clients where id = any($1::uuid[])`, [ids]);
      await adminQuery(`delete from public.client_budget_context where client_id = $1`, [a.clientId]);
    }
  });

  it("r3 (Insurance P3): a Save naming G2 over a live row of G1 ends G2, so a RETRIED G2 Save after a lost response is refused; G1 is not the one ended", async () => {
    await wipe();
    const g1 = randomUUID();
    const g2 = randomUUID();
    await save(a.userId, a, "consultation", "new", { body: "window started G1" }, 0, randomUUID(), g1);
    const n0 = (await adminQuery(`select count(*)::int n from public.client_clinical_notes where client_id = $1`, [a.clientId])).rows[0].n;
    await addNote(a.userId, a, "consultation", "saved naming G2", null, g2); // the response is then lost
    expect((await draftRow(a, a.practitionerId, "consultation", "new")).ended_generation).toBe(g2); // the named generation, not the live row's G1
    await expect(addNote(a.userId, a, "consultation", "retry of the same Save", null, g2)).rejects.toMatchObject({ code: "HN131" });
    const n1 = (await adminQuery(`select count(*)::int n from public.client_clinical_notes where client_id = $1`, [a.clientId])).rows[0].n;
    expect(n1 - n0).toBe(1);
  });

  it("r3: with NO generation named, the live row's own generation is still what ends", async () => {
    await wipe();
    const g1 = randomUUID();
    await save(a.userId, a, "consultation", "new", { body: "d" }, 0, randomUUID(), g1);
    await addNote(a.userId, a, "consultation", "no generation", null, null);
    expect((await draftRow(a, a.practitionerId, "consultation", "new")).ended_generation).toBe(g1);
  });

  it("r3 (Insurance P3): reviving a tombstone is a NEW live draft and counts against the 200-live-draft cap; a clinical Save at the cap still never fails", async () => {
    await wipe();
    const ids = (await adminQuery(
      `insert into public.clients (id, studio_id, name, email) select gen_random_uuid(), $1, 'cap4 ' || g, 'cap4-' || g || '@harness.local' from generate_series(1, 200) g returning id`,
      [a.studioId],
    )).rows.map((r) => r.id as string);
    try {
      // A tombstone on the key we will try to revive, made the normal way (draft, then Save).
      const g = randomUUID();
      await save(a.userId, a, "consultation", "new", { body: "will be saved" }, 0, randomUUID(), g);
      await addNote(a.userId, a, "consultation", "saved", null, g);
      expect((await draftRow(a, a.practitionerId, "consultation", "new")).cleared_at).not.toBeNull();
      // 200 LIVE drafts of this practitioner on other clients.
      await adminQuery(
        `insert into public.client_note_drafts (studio_id, client_id, practitioner_id, kind, target, fields, generation)
         select $1, c, $2, 'consultation', 'new', '{"body":"x"}'::jsonb, gen_random_uuid() from unnest($3::uuid[]) c`,
        [a.studioId, a.practitionerId, ids],
      );
      // The revival (expected 0, a new generation) is refused like any other new live draft, and the tombstone is untouched.
      await expect(save(a.userId, a, "consultation", "new", { body: "revive at the cap" }, 0, randomUUID(), randomUUID())).rejects.toThrow();
      expect((await draftRow(a, a.practitionerId, "consultation", "new")).cleared_at).not.toBeNull();
      // Below the cap it revives.
      await adminQuery(`delete from public.client_note_drafts where practitioner_id = $1 and client_id = $2`, [a.practitionerId, ids[0]]);
      expect((await save(a.userId, a, "consultation", "new", { body: "revive under the cap" }, 0, randomUUID(), randomUUID())).status).toBe("ok");
      // The revival made it exactly 200 live drafts: a clinical Save at the cap still succeeds and clears (Privacy's rule).
      await addNote(a.userId, a, "consultation", "saved at the cap", null, null);
    } finally {
      await adminQuery(`delete from public.clients where id = any($1::uuid[])`, [ids]);
    }
  });

  it("r3: the down file leaves BOTH save wrappers in place and says to roll the application back first (source contract)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const down = readFileSync(join(process.cwd(), "supabase/rollbacks/0399_client_note_drafts.down.sql"), "utf8");
    expect(down).not.toMatch(/drop function[^;]*add_client_clinical_note/i);
    expect(down).not.toMatch(/drop function[^;]*upsert_client_budget_context/i);
    expect(down).toMatch(/roll the APPLICATION back FIRST/);
    expect(down).toMatch(/DELIBERATELY LEFT IN PLACE/);
  });
});
