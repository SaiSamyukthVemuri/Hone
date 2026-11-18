import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import pg from "pg";
import { adminQuery, asRole, closePool, resolveLocalDbUrl, seedMember, seedStudio, userQuery, type SeededStudio } from "./helpers/harness";

// Portal messages and replies (migration 0341). Real migrated chain, synthetic text only.
//
// Part 1 holds with or without 0341: the statements the shipped server actions issue through the service role,
// the member read, and the callers who are refused either way.
// Part 2 is 0341 itself: no member can write either table directly, reads are unchanged.
// Part 3 applies the rollback INSIDE a transaction that is rolled back, and checks it restores exactly the
// pre-change grants and the three 0055 policies. Local stack only; never run against a hosted database.

let A: SeededStudio; // owner of studio A (also the message author)
let member: { userId: string; practitionerId: string }; // active non-owner practitioner of A
let B: SeededStudio; // owner of another studio
let messageId: string;
let replyId: string;

beforeAll(async () => {
  A = await seedStudio("portal-msg-a");
  member = await seedMember(A, "portal-msg-m");
  B = await seedStudio("portal-msg-b");
  messageId = randomUUID();
  replyId = randomUUID();
  await adminQuery(
    `insert into public.client_portal_messages (id, studio_id, client_id, created_by_practitioner_id, subject, body, status)
     values ($1, $2, $3, $4, 'Seeded subject', 'Seeded body', 'published')`,
    [messageId, A.studioId, A.clientId, A.practitionerId],
  );
  await adminQuery(
    `insert into public.client_portal_message_replies (id, studio_id, client_id, message_id, body) values ($1, $2, $3, $4, 'Seeded reply')`,
    [replyId, A.studioId, A.clientId, messageId],
  );
});
afterAll(async () => {
  await closePool();
});

const RLS = "42501";
const DENIED = [0, RLS]; // no row matched, or refused outright; either way nothing is stored
const storedMessage = async () =>
  (await adminQuery(`select created_by_practitioner_id, subject, body, status, client_reviewed_at, archived_at, client_id from public.client_portal_messages where id = $1`, [messageId])).rows[0];
const storedReply = async () =>
  (await adminQuery(`select body, practitioner_seen_at, archived_at, client_id from public.client_portal_message_replies where id = $1`, [replyId])).rows[0];
const messageCount = async () => (await adminQuery(`select count(*)::int n from public.client_portal_messages where studio_id = $1`, [A.studioId])).rows[0].n as number;

// Writes a signed-in member's client would issue directly; the database must refuse them.
const INSERT_MESSAGE = `insert into public.client_portal_messages (studio_id, client_id, created_by_practitioner_id, subject, body, status)
  values ($1, $2, $3, 'Synthetic subject', 'Synthetic body', 'published')`;
const UPDATE_MESSAGE = `update public.client_portal_messages set subject = 'Rewritten', body = 'Rewritten', client_reviewed_at = now() where id = $1`;
const UPDATE_REPLY = `update public.client_portal_message_replies set body = 'Rewritten reply', practitioner_seen_at = now() where id = $1`;
const INSERT_REPLY = `insert into public.client_portal_message_replies (studio_id, client_id, message_id, body) values ($1, $2, $3, 'Synthetic reply')`;

