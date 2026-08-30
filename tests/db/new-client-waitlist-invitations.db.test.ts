import { afterAll, describe, expect, it } from "vitest";
import { adminQuery, closePool, seedMember, seedStudio } from "./helpers/harness";

// 0188 — WAIT-03 private invitation lifecycle, proved against a real local
// PostgreSQL.
//
// The static contract (what the migration SAYS) is pinned in
// tests/migrations/0188-new-client-waitlist-invitations.test.ts. This file
// proves the BEHAVIOUR that file cannot see: that the exact-N claim really
// partitions under concurrency, that a token really redeems exactly once, that
// an expired token is refused FOR THAT REASON, and that a prospect holding a
// live token really cannot be removed.
//
// Fixtures are isolated by run-unique identity (seedStudio mints random UUIDs),
// never by cleanup, so this suite is safe to re-run against the same database.

afterAll(async () => {
  await closePool();
});

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "NO_ERROR";
  } catch (e) {
    return (e as { code?: string }).code ?? "UNKNOWN";
  }
}

async function join(studioId: string, email: string) {
  const r = await adminQuery(
    `select result, entry_id from public.join_new_client_waitlist($1, $2, $3, null)`,
    [studioId, `Name ${email}`, email],
  );
  return r.rows[0] as { result: string; entry_id: string | null };
}

async function claim(studioId: string, entryId: string, userId: string) {
  const r = await adminQuery(
    `select public.claim_new_client_waitlist_entry($1, $2, $3) as r`,
    [studioId, entryId, userId],
  );
  return r.rows[0].r as string;
}

async function issue(
  studioId: string,
  entryId: string,
  userId: string,
  ttl?: number,
) {
  const r =
    ttl === undefined
      ? await adminQuery(
          `select result, raw_token, expires_at
             from public.issue_new_client_waitlist_invitation($1, $2, $3)`,
          [studioId, entryId, userId],
        )
      : await adminQuery(
          `select result, raw_token, expires_at
             from public.issue_new_client_waitlist_invitation($1, $2, $3, $4)`,
          [studioId, entryId, userId, ttl],
        );
  return r.rows[0] as {
    result: string;
    raw_token: string | null;
    expires_at: Date | null;
  };
}

async function redeem(token: string | null) {
  const r = await adminQuery(
    `select result, studio_id, entry_id
       from public.redeem_new_client_waitlist_invitation($1)`,
    [token],
  );
  return r.rows[0] as { result: string; studio_id: string | null };
}

async function statusOf(entryId: string): Promise<string> {
  const r = await adminQuery(
    `select status from public.new_client_waitlist_entries where id = $1`,
    [entryId],
  );
  return r.rows[0]?.status as string;
}

describe("0188 — the lifecycle end to end", () => {
  it("joins, claims, invites, redeems and records a conversion", async () => {
    const s = await seedStudio("wait03-happy");
    const j = await join(s.studioId, `happy-${s.studioId.slice(0, 8)}@ex.com`);
    expect(j.result).toBe("created");
    const entry = j.entry_id as string;

    expect(await claim(s.studioId, entry, s.userId)).toBe("claimed");

    const inv = await issue(s.studioId, entry, s.userId);
    expect(inv.result).toBe("invited");
    expect(inv.raw_token).toMatch(/^[a-f0-9]{64}$/);
    expect(await statusOf(entry)).toBe("invited");

    const red = await redeem(inv.raw_token);
    expect(red.result).toBe("redeemed");
    expect(red.studio_id).toBe(s.studioId);

    const conv = await adminQuery(
      `select public.record_new_client_waitlist_conversion($1, $2, $3) as r`,
      [s.studioId, entry, s.clientId],
    );
    expect(conv.rows[0].r).toBe("converted");
    expect(await statusOf(entry)).toBe("converted");
  });

  it("defaults the invitation window to 72 hours", async () => {
    const s = await seedStudio("wait03-ttl72");
    const j = await join(s.studioId, `ttl72-${s.studioId.slice(0, 8)}@ex.com`);
    await claim(s.studioId, j.entry_id as string, s.userId);
    const inv = await issue(s.studioId, j.entry_id as string, s.userId);
    const hours = await adminQuery(
      `select round(extract(epoch from ($1::timestamptz - now()))/3600) as h`,
      [inv.expires_at],
    );
    expect(Number(hours.rows[0].h)).toBe(72);
  });
});

