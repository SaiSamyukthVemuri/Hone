import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

import { adminQuery, asUser, closePool, seedSession, seedStudio, type SeededStudio } from "./helpers/harness";

// ===========================================================================
// 0301 WRITE RECEIPTS (Codex #1369 4488743493 and 4488743496, Sam 6 Nov 2026).
//
// A write that COMMITTED and whose answer was lost is answered again, from its receipt, with the block
// version THAT write produced and the identity it recorded. The replay never hands back the block's CURRENT
// version: a colleague's edit made after the commit must still make the next save conflict (Insurance N-8).
// SYNTHETIC PROFILE ONLY.
// ===========================================================================

const PROFILE = "fixture:db-receipts";
afterAll(async () => {
  await closePool();
});

async function register(studio: SeededStudio): Promise<string> {
  await adminQuery(`select public.sync_machine_profile_contract($1,$2,$3,$4,$5,$6::jsonb)`, [
    PROFILE,
    1,
    "galvanic",
    4,
    null,
    JSON.stringify([{ field_key: "current", native_unit: "µA", decimals: 0, quantity: "current", optional: true }]),
  ]);
  return asUser(studio.userId, async (q) => {
    const r = await q(`select public.register_studio_machine($1,$2,$3,$4,$5) as id`, [studio.studioId, PROFILE, 1, "Room 1", []]);
    return r.rows[0].id as string;
  });
}

const groups = (value: string, channel = 1) => [
  { new_group_ref: `g${channel}`, channels: [channel], readings: [{ field_key: "current", value, observation_source: "practitioner-entered" }] },
];

const version = async (blockId: string) =>
  (await adminQuery(`select updated_at::text as t from public.session_blocks where id = $1`, [blockId])).rows[0].t as string;
const count = async (sql: string, p: unknown[]) => (await adminQuery(sql, p)).rows[0].n as number;
/** A colleague edits the area: a plain UPDATE the way any other tab's save would, so updated_at moves. */
const colleagueEdits = (blockId: string) => adminQuery(`update public.session_blocks set block_notes = 'colleague' where id = $1`, [blockId]);

type IdentityReply = { updated_at: string; reused: boolean; machine_profile_id: string | null; studio_machine_id: string | null; machine_mode_key: string | null };
const stamp = (s: SeededStudio, sessionId: string, blockId: string, machine: string, key: string, held: string | null, mode = "galvanic") =>
  asUser(s.userId, async (q) => {
    const r = await q(`select public.record_block_machine_identity($1,$2,$3,$4,$5,$6,$7,$8::timestamptz) as r`, [
      blockId, sessionId, s.clientId, null, machine, mode, key, held,
    ]);
    return r.rows[0].r as IdentityReply;
  });
type SubmitReply = { reused: boolean; submission_id: string; block_updated_at?: string; studio_machine_id?: string };
const submit = (s: SeededStudio, sessionId: string, blockId: string, machine: string, key: string, held: string | null, value = "9", channel = 1) =>
  asUser(s.userId, async (q) => {
    const r = await q(`select public.record_setup_submission_with_identity($1,$2,$3,$4,$5::jsonb,$6,$7,$8::timestamptz) as r`, [
      blockId, machine, "galvanic", key, JSON.stringify(groups(value, channel)), sessionId, s.clientId, held,
    ]);
    return r.rows[0].r as SubmitReply;
  });

