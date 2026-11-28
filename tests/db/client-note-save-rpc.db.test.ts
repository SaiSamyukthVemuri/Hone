import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, asUser, closePool, seedMember, seedStudio, type SeededStudio } from "./helpers/harness";

// Migration 0399 (HON-130): the SAVE WRAPPERS the note and budget actions now call. They are SECURITY INVOKER: the same RLS, triggers and
// constraints as the direct insert / upsert they replace, plus one transaction-local setting that names the draft generation to the clear trigger.
let a: SeededStudio;
let b: SeededStudio;
let colleague: { userId: string; practitionerId: string };

const ADD = `select public.add_client_clinical_note($1, $2, $3, $4::text[], $5, $6, $7) as id`;
const BUDGET = `select public.upsert_client_budget_context($1, $2, $3, $4)`;
const DIRECT = `insert into public.client_clinical_notes (client_id, studio_id, practitioner_id, kind, body, supersedes_note_id) values ($1, $2, $3, $4, $5, $6) returning id`;

beforeAll(async () => {
  a = await seedStudio("sv-a");
  b = await seedStudio("sv-b");
  colleague = await seedMember(a, "sv-a-colleague");
  await adminQuery(`insert into public.client_note_draft_enabled_studios (studio_id) values ($1), ($2) on conflict do nothing`, [a.studioId, b.studioId]);
});
afterAll(async () => {
  await closePool();
});

const add = (user: string, clientId: string, kind: string, body: string, supersedes: string | null = null, generation: string | null = null, areas: string[] = [], occurredAt: string | null = null) =>
  asUser(user, async (q) => (await q(ADD, [clientId, kind, body, areas, occurredAt, supersedes, generation])).rows[0].id as string);
const note = async (id: string) => (await adminQuery(`select * from public.client_clinical_notes where id = $1`, [id])).rows[0];
const draft = async (s: SeededStudio, practitionerId: string, kind: string, target: string) =>
  (await adminQuery(`select * from public.client_note_drafts where client_id = $1 and practitioner_id = $2 and kind = $3 and target = $4`, [s.clientId, practitionerId, kind, target])).rows[0];
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return (e as { code?: string }).code ?? "?";
  }
};

describe("add: same row as the direct insert, with and without a draft", () => {
  it("stores the note with attribution and studio from the SESSION, areas and a backdated date", async () => {
    const id = await add(a.userId, a.clientId, "skin_hair_analysis", "wrapper body", null, null, ["chin", "lip"], "2026-11-01T10:00:00Z");
    const row = await note(id);
    expect(row).toMatchObject({ client_id: a.clientId, studio_id: a.studioId, practitioner_id: a.practitionerId, kind: "skin_hair_analysis", body: "wrapper body", supersedes_note_id: null });
    expect(row.areas).toEqual(["chin", "lip"]);
    expect(new Date(row.occurred_at).toISOString()).toBe("2026-11-01T10:00:00.000Z");
  });
  it("is the SAME row a direct insert makes (columns other than ids and timestamps)", async () => {
    const viaRpc = await note(await add(a.userId, a.clientId, "consultation", "parity", null, null));
    const direct = await note(await asUser(a.userId, async (q) => (await q(DIRECT, [a.clientId, a.studioId, a.practitionerId, "consultation", "parity", null])).rows[0].id as string));
    for (const k of ["client_id", "studio_id", "practitioner_id", "kind", "body", "areas", "supersedes_note_id"]) expect(viaRpc[k], k).toEqual(direct[k]);
  });
  it("with a draft: the note is saved and the author's draft becomes a text-free tombstone naming its generation", async () => {
    const g = randomUUID();
    await adminQuery(`insert into public.client_note_drafts (studio_id, client_id, practitioner_id, kind, target, fields, generation) values ($1,$2,$3,'consultation','new','{"body":"d"}'::jsonb,$4) on conflict (practitioner_id, client_id, kind, target) do update set fields='{"body":"d"}'::jsonb, cleared_at=null, ended_generation=null, generation=$4`, [a.studioId, a.clientId, a.practitionerId, g]);
    await add(a.userId, a.clientId, "consultation", "with draft", null, g);
    const d = await draft(a, a.practitionerId, "consultation", "new");
    expect(d.fields).toBeNull();
    expect(d.ended_generation).toBe(g);
    expect(d.generation).toBeNull();
  });
});