describe("0188 — concurrency", () => {
  it("exact-N claim partitions the queue: concurrent operators never share a row", async () => {
    const s = await seedStudio("wait03-exactn");
    const wanted = 12;
    for (let i = 0; i < wanted; i++) {
      await join(s.studioId, `q${i}-${s.studioId.slice(0, 8)}@ex.com`);
    }

    // Four operators each ask for 3, concurrently, against 12 waiting rows.
    const results = await Promise.all(
      [0, 1, 2, 3].map(() =>
        adminQuery(
          `select entry_id from public.claim_new_client_waitlist_entries($1, $2, 3)`,
          [s.studioId, s.userId],
        ),
      ),
    );
    const ids = results.flatMap((r) => r.rows.map((x) => x.entry_id as string));

    // Every claimed row is distinct: SKIP LOCKED partitions rather than
    // handing the same prospect to two operators.
    expect(ids.length).toBe(new Set(ids).size);

    const claimed = await adminQuery(
      `select count(*)::int as n from public.new_client_waitlist_entries
        where studio_id = $1 and status = 'claimed'`,
      [s.studioId],
    );
    expect(claimed.rows[0].n).toBe(ids.length);
  });

  it("a token redeems exactly once under concurrent redemption", async () => {
    const s = await seedStudio("wait03-single");
    const j = await join(s.studioId, `single-${s.studioId.slice(0, 8)}@ex.com`);
    await claim(s.studioId, j.entry_id as string, s.userId);
    const inv = await issue(s.studioId, j.entry_id as string, s.userId);

    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => redeem(inv.raw_token)),
    );
    expect(outcomes.filter((o) => o.result === "redeemed")).toHaveLength(1);
    expect(outcomes.filter((o) => o.result === "invalid_token")).toHaveLength(7);

    const rows = await adminQuery(
      `select count(*)::int as n from public.new_client_waitlist_invitations
        where entry_id = $1 and redeemed_at is not null`,
      [j.entry_id],
    );
    expect(rows.rows[0].n).toBe(1);
  });
});