describe("portal messages: true before and after 0341", () => {
  it("the shipped actions' own statements succeed as the service role (send, stamp, client review, client reply, mark seen, archive)", async () => {
    await asRole("service_role", async (q) => {
      const sent = await q(
        `insert into public.client_portal_messages (studio_id, client_id, created_by_practitioner_id, subject, body, status)
         values ($1, $2, $3, 'Hello', 'Body', 'published') returning id`,
        [A.studioId, A.clientId, member.practitionerId],
      );
      const id = sent.rows[0].id as string;
      expect((await q(`update public.client_portal_messages set notification_email_sent_at = now(), notification_email_error = null where id = $1 and studio_id = $2`, [id, A.studioId])).rowCount).toBe(1);
      expect((await q(
        `update public.client_portal_messages set client_reviewed_at = now()
          where id = $1 and studio_id = $2 and client_id = $3 and status = 'published' and archived_at is null and client_reviewed_at is null`,
        [id, A.studioId, A.clientId],
      )).rowCount).toBe(1);
      const reply = await q(
        `insert into public.client_portal_message_replies (studio_id, client_id, message_id, body) values ($1, $2, $3, 'Thanks') returning id`,
        [A.studioId, A.clientId, id],
      );
      expect((await q(
        `update public.client_portal_message_replies set practitioner_seen_at = now()
          where id = $1 and studio_id = $2 and client_id = $3 and practitioner_seen_at is null`,
        [reply.rows[0].id, A.studioId, A.clientId],
      )).rowCount).toBe(1);
      expect((await q(`update public.client_portal_messages set archived_at = now(), status = 'archived' where id = $1 and studio_id = $2 and client_id = $3`, [id, A.studioId, A.clientId])).rowCount).toBe(1);
    }); // asRole rolls back
    expect(await messageCount()).toBe(1);
  });

  it("an active member of the studio reads its messages and replies", async () => {
    for (const uid of [A.userId, member.userId]) {
      expect((await userQuery(uid, `select id from public.client_portal_messages where id = $1`, [messageId])).rowCount).toBe(1);
      expect((await userQuery(uid, `select id from public.client_portal_message_replies where id = $1`, [replyId])).rowCount).toBe(1);
    }
  });

  it("another studio's owner and an anonymous caller neither read nor write; stored rows are unchanged", async () => {
    const before = { m: await storedMessage(), r: await storedReply() };
    const outcome = (p: Promise<{ rowCount: number | null }>) => p.then((r) => r.rowCount ?? 0, (e: { code?: string }) => e.code ?? "no-code");
    expect((await userQuery(B.userId, `select id from public.client_portal_messages where id = $1`, [messageId])).rowCount).toBe(0);
    expect(await outcome(userQuery(B.userId, INSERT_MESSAGE, [A.studioId, A.clientId, A.practitionerId]))).toBe(RLS);
    expect(DENIED).toContain(await outcome(userQuery(B.userId, UPDATE_MESSAGE, [messageId])));
    expect(DENIED).toContain(await outcome(userQuery(B.userId, UPDATE_REPLY, [replyId])));
    expect(await outcome(userQuery(B.userId, INSERT_REPLY, [A.studioId, A.clientId, messageId]))).toBe(RLS);
    for (const [sql, params] of [
      [INSERT_MESSAGE, [A.studioId, A.clientId, A.practitionerId]],
      [UPDATE_MESSAGE, [messageId]],
      [UPDATE_REPLY, [replyId]],
      [INSERT_REPLY, [A.studioId, A.clientId, messageId]],
    ] as const) {
      expect(DENIED, sql).toContain(await outcome(asRole("anon", (q) => q(sql, [...params]))));
    }
    expect(DENIED).toContain(await outcome(asRole("anon", (q) => q(`select id from public.client_portal_messages where id = $1`, [messageId]))));
    expect({ m: await storedMessage(), r: await storedReply() }).toEqual(before);
    expect(await messageCount()).toBe(1);
  });

  it("no member, owner included, can insert a reply directly (0055 never granted it)", async () => {
    for (const uid of [A.userId, member.userId]) {
      const code = await userQuery(uid, INSERT_REPLY, [A.studioId, A.clientId, messageId]).then(() => "no-error", (e: { code?: string }) => e.code);
      expect(code).toBe(RLS);
    }
  });
});

const TABLES = ["client_portal_message_replies", "client_portal_messages"];
const grants = (q: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) =>
  q(
    `select t, r, has_table_privilege(r, 'public.' || t, 'INSERT') as ins, has_table_privilege(r, 'public.' || t, 'UPDATE') as upd,
            has_table_privilege(r, 'public.' || t, 'SELECT') as sel
       from unnest($1::text[]) t, unnest(array['anon', 'authenticated', 'service_role']) r order by 1, 2`,
    [TABLES],
  ).then((x) => x.rows);
const policies = (q: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) =>
  q(
    `select tablename, policyname, cmd, roles::text as roles, qual, with_check from pg_policies
      where schemaname = 'public' and tablename = any($1::text[]) order by 1, 2`,
    [TABLES],
  ).then((x) => x.rows);