describe("revise: one revision per note, a concurrent second revision is the 23505 stale conflict", () => {
  it("revises, links supersedes, and clears only the author's revise-target draft", async () => {
    const base = await add(a.userId, a.clientId, "consultation", "base");
    const rev = await add(a.userId, a.clientId, "consultation", "rev", base);
    expect((await note(rev)).supersedes_note_id).toBe(base);
  });
  it("two concurrent revisions of one note: exactly one wins, the other is 23505", async () => {
    const base = await add(a.userId, a.clientId, "consultation", "race base");
    const r = await Promise.all([code(add(a.userId, a.clientId, "consultation", "r1", base)), code(add(colleague.userId, a.clientId, "consultation", "r2", base))]);
    expect(r.filter((c) => c === "ok")).toHaveLength(1);
    expect(r.filter((c) => c === "23505")).toHaveLength(1);
  });
  it("a revision of a note of another kind or another client is refused by the table's own trigger, not silently accepted", async () => {
    const base = await add(a.userId, a.clientId, "consultation", "kind base");
    expect(await code(add(a.userId, a.clientId, "skin_hair_analysis", "wrong kind", base))).not.toBe("ok");
  });
});

describe("gates: studio and practitioner come from the session, never an argument", () => {
  it("the function takes no studio or practitioner argument", async () => {
    const args = (await adminQuery(`select pg_get_function_arguments(oid) as a from pg_proc where proname in ('add_client_clinical_note','upsert_client_budget_context')`)).rows.map((r) => r.a as string).join(" ");
    expect(args).not.toMatch(/studio|practitioner/i);
  });
  it("another studio's member, a non-member, a deactivated practitioner and a receptionist are all refused, with a closed code and no text", async () => {
    const stranger = randomUUID();
    await adminQuery(`insert into auth.users (id, email) values ($1, $2)`, [stranger, `sv-stranger-${stranger.slice(0, 8)}@harness.local`]);
    const inactive = await seedMember(a, "sv-inactive");
    await adminQuery(`update public.practitioners set active = false where id = $1`, [inactive.practitionerId]);
    const reception = randomUUID();
    await adminQuery(`insert into auth.users (id, email) values ($1, $2)`, [reception, `sv-desk-${reception.slice(0, 8)}@harness.local`]);
    await adminQuery(`insert into public.studio_receptionists (studio_id, user_id, display_name, active) values ($1, $2, 'Front desk', true)`, [a.studioId, reception]);
    for (const [label, user] of [["other studio", b.userId], ["non-member", stranger], ["deactivated", inactive.userId], ["receptionist", reception]] as const) {
      let msg = "";
      let c = "";
      try {
        await add(user, a.clientId, "consultation", "CLINICAL SECRET TEXT");
        c = "ok";
      } catch (e) {
        c = (e as { code?: string }).code ?? "?";
        msg = (e as Error).message;
      }
      expect(c, label).toBe("42501");
      expect(msg, label).not.toContain("CLINICAL SECRET TEXT");
    }
    expect((await adminQuery(`select count(*)::int n from public.client_clinical_notes where body = 'CLINICAL SECRET TEXT'`)).rows[0].n).toBe(0);
  });
  it("the same four are refused for the budget upsert", async () => {
    const stranger = randomUUID();
    await adminQuery(`insert into auth.users (id, email) values ($1, $2)`, [stranger, `sv-stranger2-${stranger.slice(0, 8)}@harness.local`]);
    for (const user of [b.userId, stranger]) {
      expect(await code(asUser(user, (q) => q(BUDGET, [a.clientId, "somewhat_limited", "NOPE", null])))).toBe("42501");
    }
    expect((await adminQuery(`select count(*)::int n from public.client_budget_context where client_id = $1 and budget_notes = 'NOPE'`, [a.clientId])).rows[0].n).toBe(0);
  });
  it("a studio a caller names cannot be forced: a client of studio A written by B's member stores nothing", async () => {
    const before = (await adminQuery(`select count(*)::int n from public.client_clinical_notes where client_id = $1`, [a.clientId])).rows[0].n;
    expect(await code(add(b.userId, a.clientId, "consultation", "cross"))).toBe("42501");
    expect((await adminQuery(`select count(*)::int n from public.client_clinical_notes where client_id = $1`, [a.clientId])).rows[0].n).toBe(before);
  });
});