describe("0188 — the token", () => {
  it("is never stored in the clear, and the stored value is its sha256", async () => {
    const s = await seedStudio("wait03-hash");
    const j = await join(s.studioId, `hash-${s.studioId.slice(0, 8)}@ex.com`);
    await claim(s.studioId, j.entry_id as string, s.userId);
    const inv = await issue(s.studioId, j.entry_id as string, s.userId);

    const row = await adminQuery(
      `select token_hash,
              (token_hash = encode(extensions.digest($2,'sha256'),'hex')) as matches
         from public.new_client_waitlist_invitations where entry_id = $1`,
      [j.entry_id, inv.raw_token],
    );
    expect(row.rows[0].matches).toBe(true);
    expect(row.rows[0].token_hash).not.toBe(inv.raw_token);

    // No column anywhere in the table can hold the raw value.
    const cols = await adminQuery(
      `select count(*)::int as n from information_schema.columns
        where table_schema='public' and table_name='new_client_waitlist_invitations'
          and column_name like '%token%' and column_name <> 'token_hash'`,
    );
    expect(cols.rows[0].n).toBe(0);
  });

  it("refuses replay, forgery and malformed input with ONE indistinguishable code", async () => {
    const s = await seedStudio("wait03-oracle");
    const j = await join(s.studioId, `oracle-${s.studioId.slice(0, 8)}@ex.com`);
    await claim(s.studioId, j.entry_id as string, s.userId);
    const inv = await issue(s.studioId, j.entry_id as string, s.userId);
    expect((await redeem(inv.raw_token)).result).toBe("redeemed");

    expect((await redeem(inv.raw_token)).result).toBe("invalid_token");
    expect((await redeem("f".repeat(64))).result).toBe("invalid_token");
    expect((await redeem("short")).result).toBe("invalid_token");
    expect((await redeem(null)).result).toBe("invalid_token");
  });

  it("refuses an EXPIRED token — and the negative control proves TTL was the cause", async () => {
    const s = await seedStudio("wait03-expiry");
    const j = await join(s.studioId, `exp-${s.studioId.slice(0, 8)}@ex.com`);
    const entry = j.entry_id as string;
    await claim(s.studioId, entry, s.userId);
    const inv = await issue(s.studioId, entry, s.userId);

    // Push the window into the past. The server-timestamp trigger owns
    // issued_at and the append-only trigger freezes expires_at, so the ONLY
    // way to construct an expired row is as the table owner with both
    // disabled — which is itself proof that no application role can do it.
    await adminQuery(
      `alter table public.new_client_waitlist_invitations disable trigger new_client_waitlist_invitations_append_only`,
    );
    await adminQuery(
      `update public.new_client_waitlist_invitations
          set issued_at = now() - interval '4 days', expires_at = now() - interval '1 day'
        where entry_id = $1`,
      [entry],
    );
    await adminQuery(
      `alter table public.new_client_waitlist_invitations enable trigger new_client_waitlist_invitations_append_only`,
    );

    expect((await redeem(inv.raw_token)).result).toBe("invalid_token");

    // NEGATIVE CONTROL: same row, same token, expiry moved forward.
    await adminQuery(
      `alter table public.new_client_waitlist_invitations disable trigger new_client_waitlist_invitations_append_only`,
    );
    await adminQuery(
      `update public.new_client_waitlist_invitations
          set expires_at = now() + interval '1 day' where entry_id = $1`,
      [entry],
    );
    await adminQuery(
      `alter table public.new_client_waitlist_invitations enable trigger new_client_waitlist_invitations_append_only`,
    );
    expect((await redeem(inv.raw_token)).result).toBe("redeemed");
  });

  it("refuses a TTL outside 1..168 hours rather than clamping it", async () => {
    const s = await seedStudio("wait03-ttlbounds");
    const j = await join(s.studioId, `ttlb-${s.studioId.slice(0, 8)}@ex.com`);
    const entry = j.entry_id as string;
    await claim(s.studioId, entry, s.userId);

    for (const bad of [0, -5, 169, 9999]) {
      expect((await issue(s.studioId, entry, s.userId, bad)).result).toBe(
        "invalid_ttl",
      );
    }
    // The ceiling itself is legal.
    expect((await issue(s.studioId, entry, s.userId, 168)).result).toBe("invited");
  });

  it("permits no second live invitation and no extension of the window", async () => {
    const s = await seedStudio("wait03-renew");
    const j = await join(s.studioId, `renew-${s.studioId.slice(0, 8)}@ex.com`);
    const entry = j.entry_id as string;
    await claim(s.studioId, entry, s.userId);
    await issue(s.studioId, entry, s.userId);

    // The entry has left `claimed`, so a second issue is refused outright.
    expect((await issue(s.studioId, entry, s.userId)).result).toBe("not_claimed");

    // And the window itself cannot be pushed outward.
    const code = await codeOf(() =>
      adminQuery(
        `update public.new_client_waitlist_invitations
            set expires_at = now() + interval '6 days' where entry_id = $1`,
        [entry],
      ),
    );
    expect(code).toBe("23514");
  });
});