describe("(a) identity write: commit, lose the reply, recover", () => {
  it("a same-key replay returns the version that write produced and the stored identity, writes nothing, and the next save succeeds", async () => {
    const s = await seedStudio("rcpt-id");
    const { sessionId, blockId } = await seedSession(s);
    const machine = await register(s);
    const held = await version(blockId);
    const key = `rcpt-${randomUUID()}`;
    const first = await stamp(s, sessionId, blockId, machine, key, held); // the reply of this call is "lost"
    expect(first.reused).toBe(false);
    const afterWrite = await version(blockId);
    expect(afterWrite).not.toBe(held);

    // The editor still holds the OLD version and asks again with the same key.
    const replay = await stamp(s, sessionId, blockId, machine, key, held);
    expect(replay.reused).toBe(true);
    expect(new Date(replay.updated_at).getTime()).toBe(new Date(afterWrite).getTime());
    expect(replay).toMatchObject({ studio_machine_id: machine, machine_mode_key: "galvanic", machine_profile_id: PROFILE });
    expect(await version(blockId), "a replay changes nothing").toBe(afterWrite);
    expect(await count(`select count(*)::int n from public.block_write_receipts where session_block_id=$1`, [blockId])).toBe(1);

    // Adopting that version, the next save succeeds.
    const next = await stamp(s, sessionId, blockId, machine, `rcpt-${randomUUID()}`, replay.updated_at, "galvanic");
    expect(next.reused).toBe(false);
  });

  it("NEGATIVE CONTROL: a colleague's edit between the commit and the recovery is still refused on the next save", async () => {
    const s = await seedStudio("rcpt-id-colleague");
    const { sessionId, blockId } = await seedSession(s);
    const machine = await register(s);
    const key = `rcpt-${randomUUID()}`;
    await stamp(s, sessionId, blockId, machine, key, await version(blockId));
    const ours = await version(blockId);
    await colleagueEdits(blockId);
    const current = await version(blockId);
    expect(current).not.toBe(ours);

    const replay = await stamp(s, sessionId, blockId, machine, key, ours);
    expect(replay.reused).toBe(true);
    expect(new Date(replay.updated_at).getTime(), "the replay hands back OUR write's version, never the current one").toBe(new Date(ours).getTime());
    await expect(stamp(s, sessionId, blockId, machine, `rcpt-${randomUUID()}`, replay.updated_at)).rejects.toThrow(/stale_block_version/);
    expect(await version(blockId)).toBe(current);
  });

  it("NEGATIVE CONTROL: the same key with a different machine choice is refused, never answered with the original", async () => {
    const s = await seedStudio("rcpt-id-mismatch");
    const { sessionId, blockId } = await seedSession(s);
    const machine = await register(s);
    const key = `rcpt-${randomUUID()}`;
    await stamp(s, sessionId, blockId, machine, key, await version(blockId));
    const v = await version(blockId);
    await expect(
      asUser(s.userId, (q) =>
        q(`select public.record_block_machine_identity($1,$2,$3,$4,$5,$6,$7)`, [blockId, sessionId, s.clientId, null, machine, null, key]),
      ),
    ).rejects.toThrow(/already used for a different machine choice/);
    expect(await version(blockId)).toBe(v);
  });

  it("a replay is still answered after the unit was retired (nothing about the block's current state is consulted)", async () => {
    const s = await seedStudio("rcpt-id-retired");
    const { sessionId, blockId } = await seedSession(s);
    const machine = await register(s);
    const key = `rcpt-${randomUUID()}`;
    await stamp(s, sessionId, blockId, machine, key, await version(blockId));
    await adminQuery(`update public.studio_machines set retired_at = now() where id = $1`, [machine]);
    const replay = await stamp(s, sessionId, blockId, machine, key, null);
    expect(replay.reused).toBe(true);
    expect(replay.studio_machine_id).toBe(machine);
  });

  it("a key shorter than 8 characters is refused", async () => {
    const s = await seedStudio("rcpt-id-shortkey");
    const { sessionId, blockId } = await seedSession(s);
    const machine = await register(s);
    await expect(stamp(s, sessionId, blockId, machine, "short", null)).rejects.toThrow();
    expect(await count(`select count(*)::int n from public.block_write_receipts where session_block_id=$1`, [blockId])).toBe(0);
  });
});

