import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, adminTx, asUser, closePool, seedMember, seedStudio, type SeededStudio } from "./helpers/harness";

// Migration 0399: author-private autosaved drafts (HON-130), proven on the real migrated database.
let a: SeededStudio;
let b: SeededStudio;
let aColleague: { userId: string; practitionerId: string };

const SAVE = `select * from public.save_client_note_draft($1, $2, $3, $4, $5::jsonb, $6, $7)`;
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

async function save(user: string, s: SeededStudio, kind: string, target: string, fields: object, rev: number, writer = randomUUID()) {
  return asUser(user, async (q) => (await q(SAVE, [s.studioId, s.clientId, kind, target, JSON.stringify(fields), rev, writer])).rows[0]);
}
async function draftRow(s: SeededStudio, practitionerId: string, kind: string, target: string) {
  return (await adminQuery(`select * from public.client_note_drafts where client_id = $1 and practitioner_id = $2 and kind = $3 and target = $4`, [s.clientId, practitionerId, kind, target])).rows[0];
}
async function wipe() {
  await adminQuery(`delete from public.client_note_drafts where studio_id in ($1, $2)`, [a.studioId, b.studioId]);
}

describe("database-side switch: off means off", () => {
  it("a direct RPC call by a signed-in user stores NOTHING while the studio is not enabled, with the closed code", async () => {
    const off = await seedStudio("nd-off");
    const r = await asUser(off.userId, async (q) => (await q(SAVE, [off.studioId, off.clientId, "consultation", "new", JSON.stringify({ body: "must not be stored" }), 0, randomUUID()])).rows[0]);
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
    const asB = () => asUser(b.userId, async (q) => (await q(SAVE, [a.studioId, a.clientId, "consultation", "new", "{}", 0, randomUUID()])).rows[0]);
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
      const ok = await asUser(a.userId, async (q) => (await q(`select public.discard_client_note_draft($1,$2,'consultation','new') as ok`, [a.studioId, a.clientId])).rows[0].ok);
      expect(ok).toBe(true);
      expect(await draftRow(a, a.practitionerId, "consultation", "new")).toBeUndefined();
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
      await adminQuery(`update public.client_note_drafts set fields = '{"body":"x"}'::jsonb, cleared_at = null where practitioner_id = $1 and client_id = any($2::uuid[])`, [a.practitionerId, ids]);
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
    const cross = await asUser(b.userId, async (q) => (await q(SAVE, [a.studioId, a.clientId, "consultation", "new", "{}", 0, randomUUID()])).rows[0]);
    expect(cross.status).toBe("refused");
  });

  it("an inactive practitioner is refused and reads nothing", async () => {
    await wipe();
    const m = await seedMember(a, "nd-inactive");
    await adminQuery(`update public.practitioners set active = false where id = $1`, [m.practitionerId]);
    const r = await asUser(m.userId, async (q) => (await q(SAVE, [a.studioId, a.clientId, "consultation", "new", "{}", 0, randomUUID()])).rows[0]);
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
    for (const fn of ["save_client_note_draft(uuid,uuid,text,text,jsonb,integer,uuid)", "discard_client_note_draft(uuid,uuid,text,text)", "client_note_drafts_clear_on_note()", "client_note_drafts_clear_on_budget()", "sweep_client_note_drafts()"]) {
      for (const role of ["anon", "public"]) {
        const has = (await adminQuery(`select has_function_privilege($1, $2::regprocedure, 'execute') as has`, [role === "public" ? "authenticated" : role, `public.${fn}`])).rows[0].has;
        if (role === "anon") expect(has, `${fn} anon`).toBe(false);
      }
    }
    expect((await adminQuery(`select has_function_privilege('service_role', 'public.sweep_client_note_drafts()', 'execute') as has`)).rows[0].has).toBe(true);
    expect((await adminQuery(`select has_function_privilege('service_role', 'public.save_client_note_draft(uuid,uuid,text,text,jsonb,integer,uuid)', 'execute') as has`)).rows[0].has).toBe(false);
    expect((await adminQuery(`select has_function_privilege('authenticated', 'public.client_note_draft_retention()', 'execute') as has`)).rows[0].has).toBe(true);
  });
});

describe("one transaction: saving the record clears the draft", () => {
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

  it("a late autosave after the clear conflicts and writes no text; a second tab with older text cannot overwrite a cleared row", async () => {
    await wipe();
    const first = await save(a.userId, a, "consultation", "new", { body: "typing" }, 0);
    await asUser(a.userId, (q) => q(NOTE, [a.clientId, a.studioId, a.practitionerId, "consultation", "saved", null]));
    const late = await save(a.userId, a, "consultation", "new", { body: "late" }, first.revision);
    expect(late.status).toBe("cleared");
    const tabB = await save(a.userId, a, "consultation", "new", { body: "older text" }, first.revision);
    expect(tabB.status).toBe("cleared");
    expect((await draftRow(a, a.practitionerId, "consultation", "new")).fields).toBeNull();
    // A deliberate NEW draft (expected revision 0) reuses the cleared row.
    expect((await save(a.userId, a, "consultation", "new", { body: "fresh" }, 0)).status).toBe("ok");
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
      await adminQuery(`update public.client_note_drafts set fields = null, cleared_at = now() - interval '2 days' where kind = 'budget' and client_id = $1`, [a.clientId]);
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
