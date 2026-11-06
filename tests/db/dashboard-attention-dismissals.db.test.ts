import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, asRole, asUser, closePool, seedMember, seedSession, seedStudio, type SeededStudio } from "./helpers/harness";

// Migration 0298 dashboard_attention_events (HELD; owned-stack proof). Dismissing a reminder is the owner's tidy-up of THEIR view:
// per dismissing owner, owner-only, append-only, and it can never change money, setup or access.

let a: SeededStudio;
let b: SeededStudio;
let member: { userId: string };
let secondOwnerUser: string;

const dismiss = (user: string, studio: string, key: string, token: string) =>
  asUser(user, async (q) => (await q(`select public.dismiss_attention_item($1,$2,$3) as r`, [studio, key, token])).rows[0].r);
const restore = (user: string, studio: string, key: string) =>
  asUser(user, async (q) => (await q(`select public.restore_attention_item($1,$2) as r`, [studio, key])).rows[0].r);
const restoreIf = (user: string, studio: string, key: string, seq: number) =>
  asUser(user, async (q) => (await q(`select public.restore_attention_item_if_latest($1,$2,$3) as r`, [studio, key, seq])).rows[0].r);
const seqOf = (r: { rows: { item_key: string; event_seq: number }[] }, key: string) => r.rows.find((x) => x.item_key === key)?.event_seq as number;
const list = (user: string, studio: string) =>
  asUser(user, async (q) => (await q(`select public.list_dismissed_attention($1) as r`, [studio])).rows[0].r);
const keys = (r: { rows: { item_key: string }[] }) => r.rows.map((x) => x.item_key).sort();

beforeAll(async () => {
  a = await seedStudio("dismiss-a");
  b = await seedStudio("dismiss-b");
  member = await seedMember(a, "dismiss-m");
  // A second OWNER of studio a (a separate user), to prove dismissal is per dismissing owner.
  secondOwnerUser = randomUUID();
  await adminQuery(`insert into auth.users (id, email) values ($1, $2)`, [secondOwnerUser, `o2-${secondOwnerUser.slice(0, 8)}@harness.local`]);
  await adminQuery(
    `insert into public.practitioners (id, studio_id, user_id, display_name, email, role, active) values ($1,$2,$3,'Second owner',$4,'owner',true)`,
    [randomUUID(), a.studioId, secondOwnerUser, `o2-${secondOwnerUser.slice(0, 8)}@harness.local`],
  );
});
afterAll(async () => {
  await closePool();
});