describe("0188 — the removal ruling", () => {
  it("refuses to remove a CLAIMED or INVITED entry, and says why", async () => {
    const s = await seedStudio("wait03-removal");
    const j = await join(s.studioId, `rm-${s.studioId.slice(0, 8)}@ex.com`);
    const entry = j.entry_id as string;
    await claim(s.studioId, entry, s.userId);

    const claimedAnswer = await adminQuery(
      `select public.remove_new_client_waitlist_entry($1,$2,$3) as r`,
      [s.studioId, entry, s.userId],
    );
    expect(claimedAnswer.rows[0].r).toBe("release_required");

    await issue(s.studioId, entry, s.userId);
    const invitedAnswer = await adminQuery(
      `select public.remove_new_client_waitlist_entry($1,$2,$3) as r`,
      [s.studioId, entry, s.userId],
    );
    expect(invitedAnswer.rows[0].r).toBe("release_required");
  });

  it("has no invited -> removed edge AT ALL — the trigger refuses a direct write", async () => {
    const s = await seedStudio("wait03-noedge");
    const j = await join(s.studioId, `edge-${s.studioId.slice(0, 8)}@ex.com`);
    const entry = j.entry_id as string;
    await claim(s.studioId, entry, s.userId);
    await issue(s.studioId, entry, s.userId);

    const code = await codeOf(() =>
      adminQuery(
        `update public.new_client_waitlist_entries
            set status='removed', removed_at=now(), removed_by_practitioner_id=$2
          where id = $1`,
        [entry, s.practitionerId],
      ),
    );
    // check_violation raised by the transition guard.
    expect(code).toBe("23514");
    expect(await statusOf(entry)).toBe("invited");
  });

  it("release invalidates the live token, and only then may the entry be removed", async () => {
    const s = await seedStudio("wait03-release");
    const j = await join(s.studioId, `rel-${s.studioId.slice(0, 8)}@ex.com`);
    const entry = j.entry_id as string;
    await claim(s.studioId, entry, s.userId);
    const inv = await issue(s.studioId, entry, s.userId);

    const rel = await adminQuery(
      `select public.release_new_client_waitlist_entry($1,$2,$3) as r`,
      [s.studioId, entry, s.userId],
    );
    expect(rel.rows[0].r).toBe("released");

    // The token is dead the moment the entry is released.
    expect((await redeem(inv.raw_token)).result).toBe("invalid_token");

    const rm = await adminQuery(
      `select public.remove_new_client_waitlist_entry($1,$2,$3) as r`,
      [s.studioId, entry, s.userId],
    );
    expect(rm.rows[0].r).toBe("removed");
    expect(await statusOf(entry)).toBe("removed");
  });

  it("never deletes an invitation — provenance survives removal", async () => {
    const s = await seedStudio("wait03-prov");
    const j = await join(s.studioId, `prov-${s.studioId.slice(0, 8)}@ex.com`);
    const entry = j.entry_id as string;
    await claim(s.studioId, entry, s.userId);
    await issue(s.studioId, entry, s.userId);

    const code = await codeOf(() =>
      adminQuery(
        `delete from public.new_client_waitlist_invitations where entry_id = $1`,
        [entry],
      ),
    );
    expect(code).toBe("23514");
  });
});

describe("0188 — tenancy and authority", () => {
  it("refuses an operator from another studio", async () => {
    const a = await seedStudio("wait03-tenant-a");
    const b = await seedStudio("wait03-tenant-b");
    const j = await join(a.studioId, `ten-${a.studioId.slice(0, 8)}@ex.com`);
    const entry = j.entry_id as string;

    expect(await claim(a.studioId, entry, b.userId)).toBe("not_a_member");
    const rm = await adminQuery(
      `select public.remove_new_client_waitlist_entry($1,$2,$3) as r`,
      [a.studioId, entry, b.userId],
    );
    expect(rm.rows[0].r).toBe("not_a_member");
  });

  it("refuses a non-owner member of the SAME studio", async () => {
    const s = await seedStudio("wait03-member");
    const m = await seedMember(s, "wait03-nonowner");
    const j = await join(s.studioId, `mem-${s.studioId.slice(0, 8)}@ex.com`);
    expect(await claim(s.studioId, j.entry_id as string, m.userId)).toBe(
      "not_owner",
    );
  });

  it("refuses a conversion pointing at another studio's client", async () => {
    const a = await seedStudio("wait03-conv-a");
    const b = await seedStudio("wait03-conv-b");
    const j = await join(a.studioId, `conv-${a.studioId.slice(0, 8)}@ex.com`);
    const entry = j.entry_id as string;
    await claim(a.studioId, entry, a.userId);
    await issue(a.studioId, entry, a.userId);

    const r = await adminQuery(
      `select public.record_new_client_waitlist_conversion($1,$2,$3) as r`,
      [a.studioId, entry, b.clientId],
    );
    expect(r.rows[0].r).toBe("client_not_found");
    expect(await statusOf(entry)).toBe("invited");
  });
});

describe("0188 — the duplicate law and its coupled command", () => {
  it("keeps ONE live row and answers already_waiting while claimed or invited", async () => {
    // THE REGRESSION THIS EXISTS FOR: widening the active index without
    // replacing join_new_client_waitlist makes this return 'unknown' —
    // telling a real visitor their join failed.
    const s = await seedStudio("wait03-dup");
    const email = `dup-${s.studioId.slice(0, 8)}@ex.com`;
    const first = await join(s.studioId, email);
    const entry = first.entry_id as string;
    expect(first.result).toBe("created");

    await claim(s.studioId, entry, s.userId);
    const whileClaimed = await join(s.studioId, email);
    expect(whileClaimed.result).toBe("already_waiting");
    expect(whileClaimed.entry_id).toBe(entry);

    await issue(s.studioId, entry, s.userId);
    const whileInvited = await join(s.studioId, email);
    expect(whileInvited.result).toBe("already_waiting");

    const n = await adminQuery(
      `select count(*)::int as n from public.new_client_waitlist_entries
        where studio_id = $1 and email_normalized = $2`,
      [s.studioId, email],
    );
    expect(n.rows[0].n).toBe(1);
  });
});