describe("portal messages: after 0341", () => {
  it("no member, owner included, can write either table directly; reads are unchanged; nothing is stored", async () => {
    const before = { m: await storedMessage(), r: await storedReply() };
    const code = (p: Promise<unknown>) => p.then(() => "no-error", (e: { code?: string }) => e.code ?? "no-code");
    for (const uid of [A.userId, member.userId]) {
      expect(await code(userQuery(uid, INSERT_MESSAGE, [A.studioId, A.clientId, A.practitionerId])), "insert a message").toBe(RLS);
      expect(await code(userQuery(uid, UPDATE_MESSAGE, [messageId])), "update a message").toBe(RLS);
      expect(await code(userQuery(uid, UPDATE_REPLY, [replyId])), "update a reply").toBe(RLS);
      expect(await code(userQuery(uid, INSERT_REPLY, [A.studioId, A.clientId, messageId])), "insert a reply").toBe(RLS);
      expect((await userQuery(uid, `select id from public.client_portal_messages where id = $1`, [messageId])).rowCount).toBe(1);
      expect((await userQuery(uid, `select id from public.client_portal_message_replies where id = $1`, [replyId])).rowCount).toBe(1);
    }
    expect({ m: await storedMessage(), r: await storedReply() }).toEqual(before);
    expect(await messageCount()).toBe(1);
  });

  it("catalog: only the two member reads remain; anon and authenticated hold no INSERT or UPDATE; SELECT and service_role are as before", async () => {
    expect((await policies(adminQuery)).map((p) => [p.tablename, p.policyname, p.cmd])).toEqual([
      ["client_portal_message_replies", "client_portal_message_replies_studio_member_select", "SELECT"],
      ["client_portal_messages", "client_portal_messages_studio_member_select", "SELECT"],
    ]);
    for (const g of await grants(adminQuery)) {
      const svc = g.r === "service_role";
      expect([g.t, g.r, g.ins, g.upd, g.sel]).toEqual([g.t, g.r, svc, svc, true]);
    }
  });
});

describe("portal messages: 0341 rollback (applied in a rolled-back transaction, local stack only)", () => {
  it("restores exactly INSERT and UPDATE for anon and authenticated and the three 0055 policies, and nothing for PUBLIC", async () => {
    const down = readFileSync(join(__dirname, "..", "..", "supabase/rollbacks/0341_portal_message_member_write_policies.down.sql"), "utf8")
      .replace(/^\s*begin;\s*$/im, "")
      .replace(/^\s*commit;\s*$/im, "");
    const pool = new pg.Pool({ connectionString: resolveLocalDbUrl(), max: 1 });
    const client = await pool.connect();
    try {
      await client.query("begin");
      try {
        await client.query(down);
        const q = (text: string, params?: unknown[]) => client.query(text, params);
        for (const g of await grants(q)) expect([g.t, g.r, g.ins, g.upd, g.sel]).toEqual([g.t, g.r, true, true, true]);
        // nothing was granted to PUBLIC
        const pub = await q(
          `select count(*)::int n from pg_class c join pg_namespace n on n.oid = c.relnamespace, aclexplode(c.relacl) a
            where n.nspname = 'public' and c.relname = any($1::text[]) and a.grantee = 0`,
          [TABLES],
        );
        expect(pub.rows[0].n).toBe(0);
        const member = "is_studio_member(studio_id)";
        // pg_get_expr may or may not schema-qualify the function, depending on search_path
        const bare = (v: unknown) => (typeof v === "string" ? v.replace(/^\(?public\./, "").replace(/^\((.*)\)$/, "$1") : v);
        expect((await policies(q)).map((p) => ({ ...p, qual: bare(p.qual), with_check: bare(p.with_check) }))).toEqual([
          { tablename: "client_portal_message_replies", policyname: "client_portal_message_replies_studio_member_select", cmd: "SELECT", roles: "{authenticated}", qual: member, with_check: null },
          { tablename: "client_portal_message_replies", policyname: "client_portal_message_replies_studio_member_update", cmd: "UPDATE", roles: "{authenticated}", qual: member, with_check: member },
          { tablename: "client_portal_messages", policyname: "client_portal_messages_studio_member_insert", cmd: "INSERT", roles: "{authenticated}", qual: null, with_check: member },
          { tablename: "client_portal_messages", policyname: "client_portal_messages_studio_member_select", cmd: "SELECT", roles: "{authenticated}", qual: member, with_check: null },
          { tablename: "client_portal_messages", policyname: "client_portal_messages_studio_member_update", cmd: "UPDATE", roles: "{authenticated}", qual: member, with_check: member },
        ]);
      } finally {
        await client.query("rollback");
      }
    } finally {
      client.release();
      await pool.end();
    }
    // the rollback did not persist: 0341 still holds
    expect((await policies(adminQuery)).length).toBe(2);
  });
});