describe("dismiss and restore", () => {
  it("dismisses, lists, is idempotent for the same instance, and a NEW instance of the same key is its own dismissal", async () => {
    expect(await dismiss(a.userId, a.studioId, "session:c1:s1:aftercare", "1")).toEqual({ ok: true, changed: true });
    expect(await dismiss(a.userId, a.studioId, "session:c1:s1:aftercare", "1")).toEqual({ ok: true, changed: false });
    const l = await list(a.userId, a.studioId);
    expect(l.ok).toBe(true);
    expect(l.capped).toBe(false);
    expect(l.rows).toEqual([expect.objectContaining({ item_key: "session:c1:s1:aftercare", instance_token: "1" })]);
    // A grown unpaid balance carries a new token: a new dismissal, not a no-op.
    expect(await dismiss(a.userId, a.studioId, "unpaid:appt1", "c5000")).toEqual({ ok: true, changed: true });
    expect(await dismiss(a.userId, a.studioId, "unpaid:appt1", "c8000")).toEqual({ ok: true, changed: true });
    const after = await list(a.userId, a.studioId);
    expect(after.rows.find((r: { item_key: string }) => r.item_key === "unpaid:appt1").instance_token).toBe("c8000");
  });
  it("restore removes the dismissal from the list; restoring something not dismissed is a quiet no-op", async () => {
    expect(await restore(a.userId, a.studioId, "session:c1:s1:aftercare")).toEqual({ ok: true, changed: true });
    expect(keys(await list(a.userId, a.studioId))).not.toContain("session:c1:s1:aftercare");
    expect(await restore(a.userId, a.studioId, "session:c1:s1:aftercare")).toEqual({ ok: true, changed: false });
    expect(await restore(a.userId, a.studioId, "never:dismissed")).toEqual({ ok: true, changed: false });
    // And it can be dismissed again afterwards.
    expect(await dismiss(a.userId, a.studioId, "session:c1:s1:aftercare", "1")).toEqual({ ok: true, changed: true });
  });
  it("is per dismissing owner: another owner of the same studio sees none of it and can keep their own", async () => {
    expect(keys(await list(secondOwnerUser, a.studioId))).toEqual([]);
    expect(await dismiss(secondOwnerUser, a.studioId, "intake:c9:intake_review", "2026-11-01")).toEqual({ ok: true, changed: true });
    expect(keys(await list(a.userId, a.studioId))).not.toContain("intake:c9:intake_review");
    expect(keys(await list(secondOwnerUser, a.studioId))).toEqual(["intake:c9:intake_review"]);
    // Restoring as the other owner does not touch the first owner's dismissals.
    expect(await restore(secondOwnerUser, a.studioId, "session:c1:s1:aftercare")).toEqual({ ok: true, changed: false });
    expect(keys(await list(a.userId, a.studioId))).toContain("session:c1:s1:aftercare");
  });
  it("Codex P2 4492399987: a stale conditional restore leaves a NEWER dismissal alone; the ordinary case restores the observed one", async () => {
    const key = "no_services:studio";
    // Tab A observes the dismissal (its event_seq) and schedules the clear.
    expect(await dismiss(a.userId, a.studioId, key, "2026-11-03")).toEqual({ ok: true, changed: true });
    const observed = seqOf(await list(a.userId, a.studioId), key);
    expect(typeof observed).toBe("number");
    // Meanwhile the reminder resolved and was cleared elsewhere, recurred, and the owner dismissed it AGAIN (same token) in tab B.
    expect(await restore(a.userId, a.studioId, key)).toEqual({ ok: true, changed: true });
    expect(await dismiss(a.userId, a.studioId, key, "2026-11-03")).toEqual({ ok: true, changed: true });
    const newer = seqOf(await list(a.userId, a.studioId), key);
    expect(newer).toBeGreaterThan(observed);
    // Tab A's delayed clear carries the OLD event: it must not touch the newer dismissal.
    expect(await restoreIf(a.userId, a.studioId, key, observed)).toEqual({ ok: true, changed: false });
    expect(keys(await list(a.userId, a.studioId))).toContain(key);
    expect(seqOf(await list(a.userId, a.studioId), key)).toBe(newer);
    // The ordinary case: the observed event IS still the latest, so it is restored.
    expect(await restoreIf(a.userId, a.studioId, key, newer)).toEqual({ ok: true, changed: true });
    expect(keys(await list(a.userId, a.studioId))).not.toContain(key);
    // NEGATIVE CONTROLS: a NULL observed event is refused (never read as "the latest"); a missing argument does not resolve to any command.
    expect(await dismiss(a.userId, a.studioId, key, "2026-11-05")).toEqual({ ok: true, changed: true });
    const live = seqOf(await list(a.userId, a.studioId), key);
    const nullSeq = await asUser(a.userId, async (q) => (await q(`select public.restore_attention_item_if_latest($1,$2,null::bigint) as r`, [a.studioId, key])).rows[0].r);
    expect(nullSeq).toEqual({ ok: false, code: "invalid_item" });
    expect(keys(await list(a.userId, a.studioId))).toContain(key); // untouched
    await expect(asUser(a.userId, async (q) => q(`select public.restore_attention_item_if_latest($1,$2)`, [a.studioId, key]))).rejects.toThrow(/does not exist|function/);
    expect(keys(await list(a.userId, a.studioId))).toContain(key);
    // A stale (lower) and a made-up (higher) observed event both restore nothing.
    expect(await restoreIf(a.userId, a.studioId, key, live - 1)).toEqual({ ok: true, changed: false });
    expect(await restoreIf(a.userId, a.studioId, key, live + 1000)).toEqual({ ok: true, changed: false });
    expect(keys(await list(a.userId, a.studioId))).toContain(key);
    // Owner-only like the others: a non-owner member is refused, and the table is unchanged.
    expect(await asUser(member.userId, async (q) => (await q(`select public.restore_attention_item_if_latest($1,$2,$3) as r`, [a.studioId, key, live])).rows[0].r)).toEqual({ ok: false, code: "refused" });
    expect(await restoreIf(a.userId, a.studioId, key, live)).toEqual({ ok: true, changed: true });
    // A conditional restore on a key with nothing dismissed is a quiet no-op, and the unconditional form still works for the owner's own Restore.
    expect(await restoreIf(a.userId, a.studioId, key, live)).toEqual({ ok: true, changed: false });
    expect(await dismiss(a.userId, a.studioId, key, "2026-11-06")).toEqual({ ok: true, changed: true });
    expect(await restore(a.userId, a.studioId, key)).toEqual({ ok: true, changed: true });
  });
  it("AP2: clearing a resolved studio reminder is one restore; the same state returning later is a fresh item, and no other dismissal moves", async () => {
    const studioKey = "intake_review:studio";
    const clientKey = "intake:c7:intake_review";
    expect(await dismiss(a.userId, a.studioId, studioKey, "2026-11-02")).toEqual({ ok: true, changed: true });
    expect(await dismiss(a.userId, a.studioId, clientKey, "2026-11-02")).toEqual({ ok: true, changed: true });
    // The reminder resolves: the page clears ONLY that key with the existing restore command.
    expect(await restore(a.userId, a.studioId, studioKey)).toEqual({ ok: true, changed: true });
    const cleared = keys(await list(a.userId, a.studioId));
    expect(cleared).not.toContain(studioKey);
    expect(cleared).toContain(clientKey);
    // A second clear is a quiet no-op (a page reload before it recurs).
    expect(await restore(a.userId, a.studioId, studioKey)).toEqual({ ok: true, changed: false });
    // It recurs with the same token: it is no longer dismissed, so it shows again.
    expect(keys(await list(a.userId, a.studioId))).not.toContain(studioKey);
    // The history is append-only: dismiss, restore, then a deliberate dismiss again all stand.
    expect(await dismiss(a.userId, a.studioId, studioKey, "2026-11-02")).toEqual({ ok: true, changed: true });
    const events = await adminQuery(
      `select action from public.dashboard_attention_events where studio_id = $1 and item_key = $2 order by seq`,
      [a.studioId, studioKey],
    );
    expect(events.rows.map((r: { action: string }) => r.action)).toEqual(["dismiss", "restore", "dismiss"]);
  });
});