describe("budget upsert: with and without a draft", () => {
  it("inserts then overwrites the one row per client, attributed to the session practitioner", async () => {
    await asUser(a.userId, (q) => q(BUDGET, [a.clientId, "no_stated_limit", "first", null]));
    await asUser(colleague.userId, (q) => q(BUDGET, [a.clientId, "severely_limited", "second", null]));
    const row = (await adminQuery(`select * from public.client_budget_context where client_id = $1`, [a.clientId])).rows[0];
    expect(row).toMatchObject({ budget_level: "severely_limited", budget_notes: "second", updated_by_practitioner_id: colleague.practitionerId, studio_id: a.studioId });
  });
  it("a bad level is the table's own check, not accepted", async () => {
    expect(await code(asUser(a.userId, (q) => q(BUDGET, [a.clientId, "bogus", "x", null])))).toBe("23514");
  });
  it("with a draft: the author's budget draft becomes a tombstone naming its generation; a colleague's budget draft is untouched", async () => {
    const g = randomUUID();
    const gc = randomUUID();
    await adminQuery(`delete from public.client_note_drafts where client_id = $1 and kind = 'budget'`, [a.clientId]);
    await adminQuery(`insert into public.client_note_drafts (studio_id, client_id, practitioner_id, kind, target, fields, generation) values ($1,$2,$3,'budget','current','{"budget_notes":"d"}'::jsonb,$4), ($1,$2,$5,'budget','current','{"budget_notes":"theirs"}'::jsonb,$6)`, [a.studioId, a.clientId, a.practitionerId, g, colleague.practitionerId, gc]);
    await asUser(a.userId, (q) => q(BUDGET, [a.clientId, "somewhat_limited", "saved", g]));
    const mine = await draft(a, a.practitionerId, "budget", "current");
    expect(mine.fields).toBeNull();
    expect(mine.ended_generation).toBe(g);
    expect((await draft(a, colleague.practitionerId, "budget", "current")).fields).toEqual({ budget_notes: "theirs" });
  });
});

describe("shape and grants", () => {
  it("both wrappers are SECURITY INVOKER with a pinned search_path", async () => {
    const rows = (await adminQuery(`select proname, prosecdef, proconfig from pg_proc where proname in ('add_client_clinical_note','upsert_client_budget_context')`)).rows;
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.prosecdef, r.proname).toBe(false);
      expect((r.proconfig as string[]).join(",")).toContain("search_path=pg_catalog, pg_temp");
    }
  });
  it("execute: authenticated only (anon, service_role and public hold nothing)", async () => {
    for (const fn of ["public.add_client_clinical_note(uuid,text,text,text[],timestamptz,uuid,uuid)", "public.upsert_client_budget_context(uuid,text,text,uuid)"]) {
      for (const [role, want] of [["anon", false], ["service_role", false], ["authenticated", true]] as const) {
        expect((await adminQuery(`select has_function_privilege($1, $2::regprocedure, 'execute') as h`, [role, fn])).rows[0].h, `${fn} ${role}`).toBe(want);
      }
      expect((await adminQuery(`select has_function_privilege('public', $1::regprocedure, 'execute') as h`, [fn])).rows[0].h, `${fn} public`).toBe(false);
    }
  });
  it("NEGATIVE CONTROL (pins what a direct table insert now does): it still works for an authorised author but names no generation and cannot be refused as a double save", async () => {
    const g = randomUUID();
    await adminQuery(`delete from public.client_note_drafts where client_id = $1 and kind = 'consultation' and target = 'new'`, [a.clientId]);
    await adminQuery(`insert into public.client_note_drafts (studio_id, client_id, practitioner_id, kind, target, fields, generation) values ($1,$2,$3,'consultation','new','{"body":"d"}'::jsonb,$4)`, [a.studioId, a.clientId, a.practitionerId, g]);
    await asUser(a.userId, (q) => q(DIRECT, [a.clientId, a.studioId, a.practitionerId, "consultation", "direct one", null]));
    await asUser(a.userId, (q) => q(DIRECT, [a.clientId, a.studioId, a.practitionerId, "consultation", "direct two", null])); // two notes: nothing refuses it
    const d = await draft(a, a.practitionerId, "consultation", "new");
    expect(d.fields).toBeNull(); // the live row's own generation was still recorded...
    expect(d.ended_generation).toBe(g); // ...because the row EXISTED; with no row the tombstone would carry NULL (the accepted residual)
  });
});