describe("(b) readings replay: commit, lose the reply, recover", () => {
  it("a same-key replay returns the version that submission produced, writes no second capture, and the next save succeeds", async () => {
    const s = await seedStudio("rcpt-rd");
    const { sessionId, blockId } = await seedSession(s);
    const machine = await register(s);
    const held = await version(blockId);
    const key = `rcpt-rd-${randomUUID()}`;
    const first = await submit(s, sessionId, blockId, machine, key, held);
    expect(first.reused).toBe(false);
    const afterWrite = await version(blockId);
    const subs = () => count(`select count(*)::int n from public.treatment_setup_submissions where session_block_id=$1`, [blockId]);
    const caps = () => count(`select count(*)::int n from public.treatment_setup_captures where session_block_id=$1`, [blockId]);
    const [s0, c0] = [await subs(), await caps()];

    const replay = await submit(s, sessionId, blockId, machine, key, held);
    expect(replay.reused).toBe(true);
    expect(replay.submission_id).toBe(first.submission_id);
    expect(new Date(replay.block_updated_at!).getTime()).toBe(new Date(afterWrite).getTime());
    expect(await version(blockId)).toBe(afterWrite);
    expect([await subs(), await caps()], "no duplicate submission or readings").toEqual([s0, c0]);

    const next = await submit(s, sessionId, blockId, machine, `rcpt-rd-${randomUUID()}`, replay.block_updated_at!, "7", 2);
    expect(next.reused).toBe(false);
  });

  it("NEGATIVE CONTROL: a colleague's edit between the commit and the recovery is still refused on the next save", async () => {
    const s = await seedStudio("rcpt-rd-colleague");
    const { sessionId, blockId } = await seedSession(s);
    const machine = await register(s);
    const key = `rcpt-rd-${randomUUID()}`;
    await submit(s, sessionId, blockId, machine, key, await version(blockId));
    const ours = await version(blockId);
    await colleagueEdits(blockId);
    const current = await version(blockId);

    const replay = await submit(s, sessionId, blockId, machine, key, ours);
    expect(replay.reused).toBe(true);
    expect(new Date(replay.block_updated_at!).getTime()).toBe(new Date(ours).getTime());
    await expect(submit(s, sessionId, blockId, machine, `rcpt-rd-${randomUUID()}`, replay.block_updated_at!, "5", 2)).rejects.toThrow(/stale_block_version/);
    expect(await version(blockId)).toBe(current);
  });
});

describe("(d) a submission with no stored version (made before the receipts) fails closed", () => {
  it("the replay returns no version, and the next save with the old held version is refused as stale: no crash, no blind token", async () => {
    const s = await seedStudio("rcpt-legacy");
    const { sessionId, blockId } = await seedSession(s);
    const machine = await register(s);
    const held = await version(blockId);
    const key = `rcpt-lg-${randomUUID()}`;
    await submit(s, sessionId, blockId, machine, key, held);
    // The state an older submission is in: it exists, and no receipt does.
    await adminQuery(`delete from public.block_write_receipts where session_block_id = $1`, [blockId]);

    const replay = await submit(s, sessionId, blockId, machine, key, held);
    expect(replay.reused).toBe(true);
    expect(replay.block_updated_at).toBeUndefined();
    await expect(submit(s, sessionId, blockId, machine, `rcpt-lg-${randomUUID()}`, held, "3", 2)).rejects.toThrow(/stale_block_version/);
  });
});

describe("the receipts table", () => {
  it("has RLS on, no policy, no direct privilege for anon, authenticated or service_role, and holds ids and timestamps only", async () => {
    const r = await adminQuery(
      `select c.relrowsecurity as rls,
              (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies,
              has_table_privilege('anon', c.oid, 'select,insert,update,delete') as anon,
              has_table_privilege('authenticated', c.oid, 'select,insert,update,delete,truncate,references,trigger') as auth,
              has_table_privilege('service_role', c.oid, 'select,insert,update,delete,truncate,references,trigger') as svc
         from pg_class c where c.oid = 'public.block_write_receipts'::regclass`,
    );
    expect(r.rows[0]).toEqual({ rls: true, policies: 0, anon: false, auth: false, svc: false });
    const cols = await adminQuery(
      `select column_name, data_type from information_schema.columns where table_schema='public' and table_name='block_write_receipts' order by 1`,
    );
    const text = cols.rows.filter((c) => c.data_type === "text").map((c) => c.column_name);
    expect(text.sort()).toEqual(["idempotency_key", "kind", "machine_mode_key", "machine_profile_id", "payload_digest"]);
  });
});