describe("owner-only, enforced by the database", () => {
  it("refuses a non-owner member on all three commands, and writes nothing", async () => {
    const before = await adminQuery(`select count(*)::int as n from public.dashboard_attention_events where studio_id = $1`, [a.studioId]);
    expect(await dismiss(member.userId, a.studioId, "x:1", "1")).toEqual({ ok: false, code: "refused" });
    expect(await restore(member.userId, a.studioId, "x:1")).toEqual({ ok: false, code: "refused" });
    expect(await list(member.userId, a.studioId)).toEqual({ ok: false, code: "refused" });
    const after = await adminQuery(`select count(*)::int as n from public.dashboard_attention_events where studio_id = $1`, [a.studioId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
  it("refuses another studio's owner and an unknown user", async () => {
    expect(await dismiss(b.userId, a.studioId, "x:1", "1")).toEqual({ ok: false, code: "refused" });
    expect(await list(b.userId, a.studioId)).toEqual({ ok: false, code: "refused" });
    expect(await dismiss(randomUUID(), a.studioId, "x:1", "1")).toEqual({ ok: false, code: "refused" });
  });
  it("anon and service_role cannot call the commands", async () => {
    for (const role of ["anon", "service_role"] as const) {
      await expect(asRole(role, (q) => q(`select public.dismiss_attention_item($1,'x:1','1')`, [a.studioId]))).rejects.toThrow(/permission denied/);
      await expect(asRole(role, (q) => q(`select public.list_dismissed_attention($1)`, [a.studioId]))).rejects.toThrow(/permission denied/);
    }
  });
  it("no API role can read or write the table directly", async () => {
    for (const role of ["anon", "authenticated", "service_role"] as const) {
      await expect(asRole(role, (q) => q(`select * from public.dashboard_attention_events`))).rejects.toThrow(/permission denied/);
      await expect(
        asRole(role, (q) => q(`insert into public.dashboard_attention_events (studio_id,user_id,item_key,instance_token,action) values ($1,$2,'k','1','dismiss')`, [a.studioId, a.userId])),
      ).rejects.toThrow(/permission denied/);
    }
  });
});

describe("bounded input", () => {
  it("rejects malformed keys and tokens without writing", async () => {
    for (const [k, t] of [["", "1"], ["x:1", ""], ["has space", "1"], ["x:1", "a b"], ["x".repeat(201), "1"], ["x:1", "t".repeat(201)], ["x;drop", "1"]]) {
      expect(await dismiss(a.userId, a.studioId, k, t)).toEqual({ ok: false, code: "invalid_item" });
    }
    expect(await restore(a.userId, a.studioId, "bad key")).toEqual({ ok: false, code: "invalid_item" });
  });
});

describe("append-only", () => {
  it("even the table owner cannot update or delete an event", async () => {
    await dismiss(a.userId, a.studioId, "append:only", "1");
    await expect(adminQuery(`update public.dashboard_attention_events set action = 'restore' where studio_id = $1 and item_key = 'append:only'`, [a.studioId])).rejects.toThrow(/append-only/);
    await expect(adminQuery(`delete from public.dashboard_attention_events where studio_id = $1 and item_key = 'append:only'`, [a.studioId])).rejects.toThrow(/never deleted/);
  });
  it("removing the whole studio still works (the events are a view preference, not financial history)", async () => {
    const c = await seedStudio("dismiss-c");
    await dismiss(c.userId, c.studioId, "gone:1", "1");
    await expect(adminQuery(`delete from public.studios where id = $1`, [c.studioId])).resolves.toBeDefined();
    const left = await adminQuery(`select count(*)::int as n from public.dashboard_attention_events where studio_id = $1`, [c.studioId]);
    expect(left.rows[0].n).toBe(0);
  });
});

describe("dismissal never touches money, setup or access", () => {
  // Row hashes of every table this feature must not change, for the studio, before and after dismiss and restore.
  const hashes = async (s: SeededStudio) => {
    const out: Record<string, string> = {};
    const tables: Array<[string, string]> = [
      ["payment_charge_attempts", "studio_id"],
      ["appointment_settlements", "studio_id"],
      ["studio_payment_jurisdictions", "studio_id"],
      ["practitioners", "studio_id"],
      ["appointments", "studio_id"],
    ];
    for (const [t, col] of tables) {
      const r = await adminQuery(`select coalesce(md5(string_agg(x::text, '|' order by x::text)), 'empty') as h, count(*)::int as n from public.${t} x where ${col} = $1`, [s.studioId]);
      out[t] = `${r.rows[0].n}:${r.rows[0].h}`;
    }
    const st = await adminQuery(`select md5(x::text) as h from public.studios x where id = $1`, [s.studioId]);
    out.studios = st.rows[0].h;
    return out;
  };
  it("row hashes are identical before and after dismiss, a re-dismiss with a new token, and restore", async () => {
    const { sessionId } = await seedSession(a);
    await adminQuery(
      `insert into public.payment_charge_attempts (id, studio_id, client_id, session_id, charge_reason, created_by_practitioner_id, amount_cents, status, stripe_livemode)
       values ($1,$2,$3,$4,'session_payment',$5,2500,'ready',false)`,
      [randomUUID(), a.studioId, a.clientId, sessionId, a.practitionerId],
    );
    const before = await hashes(a);
    expect(before.payment_charge_attempts.startsWith("0:")).toBe(false);
    await dismiss(a.userId, a.studioId, "unpaid:money-check", "c2500");
    await dismiss(a.userId, a.studioId, "unpaid:money-check", "c9900");
    await dismiss(a.userId, a.studioId, "setup:payments_not_connected", "1");
    await restore(a.userId, a.studioId, "unpaid:money-check");
    expect(await hashes(a)).toEqual(before);
  });
  it("the commands' bodies name no money, setup or access table (plpgsql dependencies are not tracked, so the source is read)", async () => {
    const src = await adminQuery(
      `select proname, prosrc from pg_proc where pronamespace = 'public'::regnamespace and proname in ('dismiss_attention_item','restore_attention_item','list_dismissed_attention')`,
    );
    expect(src.rows).toHaveLength(3);
    for (const r of src.rows as { proname: string; prosrc: string }[]) {
      expect(r.prosrc, r.proname).not.toMatch(/payment|settlement|appointment|jurisdiction|stripe|membership|permission/i);
      expect(r.prosrc, r.proname).not.toMatch(/\b(update|delete)\b/i);
    }
  });
});