describe("0188 — privilege", () => {
  it("gives authenticated SELECT only, and anon/service_role no table rights", async () => {
    const r = await adminQuery(
      `select rolname, priv, has_table_privilege(rolname,'public.new_client_waitlist_invitations',priv) as ok
         from (values('anon'),('authenticated'),('service_role')) t(rolname),
              (values('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('MAINTAIN')) p(priv)`,
    );
    for (const row of r.rows as { rolname: string; priv: string; ok: boolean }[]) {
      const expected = row.rolname === "authenticated" && row.priv === "SELECT";
      expect(row.ok, `${row.rolname} ${row.priv}`).toBe(expected);
    }
  });

  it("grants every command to service_role ONLY", async () => {
    const r = await adminQuery(
      `select p.proname,
              has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth,
              has_function_privilege('service_role', p.oid, 'EXECUTE') as svc
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in (
            'join_new_client_waitlist','remove_new_client_waitlist_entry',
            'claim_new_client_waitlist_entries','claim_new_client_waitlist_entry',
            'issue_new_client_waitlist_invitation','redeem_new_client_waitlist_invitation',
            'expire_new_client_waitlist_invitation','release_new_client_waitlist_entry',
            'requeue_new_client_waitlist_entry','record_new_client_waitlist_conversion')`,
    );
    expect(r.rows).toHaveLength(10);
    for (const row of r.rows as {
      proname: string;
      anon: boolean;
      auth: boolean;
      svc: boolean;
    }[]) {
      expect(row.anon, `${row.proname} anon`).toBe(false);
      expect(row.auth, `${row.proname} authenticated`).toBe(false);
      expect(row.svc, `${row.proname} service_role`).toBe(true);
    }
  });

  it("grants the internal helper and trigger functions to nobody", async () => {
    const r = await adminQuery(
      `select p.proname,
              has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth,
              has_function_privilege('service_role', p.oid, 'EXECUTE') as svc
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in (
            'new_client_waitlist_resolve_owner',
            'new_client_waitlist_invitations_server_timestamps',
            'new_client_waitlist_invitations_append_only',
            'new_client_waitlist_invitations_no_delete')`,
    );
    expect(r.rows).toHaveLength(4);
    for (const row of r.rows as {
      proname: string;
      anon: boolean;
      auth: boolean;
      svc: boolean;
    }[]) {
      expect(row.anon || row.auth || row.svc, row.proname).toBe(false);
    }
  });

  it("enables RLS with exactly one owner-only SELECT policy", async () => {
    const r = await adminQuery(
      `select polname, polcmd::text as cmd, pg_get_expr(polqual, polrelid) as qual
         from pg_policy where polrelid = 'public.new_client_waitlist_invitations'::regclass`,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].cmd).toBe("r");
    expect(r.rows[0].qual).toContain("is_studio_owner");
  });
});

describe("0188 — lifecycle provenance", () => {
  async function trail(entryId: string) {
    const r = await adminQuery(
      `select from_status, to_status, actor_practitioner_id
         from public.new_client_waitlist_entry_events
        where entry_id = $1 order by occurred_at, id`,
      [entryId],
    );
    return r.rows as {
      from_status: string | null;
      to_status: string;
      actor_practitioner_id: string | null;
    }[];
  }

  it("records a claim/release cycle that issues NO invitation and is then requeued", async () => {
    // THE REGRESSION THIS EXISTS FOR. requeue clears the cycle evidence, and
    // this path issues no invitation, so there is no invitation row either.
    // Before the event log, an operator's claim and release left ZERO
    // persisted state and the prospect looked like a fresh join.
    const s = await seedStudio("wait03-prov-cycle");
    const j = await join(s.studioId, `cyc-${s.studioId.slice(0, 8)}@ex.com`);
    const entry = j.entry_id as string;

    await claim(s.studioId, entry, s.userId);
    await adminQuery(
      `select public.release_new_client_waitlist_entry($1,$2,$3)`,
      [s.studioId, entry, s.userId],
    );
    await adminQuery(
      `select public.requeue_new_client_waitlist_entry($1,$2,$3)`,
      [s.studioId, entry, s.userId],
    );

    // The entry itself is correctly back to a clean `waiting`...
    const row = await adminQuery(
      `select status, claimed_at, released_at from public.new_client_waitlist_entries where id = $1`,
      [entry],
    );
    expect(row.rows[0].status).toBe("waiting");
    expect(row.rows[0].claimed_at).toBeNull();
    expect(row.rows[0].released_at).toBeNull();

    // ...and no invitation row exists, because none was ever issued.
    const inv = await adminQuery(
      `select count(*)::int as n from public.new_client_waitlist_invitations where entry_id = $1`,
      [entry],
    );
    expect(inv.rows[0].n).toBe(0);

    // The history nevertheless survives, in full, with the actor.
    const t = await trail(entry);
    expect(t.map((e) => `${e.from_status ?? "(new)"}->${e.to_status}`)).toEqual([
      "(new)->waiting",
      "waiting->claimed",
      "claimed->released",
      "released->waiting",
    ]);
    expect(t[1].actor_practitioner_id).toBe(s.practitionerId);
    expect(t[3].actor_practitioner_id).toBe(s.practitionerId);
  });

  it("records the full invite-to-conversion trail too", async () => {
    const s = await seedStudio("wait03-prov-full");
    const j = await join(s.studioId, `full-${s.studioId.slice(0, 8)}@ex.com`);
    const entry = j.entry_id as string;
    await claim(s.studioId, entry, s.userId);
    const inv = await issue(s.studioId, entry, s.userId);
    await redeem(inv.raw_token);
    await adminQuery(
      `select public.record_new_client_waitlist_conversion($1,$2,$3)`,
      [s.studioId, entry, s.clientId],
    );
    const t = await trail(entry);
    expect(t.map((e) => e.to_status)).toEqual([
      "waiting",
      "claimed",
      "invited",
      "converted",
    ]);
  });

  it("is append-only against UPDATE and DELETE alike", async () => {
    const s = await seedStudio("wait03-prov-append");
    const j = await join(s.studioId, `app-${s.studioId.slice(0, 8)}@ex.com`);
    const entry = j.entry_id as string;

    expect(
      await codeOf(() =>
        adminQuery(
          `update public.new_client_waitlist_entry_events set to_status = 'removed' where entry_id = $1`,
          [entry],
        ),
      ),
    ).toBe("23514");
    expect(
      await codeOf(() =>
        adminQuery(
          `delete from public.new_client_waitlist_entry_events where entry_id = $1`,
          [entry],
        ),
      ),
    ).toBe("23514");
  });

  it("logs a transition even when it is written directly, not through a command", async () => {
    // The trigger is the authority, so no future direct write through the
    // migration channel can transition an entry without leaving a trace.
    const s = await seedStudio("wait03-prov-direct");
    const j = await join(s.studioId, `dir-${s.studioId.slice(0, 8)}@ex.com`);
    const entry = j.entry_id as string;
    await adminQuery(
      `update public.new_client_waitlist_entries
          set status='removed', removed_at=now(), removed_by_practitioner_id=$2
        where id = $1`,
      [entry, s.practitionerId],
    );
    const t = await trail(entry);
    expect(t.map((e) => e.to_status)).toEqual(["waiting", "removed"]);
    expect(t[1].actor_practitioner_id).toBe(s.practitionerId);
  });

  it("keeps the event log owner-only and read-only", async () => {
    const g = await adminQuery(
      `select rolname, priv, has_table_privilege(rolname,'public.new_client_waitlist_entry_events',priv) as ok
         from (values('anon'),('authenticated'),('service_role')) t(rolname),
              (values('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('MAINTAIN')) p(priv)`,
    );
    for (const row of g.rows as { rolname: string; priv: string; ok: boolean }[]) {
      expect(row.ok, `${row.rolname} ${row.priv}`).toBe(
        row.rolname === "authenticated" && row.priv === "SELECT",
      );
    }
    const p = await adminQuery(
      `select polcmd::text as cmd, pg_get_expr(polqual, polrelid) as qual
         from pg_policy where polrelid = 'public.new_client_waitlist_entry_events'::regclass`,
    );
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0].cmd).toBe("r");
    expect(p.rows[0].qual).toContain("is_studio_owner");
  });
});
