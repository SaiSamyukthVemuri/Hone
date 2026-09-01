import { afterAll, describe, expect, it } from "vitest";
import { adminQuery, adminTx, asUser, closePool, seedMember, seedStudio } from "./helpers/harness";

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

// EXPIRY NOW MEANS THE TTL ELAPSED, so a test that wants a genuinely expired
// invitation must move the window into the past. The server-timestamp trigger
// owns issued_at and the append-only trigger freezes expires_at, so this is
// only possible as the table owner with the trigger disabled -- which is itself
// the proof that no application role can manufacture an expiry. The ttl CHECK
// (expires_at > issued_at, and within 7 days of it) means both move together.
async function elapseTtl(entryId: string): Promise<void> {
  await adminQuery(
    `alter table public.new_client_waitlist_invitations disable trigger new_client_waitlist_invitations_append_only`,
  );
  await adminQuery(
    `update public.new_client_waitlist_invitations
        set issued_at = now() - interval '4 days', expires_at = now() - interval '1 minute'
      where entry_id = $1 and expired_at is null and released_at is null`,
    [entryId],
  );
  await adminQuery(
    `alter table public.new_client_waitlist_invitations enable trigger new_client_waitlist_invitations_append_only`,
  );
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
  it("gives NO role a whole-table right — authenticated reads named columns only", async () => {
    // token_hash is the verifier for a live credential, so whole-table SELECT
    // was withdrawn: RLS scopes ROWS, never COLUMNS, and a plain table grant
    // let an authenticated owner read the hash for every row their studio could
    // see. has_table_privilege reports SELECT only when EVERY column is
    // readable, so `authenticated` is now false here too — by design.
    const r = await adminQuery(
      `select rolname, priv, has_table_privilege(rolname,'public.new_client_waitlist_invitations',priv) as ok
         from (values('anon'),('authenticated'),('service_role')) t(rolname),
              (values('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('MAINTAIN')) p(priv)`,
    );
    for (const row of r.rows as { rolname: string; priv: string; ok: boolean }[]) {
      expect(row.ok, `${row.rolname} ${row.priv}`).toBe(false);
    }
  });

  it("grants authenticated exactly the nine safe columns, and NEVER token_hash", async () => {
    const r = await adminQuery(
      `select column_name from information_schema.column_privileges
        where table_schema='public' and table_name='new_client_waitlist_invitations'
          and grantee='authenticated' and privilege_type='SELECT'
        order by column_name`,
    );
    const granted = r.rows.map((x: { column_name: string }) => x.column_name);
    expect(granted).toEqual([
      "entry_id","expired_at","expires_at","id","issued_at",
      "issued_by_practitioner_id","redeemed_at","released_at","studio_id",
    ]);
    expect(granted, "the credential verifier is never readable").not.toContain("token_hash");

    // Positive list, not a denylist: every live column is either granted or is
    // token_hash. A column added later is unreadable until granted on purpose.
    const live = await adminQuery(
      `select column_name from information_schema.columns
        where table_schema='public' and table_name='new_client_waitlist_invitations'`,
    );
    const all = live.rows.map((x: { column_name: string }) => x.column_name).sort();
    expect(all.filter((c: string) => !granted.includes(c))).toEqual(["token_hash"]);

    // anon and service_role hold no column privilege at all.
    const others = await adminQuery(
      `select count(*)::int as n from information_schema.column_privileges
        where table_schema='public' and table_name='new_client_waitlist_invitations'
          and grantee in ('anon','service_role')`,
    );
    expect(others.rows[0].n).toBe(0);
  });

  it("an authenticated owner reads the safe columns but is DENIED token_hash and SELECT *", async () => {
    const s = await seedStudio("wait03-colpriv");
    const j = await join(s.studioId, `colpriv-${s.studioId.slice(0, 8)}@ex.com`);
    const entry = j.entry_id as string;
    await claim(s.studioId, entry, s.userId);
    await issue(s.studioId, entry, s.userId);

    // Safe projection: allowed, and RLS still scopes it to this owner's studio.
    const safe = await asUser(s.userId, (q) =>
      q(`select id, entry_id, expires_at, redeemed_at from public.new_client_waitlist_invitations`),
    );
    expect(safe.rows.length).toBe(1);

    // The credential verifier: refused by PRIVILEGE, not by convention.
    await expect(
      asUser(s.userId, (q) => q(`select token_hash from public.new_client_waitlist_invitations`)),
    ).rejects.toMatchObject({ code: "42501" });

    // SELECT * necessarily includes it, so it is refused too. Acceptable here
    // because NO runtime module reads this table at all — the export registry
    // entry is a declaration, not a query.
    await expect(
      asUser(s.userId, (q) => q(`select * from public.new_client_waitlist_invitations`)),
    ).rejects.toMatchObject({ code: "42501" });

    // A FOREIGN studio owner sees zero rows through the safe projection: RLS is
    // unchanged and still does the row scoping.
    const other = await seedStudio("wait03-colpriv-b");
    const foreign = await asUser(other.userId, (q) =>
      q(`select id from public.new_client_waitlist_invitations`),
    );
    expect(foreign.rows.length).toBe(0);
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

describe("0188 — the invitations composite key, and what it does and does not do", () => {
  it("exists as a real unique CONSTRAINT, unconditional", async () => {
    const r = await adminQuery(
      `select conname, contype, pg_get_constraintdef(oid) as def
         from pg_constraint
        where conrelid = 'public.new_client_waitlist_invitations'::regclass
          and conname = 'new_client_waitlist_invitations_id_studio_id_unique'`,
    );
    expect(r.rows).toHaveLength(1);
    // contype 'u' -- a unique CONSTRAINT. A bare unique INDEX, and a partial
    // one especially, cannot serve as a foreign-key target at all.
    expect(r.rows[0].contype).toBe("u");
    expect(r.rows[0].def).toMatch(/UNIQUE \(id, studio_id\)/i);
    expect(r.rows[0].def).not.toMatch(/WHERE/i);
  });

  it("prevents NO duplicate that the primary key does not already reject", async () => {
    // This constraint is not a duplicate control and must never be described as
    // one: `id` alone is the PK, and studio_id is frozen by the append-only
    // trigger, so the pair cannot disagree with the single column. A duplicate
    // id is rejected by the PK, never by this constraint.
    const s = await seedStudio("wait03-ck-dup");
    const j = await join(s.studioId, `ckdup-${s.studioId.slice(0, 8)}@ex.com`);
    const entry = j.entry_id as string;
    await claim(s.studioId, entry, s.userId);
    await issue(s.studioId, entry, s.userId);
    const existing = await adminQuery(
      `select id from public.new_client_waitlist_invitations where entry_id = $1`,
      [entry],
    );
    const id = existing.rows[0].id as string;

    let violated = "";
    try {
      await adminQuery(
        `insert into public.new_client_waitlist_invitations
           (id, studio_id, entry_id, token_hash, expires_at, issued_by_practitioner_id)
         values ($1, $2, $3, encode(extensions.digest('dup','sha256'),'hex'), now() + interval '1 day', $4)`,
        [id, s.studioId, entry, s.practitionerId],
      );
    } catch (e) {
      violated = (e as { constraint?: string }).constraint ?? "";
    }
    expect(violated).toBe("new_client_waitlist_invitations_pkey");
  });

  it("lets a child carry a same-studio composite FK: cross-studio RED, own-studio GREEN in every state", async () => {
    const a = await seedStudio("wait03-ck-a");
    const b = await seedStudio("wait03-ck-b");

    // One invitation per terminal state, all in studio A.
    const made: { id: string; state: string }[] = [];
    for (const state of ["live", "redeemed", "released"]) {
      const j = await join(a.studioId, `ck-${state}-${a.studioId.slice(0, 8)}@ex.com`);
      const entry = j.entry_id as string;
      await claim(a.studioId, entry, a.userId);
      const inv = await issue(a.studioId, entry, a.userId);
      if (state === "redeemed") await redeem(inv.raw_token);
      if (state === "released") {
        await adminQuery(
          `select public.release_new_client_waitlist_entry($1,$2,$3)`,
          [a.studioId, entry, a.userId],
        );
      }
      const row = await adminQuery(
        `select id from public.new_client_waitlist_invitations where entry_id = $1`,
        [entry],
      );
      made.push({ id: row.rows[0].id as string, state });
    }
    expect(made).toHaveLength(3);

    // The FK the review asks for is only writable BECAUSE of the constraint.
    await adminQuery(`create schema if not exists wait03_ck`);
    await adminQuery(`drop table if exists wait03_ck.child`);
    await adminQuery(
      `create table wait03_ck.child (
         id uuid primary key default gen_random_uuid(),
         studio_id uuid not null,
         invitation_id uuid,
         constraint child_invitation_same_studio_fk
           foreign key (invitation_id, studio_id)
           references public.new_client_waitlist_invitations (id, studio_id))`,
    );

    try {
      for (const m of made) {
        // GREEN: own studio, regardless of lifecycle state. A partial key
        // predicated on liveness would have failed for redeemed/released here.
        await adminQuery(
          `insert into wait03_ck.child (studio_id, invitation_id) values ($1, $2)`,
          [a.studioId, m.id],
        );
        // RED: another studio's id against the same invitation.
        expect(
          await codeOf(() =>
            adminQuery(
              `insert into wait03_ck.child (studio_id, invitation_id) values ($1, $2)`,
              [b.studioId, m.id],
            ),
          ),
          `cross-studio reference to a ${m.state} invitation must be refused`,
        ).toBe("23503");
      }

      const n = await adminQuery(
        `select count(*)::int as n from wait03_ck.child where studio_id = $1`,
        [a.studioId],
      );
      expect(n.rows[0].n).toBe(3);
      const foreign = await adminQuery(
        `select count(*)::int as n from wait03_ck.child where studio_id = $1`,
        [b.studioId],
      );
      expect(foreign.rows[0].n).toBe(0);
    } finally {
      await adminQuery(`drop schema if exists wait03_ck cascade`);
    }
  });
});

describe("0188 — requeue collision: refused cleanly, reuse preserved, tenant-scoped", () => {
  async function releasedEntry(s: Awaited<ReturnType<typeof seedStudio>>, email: string) {
    const j = await join(s.studioId, email);
    const entry = j.entry_id as string;
    await claim(s.studioId, entry, s.userId);
    await adminQuery(`select public.release_new_client_waitlist_entry($1,$2,$3)`, [
      s.studioId, entry, s.userId,
    ]);
    return entry;
  }
  const requeue = async (studioId: string, entry: string, userId: string) =>
    (await adminQuery(`select public.requeue_new_client_waitlist_entry($1,$2,$3) as r`, [
      studioId, entry, userId,
    ])).rows[0].r as string;

  it("FORBIDDEN: requeue while the person is active again returns a code, never raises", async () => {
    const s = await seedStudio("wait03-rq-dup");
    const email = `rqdup-${s.studioId.slice(0, 8)}@ex.com`;
    const old = await releasedEntry(s, email);

    // The same person rejoins through the public form.
    expect((await join(s.studioId, email)).result).toBe("created");

    // Requeueing the old entry must be REFUSED, as a closed code.
    expect(await requeue(s.studioId, old, s.userId)).toBe("already_active");

    const active = await adminQuery(
      `select count(*)::int as n from public.new_client_waitlist_entries
        where studio_id = $1 and email_normalized = $2
          and status in ('waiting','claimed','invited')`,
      [s.studioId, email],
    );
    expect(active.rows[0].n).toBe(1);
    const oldRow = await adminQuery(
      `select status from public.new_client_waitlist_entries where id = $1`,
      [old],
    );
    expect(oldRow.rows[0].status).toBe("released");
  });

  it("FORBIDDEN under CONCURRENCY: requeue racing a rejoin still yields one active row", async () => {
    const s = await seedStudio("wait03-rq-race");
    const email = `rqrace-${s.studioId.slice(0, 8)}@ex.com`;
    const old = await releasedEntry(s, email);

    const [rq, jn] = await Promise.all([
      requeue(s.studioId, old, s.userId).catch((e) => `RAISED:${(e as Error).message}`),
      join(s.studioId, email).catch((e) => ({ result: `RAISED:${(e as Error).message}` })),
    ]);
    // Whichever order they land in, neither may raise.
    expect(String(rq)).not.toMatch(/^RAISED:/);
    expect(String((jn as { result: string }).result)).not.toMatch(/^RAISED:/);
    expect(["requeued", "already_active"]).toContain(rq);

    const active = await adminQuery(
      `select count(*)::int as n from public.new_client_waitlist_entries
        where studio_id = $1 and email_normalized = $2
          and status in ('waiting','claimed','invited')`,
      [s.studioId, email],
    );
    expect(active.rows[0].n).toBe(1);
  });

  it("VALID REUSE: requeue from released AND from expired still succeeds when nothing rivals it", async () => {
    const s = await seedStudio("wait03-rq-reuse");
    const email = `rqreuse-${s.studioId.slice(0, 8)}@ex.com`;
    const entry = await releasedEntry(s, email);

    expect(await requeue(s.studioId, entry, s.userId)).toBe("requeued");
    expect(await statusOf(entry)).toBe("waiting");
    expect(await claim(s.studioId, entry, s.userId)).toBe("claimed");

    const inv = await issue(s.studioId, entry, s.userId);
    expect(inv.result).toBe("invited");
    await elapseTtl(entry);
    await adminQuery(`select public.expire_new_client_waitlist_invitation($1,$2,$3)`, [
      s.studioId, entry, s.userId,
    ]);
    expect(await statusOf(entry)).toBe("expired");
    expect(await requeue(s.studioId, entry, s.userId)).toBe("requeued");
    // The superseded token stays dead across the whole reuse cycle.
    expect((await redeem(inv.raw_token)).result).toBe("invalid_token");
  });

  it("TENANT-SCOPED: the same email may be active in two studios at once", async () => {
    const a = await seedStudio("wait03-rq-ta");
    const b = await seedStudio("wait03-rq-tb");
    const email = `rqten-${a.studioId.slice(0, 8)}@ex.com`;
    expect((await join(a.studioId, email)).result).toBe("created");
    expect((await join(b.studioId, email)).result).toBe("created");

    const per = await adminQuery(
      `select studio_id, count(*)::int as n from public.new_client_waitlist_entries
        where email_normalized = $1 and status in ('waiting','claimed','invited')
        group by studio_id order by studio_id`,
      [email],
    );
    expect(per.rows).toHaveLength(2);
    for (const r of per.rows as { n: number }[]) expect(r.n).toBe(1);
  });
});

describe("0188 — redeem vs expire/release: exactly one side may win", () => {
  // Expiry now requires an elapsed TTL, so this helper moves the window first:
  // these tests are about who WINS the race, not about the TTL rule itself.
  const expire = async (studioId: string, entry: string, userId: string) => {
    await elapseTtl(entry);
    const r = await adminQuery(
      `select public.expire_new_client_waitlist_invitation($1,$2,$3) as r`,
      [studioId, entry, userId],
    );
    return r.rows[0].r as string;
  };
  const release = async (studioId: string, entry: string, userId: string) =>
    (await adminQuery(`select public.release_new_client_waitlist_entry($1,$2,$3) as r`, [
      studioId, entry, userId,
    ])).rows[0].r as string;
  const convert = async (studioId: string, entry: string, clientId: string) =>
    (await adminQuery(`select public.record_new_client_waitlist_conversion($1,$2,$3) as r`, [
      studioId, entry, clientId,
    ])).rows[0].r as string;

  async function invited(label: string) {
    const s = await seedStudio(label);
    const j = await join(s.studioId, `${label}-${s.studioId.slice(0, 8)}@ex.com`);
    const entry = j.entry_id as string;
    await claim(s.studioId, entry, s.userId);
    const inv = await issue(s.studioId, entry, s.userId);
    return { s, entry, token: inv.raw_token as string };
  }

  it("A: redeem wins -> expire refused, entry stays invited, conversion completes", async () => {
    const { s, entry, token } = await invited("wait03-t-a");
    expect((await redeem(token)).result).toBe("redeemed");
    expect(await expire(s.studioId, entry, s.userId)).toBe("already_redeemed");
    expect(await statusOf(entry)).toBe("invited");
    expect(await convert(s.studioId, entry, s.clientId)).toBe("converted");
  });

  it("A2: redeem wins -> release refused, entry stays invited, conversion completes", async () => {
    const { s, entry, token } = await invited("wait03-t-a2");
    expect((await redeem(token)).result).toBe("redeemed");
    expect(await release(s.studioId, entry, s.userId)).toBe("already_redeemed");
    expect(await statusOf(entry)).toBe("invited");
    expect(await convert(s.studioId, entry, s.clientId)).toBe("converted");
  });

  it("B: expire wins -> redeem refused", async () => {
    const { s, entry, token } = await invited("wait03-t-b");
    expect(await expire(s.studioId, entry, s.userId)).toBe("expired");
    expect((await redeem(token)).result).toBe("invalid_token");
    const inv = await adminQuery(
      `select (redeemed_at is not null) as red, (expired_at is not null) as exp
         from public.new_client_waitlist_invitations where entry_id = $1`,
      [entry],
    );
    expect(inv.rows[0].red).toBe(false);
    expect(inv.rows[0].exp).toBe(true);
  });

  it("C: release wins -> redeem refused", async () => {
    const { s, entry, token } = await invited("wait03-t-c");
    expect(await release(s.studioId, entry, s.userId)).toBe("released");
    expect((await redeem(token)).result).toBe("invalid_token");
  });

  it("D: concurrent redeem/expire -> exactly one winner, never stranded", async () => {
    for (let i = 0; i < 6; i++) {
      const { s, entry, token } = await invited(`wait03-t-d${i}`);
      const [r, x] = await Promise.all([
        redeem(token).then((v) => v.result),
        expire(s.studioId, entry, s.userId),
      ]);
      const st = await statusOf(entry);
      if (r === "redeemed") {
        // Redemption won: the entry may not have moved, and conversion must work.
        expect(x, `trial ${i}`).toBe("already_redeemed");
        expect(st, `trial ${i}`).toBe("invited");
        expect(await convert(s.studioId, entry, s.clientId)).toBe("converted");
      } else {
        expect(r, `trial ${i}`).toBe("invalid_token");
        expect(x, `trial ${i}`).toBe("expired");
        expect(st, `trial ${i}`).toBe("expired");
      }
    }
  });

  it("E: concurrent redeem/release -> exactly one winner, never stranded", async () => {
    for (let i = 0; i < 6; i++) {
      const { s, entry, token } = await invited(`wait03-t-e${i}`);
      const [r, x] = await Promise.all([
        redeem(token).then((v) => v.result),
        release(s.studioId, entry, s.userId),
      ]);
      const st = await statusOf(entry);
      if (r === "redeemed") {
        expect(x, `trial ${i}`).toBe("already_redeemed");
        expect(st, `trial ${i}`).toBe("invited");
        expect(await convert(s.studioId, entry, s.clientId)).toBe("converted");
      } else {
        expect(r, `trial ${i}`).toBe("invalid_token");
        expect(x, `trial ${i}`).toBe("released");
        expect(st, `trial ${i}`).toBe("released");
      }
    }
  });

  it("F: an ordinary UNREDEEMED expiry is untouched — the guard discriminates", async () => {
    // The mandatory negative control. Without it, a guard that simply blocked
    // every expiry would pass A-E and be catastrophically wrong.
    const { s, entry } = await invited("wait03-t-f");
    expect(await expire(s.studioId, entry, s.userId)).toBe("expired");
    expect(await statusOf(entry)).toBe("expired");
    const inv = await adminQuery(
      `select (expired_at is not null) as exp from public.new_client_waitlist_invitations where entry_id = $1`,
      [entry],
    );
    expect(inv.rows[0].exp).toBe(true);
  });

  it("G: release from CLAIMED (never invited) still works, and removal follows", async () => {
    const s = await seedStudio("wait03-t-g");
    const j = await join(s.studioId, `tg-${s.studioId.slice(0, 8)}@ex.com`);
    const entry = j.entry_id as string;
    await claim(s.studioId, entry, s.userId);
    expect(await release(s.studioId, entry, s.userId)).toBe("released");
    const rm = await adminQuery(
      `select public.remove_new_client_waitlist_entry($1,$2,$3) as r`,
      [s.studioId, entry, s.userId],
    );
    expect(rm.rows[0].r).toBe("removed");
  });
});

// ---------------------------------------------------------------------------
// 0188 — ISSUE vs RELEASE/EXPIRE: the entry row is the mutex
// ---------------------------------------------------------------------------
// THE DEFECT THESE PIN. issue() locks the ENTRY before inserting the invitation;
// release/expire used to touch INVITATIONS first and reach the entry second. So
// release could scan invitations, find none (issue uncommitted), wait for the
// entry, and then move the entry out of `invited` — leaving the invitation issue
// had meanwhile committed completely un-invalidated. Measured before the repair:
// entry `released` with the raw token still answering `redeemed`.
//
// NO SLEEP IS LOAD-BEARING HERE. The interleaving is established by waiting
// until the second connection is genuinely parked on a LOCK in
// pg_stat_activity; a timer would only make the race probable, not certain.
async function waitForLockWaiter(fnName: string): Promise<boolean> {
  for (let i = 0; i < 400; i += 1) {
    const r = await adminQuery(
      `select count(*)::int as n
         from pg_stat_activity
        where state = 'active'
          and wait_event_type = 'Lock'
          and query like '%' || $1 || '%'`,
      [fnName],
    );
    if (r.rows[0].n > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

describe("0188 — issue serializes against release and expire on the entry row", () => {
  for (const variant of [
    { name: "release", fn: "release_new_client_waitlist_entry", terminal: "released" },
    { name: "expire", fn: "expire_new_client_waitlist_invitation", terminal: "expired" },
  ] as const) {
    it(`issue || ${variant.name}: never a terminal entry beside a redeemable token`, async () => {
      const s = await seedStudio(`wait03-race-${variant.name}`);
      const j = await join(s.studioId, `race-${variant.name}-${s.studioId.slice(0, 8)}@ex.com`);
      const entry = j.entry_id as string;
      await claim(s.studioId, entry, s.userId);

      let token!: string;
      let other!: Promise<string>;
      let contended = false;

      await adminTx(async (q) => {
        const iss = await q(
          `select raw_token from public.issue_new_client_waitlist_invitation($1,$2,$3,72)`,
          [s.studioId, entry, s.userId],
        );
        token = iss.rows[0].raw_token as string;

        // A DIFFERENT pooled connection, while this transaction still holds the
        // entry row. It must not be able to finish ahead of the commit.
        other = adminQuery(`select public.${variant.fn}($1,$2,$3) as r`, [
          s.studioId,
          entry,
          s.userId,
        ]).then((r) => r.rows[0].r as string);
        other.catch(() => undefined);

        contended = await waitForLockWaiter(variant.fn);
      });

      const result = await other;
      expect(contended, `${variant.name} must contend for the entry row, not slip past it`).toBe(true);

      const status = (
        await adminQuery(`select status from public.new_client_waitlist_entries where id = $1`, [entry])
      ).rows[0].status as string;

      const live = (
        await adminQuery(
          `select count(*)::int as n
             from public.new_client_waitlist_invitations
            where entry_id = $1
              and redeemed_at is null and expired_at is null and released_at is null
              and expires_at > now()`,
          [entry],
        )
      ).rows[0].n as number;
      const redeem = (
        await adminQuery(`select result from public.redeem_new_client_waitlist_invitation($1)`, [token])
      ).rows[0].result as string;

      // THE LAW, stated as the invariant rather than one expected outcome:
      // a TERMINAL entry never coexists with a usable token. Either side may
      // win, and for expire the honest outcome changed once expiry began
      // requiring an elapsed TTL — it now declines a window that has not closed
      // (`not_expired`) instead of killing a token with three days left.
      if (status === variant.terminal) {
        expect(result).toBe(variant.terminal);
        expect(live, "a terminal entry must leave NO live invitation").toBe(0);
        expect(redeem, "a terminal entry's token must be dead").toBe("invalid_token");
      } else {
        // The entry did NOT move, so the invitation must still be intact and the
        // token must still work. A refusal that silently burned the token would
        // be just as wrong as the leak this test was written for.
        expect(status).toBe("invited");
        expect(redeem, "a refused command must not consume the token").toBe("redeemed");
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 0188 — CONVERSION REQUIRES REDEMPTION
// ---------------------------------------------------------------------------
// `invited` says an operator SENT an invitation, not that the person accepted
// it. Recording a conversion straight out of `invited` skipped redemption
// entirely and left the raw token live, so it could still be redeemed after the
// entry had already reached a terminal state.
describe("0188 — conversion is recorded only after redemption", () => {
  async function invited(label: string) {
    const s = await seedStudio(label);
    const j = await join(s.studioId, `${label}-${s.studioId.slice(0, 8)}@ex.com`);
    const entry = j.entry_id as string;
    await claim(s.studioId, entry, s.userId);
    const iss = await issue(s.studioId, entry, s.userId);
    return { s, entry, token: iss.raw_token as string };
  }
  const convert = async (studioId: string, entry: string, clientId: string) =>
    (
      await adminQuery(`select public.record_new_client_waitlist_conversion($1,$2,$3) as r`, [
        studioId,
        entry,
        clientId,
      ])
    ).rows[0].r as string;

  it("an UNREDEEMED invitation refuses conversion, and consumes nothing", async () => {
    const { s, entry, token } = await invited("wait03-conv-unredeemed");
    expect(await convert(s.studioId, entry, s.clientId)).toBe("not_redeemed");

    // NOT silently consumed: the invitation is untouched and the refusal repeats.
    const live = await adminQuery(
      `select count(*)::int as n from public.new_client_waitlist_invitations
        where entry_id = $1 and redeemed_at is null and expired_at is null and released_at is null`,
      [entry],
    );
    expect(live.rows[0].n).toBe(1);
    expect(await convert(s.studioId, entry, s.clientId)).toBe("not_redeemed");

    // And the honest ordering still works afterwards: redeem, then record.
    const red = await adminQuery(
      `select result from public.redeem_new_client_waitlist_invitation($1)`,
      [token],
    );
    expect(red.rows[0].result).toBe("redeemed");
    expect(await convert(s.studioId, entry, s.clientId)).toBe("converted");
  });

  it("a REDEEMED invitation converts", async () => {
    const { s, entry, token } = await invited("wait03-conv-redeemed");
    await adminQuery(`select result from public.redeem_new_client_waitlist_invitation($1)`, [token]);
    expect(await convert(s.studioId, entry, s.clientId)).toBe("converted");
  });

  it("a RELEASED invitation cannot be converted", async () => {
    const { s, entry } = await invited("wait03-conv-released");
    const rel = await adminQuery(
      `select public.release_new_client_waitlist_entry($1,$2,$3) as r`,
      [s.studioId, entry, s.userId],
    );
    expect(rel.rows[0].r).toBe("released");
    expect(await convert(s.studioId, entry, s.clientId)).toBe("not_invited");
  });

  it("an EXPIRED invitation cannot be converted", async () => {
    const { s, entry } = await invited("wait03-conv-expired");
    await elapseTtl(entry);
    const exp = await adminQuery(
      `select public.expire_new_client_waitlist_invitation($1,$2,$3) as r`,
      [s.studioId, entry, s.userId],
    );
    expect(exp.rows[0].r).toBe("expired");
    expect(await convert(s.studioId, entry, s.clientId)).toBe("not_invited");
  });

  it("a FOREIGN-STUDIO client is refused before redemption is even considered", async () => {
    const { s, entry, token } = await invited("wait03-conv-foreign");
    await adminQuery(`select result from public.redeem_new_client_waitlist_invitation($1)`, [token]);
    const other = await seedStudio("wait03-conv-foreign-b");
    expect(await convert(s.studioId, entry, other.clientId)).toBe("client_not_found");
  });

  it("a REPLAYED conversion is refused, and the first one stands", async () => {
    const { s, entry, token } = await invited("wait03-conv-replay");
    await adminQuery(`select result from public.redeem_new_client_waitlist_invitation($1)`, [token]);
    expect(await convert(s.studioId, entry, s.clientId)).toBe("converted");
    expect(await convert(s.studioId, entry, s.clientId)).toBe("not_invited");
    const row = await adminQuery(
      `select converted_client_id from public.new_client_waitlist_entries where id = $1`,
      [entry],
    );
    expect(row.rows[0].converted_client_id).toBe(s.clientId);
  });

  it("after conversion the token cannot become usable through any command", async () => {
    const { s, entry, token } = await invited("wait03-conv-after");
    await adminQuery(`select result from public.redeem_new_client_waitlist_invitation($1)`, [token]);
    expect(await convert(s.studioId, entry, s.clientId)).toBe("converted");
    for (const [fn, args] of [
      ["release_new_client_waitlist_entry", [s.studioId, entry, s.userId]],
      ["expire_new_client_waitlist_invitation", [s.studioId, entry, s.userId]],
      ["requeue_new_client_waitlist_entry", [s.studioId, entry, s.userId]],
      ["remove_new_client_waitlist_entry", [s.studioId, entry, s.userId]],
    ] as const) {
      await adminQuery(`select public.${fn}($1,$2,$3) as r`, [...args]).catch(() => undefined);
    }
    const redeem = await adminQuery(
      `select result from public.redeem_new_client_waitlist_invitation($1)`,
      [token],
    );
    expect(redeem.rows[0].result).toBe("invalid_token");
  });
});

// ---------------------------------------------------------------------------
// 0188 — APPEND-ONLY, WITHOUT BREAKING STUDIO TEARDOWN
// ---------------------------------------------------------------------------
// An unconditional DELETE refusal collided with these tables' own
// `on delete cascade` to studios: a studio holding nothing more than ONE public
// waitlist join became undeletable, because the join's own trigger writes a
// lifecycle event. The guard now distinguishes the studio cascade from a direct
// child delete by the parent row's visibility, which is a property of the
// transaction and not anything a caller can set.
describe("0188 — deletes: direct is refused, the studio cascade is not", () => {
  async function studioWithWaitlistRows(label: string) {
    const s = await seedStudio(label);
    const j = await join(s.studioId, `${label}-${s.studioId.slice(0, 8)}@ex.com`);
    const entry = j.entry_id as string;
    await claim(s.studioId, entry, s.userId);
    await issue(s.studioId, entry, s.userId);
    return { s, entry };
  }

  it("a DIRECT invitation delete is refused", async () => {
    const { s, entry } = await studioWithWaitlistRows("wait03-del-inv");
    expect(
      await codeOf(() =>
        adminQuery(`delete from public.new_client_waitlist_invitations where entry_id = $1`, [entry]),
      ),
    ).toBe("23514");
    const n = await adminQuery(
      `select count(*)::int as n from public.new_client_waitlist_invitations where studio_id = $1`,
      [s.studioId],
    );
    expect(n.rows[0].n).toBe(1);
  });

  it("a DIRECT event delete is refused, and UPDATE stays refused too", async () => {
    const { s, entry } = await studioWithWaitlistRows("wait03-del-ev");
    expect(
      await codeOf(() =>
        adminQuery(`delete from public.new_client_waitlist_entry_events where entry_id = $1`, [entry]),
      ),
    ).toBe("23514");
    // The UPDATE arm is untouched by the cascade carve-out.
    expect(
      await codeOf(() =>
        adminQuery(
          `update public.new_client_waitlist_entry_events set to_status = 'forged' where entry_id = $1`,
          [entry],
        ),
      ),
    ).toBe("23514");
    const n = await adminQuery(
      `select count(*)::int as n from public.new_client_waitlist_entry_events where studio_id = $1`,
      [s.studioId],
    );
    expect(n.rows[0].n).toBeGreaterThan(0);
  });

  it("the studio hard-delete succeeds and leaves ZERO orphan waitlist rows", async () => {
    const { s } = await studioWithWaitlistRows("wait03-del-cascade");
    const before = await adminQuery(
      `select (select count(*) from public.new_client_waitlist_entries where studio_id = $1)
            + (select count(*) from public.new_client_waitlist_invitations where studio_id = $1)
            + (select count(*) from public.new_client_waitlist_entry_events where studio_id = $1) as n`,
      [s.studioId],
    );
    expect(Number(before.rows[0].n), "the fixture must actually hold WAIT-03 rows").toBeGreaterThan(2);

    expect(await codeOf(() => adminQuery(`delete from public.studios where id = $1`, [s.studioId]))).toBe(
      "NO_ERROR",
    );

    const after = await adminQuery(
      `select (select count(*) from public.new_client_waitlist_entries where studio_id = $1)
            + (select count(*) from public.new_client_waitlist_invitations where studio_id = $1)
            + (select count(*) from public.new_client_waitlist_entry_events where studio_id = $1) as n`,
      [s.studioId],
    );
    expect(Number(after.rows[0].n)).toBe(0);
  });

  it("a studio holding ONLY a public join — no operator action at all — still deletes", async () => {
    // The regression's sharpest case: the lifecycle event is written by trigger
    // on the public join, so this state needs nobody to do anything wrong.
    const s = await seedStudio("wait03-del-joinonly");
    await join(s.studioId, `joinonly-${s.studioId.slice(0, 8)}@ex.com`);
    const ev = await adminQuery(
      `select count(*)::int as n from public.new_client_waitlist_entry_events where studio_id = $1`,
      [s.studioId],
    );
    expect(ev.rows[0].n).toBeGreaterThan(0);
    expect(await codeOf(() => adminQuery(`delete from public.studios where id = $1`, [s.studioId]))).toBe(
      "NO_ERROR",
    );
  });
});

// ---------------------------------------------------------------------------
// 0188 — EXPIRY MEANS THE TTL ELAPSED
// ---------------------------------------------------------------------------
// The defect: expire stamped expired_at and moved the entry to `expired` while
// expires_at was still in the future, so "expire" was a second word for release
// and it destroyed tokens the prospect could legitimately still use. Measured
// before the repair: a 72-hour invitation issued seconds earlier came back
// `expired`, with the entry moved and the token dead.
describe("0188 — expiry requires an elapsed TTL, decided by server time", () => {
  async function invitedEntry(label: string) {
    const s = await seedStudio(label);
    const j = await join(s.studioId, `${label}-${s.studioId.slice(0, 8)}@ex.com`);
    const entry = j.entry_id as string;
    await claim(s.studioId, entry, s.userId);
    const inv = await issue(s.studioId, entry, s.userId);
    return { s, entry, token: inv.raw_token as string };
  }
  const callExpire = async (studioId: string, entry: string, userId: string) =>
    (
      await adminQuery(`select public.expire_new_client_waitlist_invitation($1,$2,$3) as r`, [
        studioId,
        entry,
        userId,
      ])
    ).rows[0].r as string;

  it("a FUTURE expires_at is refused, and nothing at all is mutated", async () => {
    const { s, entry, token } = await invitedEntry("wait03-ttl-future");
    const before = await adminQuery(
      `select expires_at, expired_at, released_at from public.new_client_waitlist_invitations where entry_id = $1`,
      [entry],
    );
    expect(new Date(before.rows[0].expires_at).getTime()).toBeGreaterThan(Date.now());

    expect(await callExpire(s.studioId, entry, s.userId)).toBe("not_expired");

    const after = await adminQuery(
      `select expired_at, released_at from public.new_client_waitlist_invitations where entry_id = $1`,
      [entry],
    );
    expect(after.rows[0].expired_at, "expired_at must not be stamped").toBeNull();
    expect(after.rows[0].released_at).toBeNull();
    expect(await statusOf(entry), "the entry must not move").toBe("invited");

    // And the token the operator nearly destroyed still works.
    const redeem = await adminQuery(
      `select result from public.redeem_new_client_waitlist_invitation($1)`,
      [token],
    );
    expect(redeem.rows[0].result).toBe("redeemed");
  });

  it("an ELAPSED expires_at expires, and the entry moves with it", async () => {
    const { s, entry, token } = await invitedEntry("wait03-ttl-elapsed");
    await elapseTtl(entry);
    expect(await callExpire(s.studioId, entry, s.userId)).toBe("expired");
    expect(await statusOf(entry)).toBe("expired");
    const inv = await adminQuery(
      `select expired_at from public.new_client_waitlist_invitations where entry_id = $1`,
      [entry],
    );
    expect(inv.rows[0].expired_at).not.toBeNull();
    const redeem = await adminQuery(
      `select result from public.redeem_new_client_waitlist_invitation($1)`,
      [token],
    );
    expect(redeem.rows[0].result).toBe("invalid_token");
  });

  it("expiring twice is idempotent and keeps the same closed word", async () => {
    const { s, entry } = await invitedEntry("wait03-ttl-idem");
    await elapseTtl(entry);
    expect(await callExpire(s.studioId, entry, s.userId)).toBe("expired");
    const stamp = await adminQuery(
      `select expired_at from public.new_client_waitlist_invitations where entry_id = $1`,
      [entry],
    );
    expect(await callExpire(s.studioId, entry, s.userId)).toBe("expired");
    const again = await adminQuery(
      `select expired_at from public.new_client_waitlist_invitations where entry_id = $1`,
      [entry],
    );
    expect(again.rows[0].expired_at, "the original stamp is not rewritten").toEqual(
      stamp.rows[0].expired_at,
    );
  });

  it("a REDEEMED invitation is refused even once its TTL has elapsed", async () => {
    const { s, entry, token } = await invitedEntry("wait03-ttl-redeemed");
    await adminQuery(`select result from public.redeem_new_client_waitlist_invitation($1)`, [token]);
    await elapseTtl(entry);
    expect(await callExpire(s.studioId, entry, s.userId)).toBe("already_redeemed");
    expect(await statusOf(entry)).toBe("invited");
  });

  it("a RELEASED invitation is not expirable", async () => {
    const { s, entry } = await invitedEntry("wait03-ttl-released");
    const rel = await adminQuery(
      `select public.release_new_client_waitlist_entry($1,$2,$3) as r`,
      [s.studioId, entry, s.userId],
    );
    expect(rel.rows[0].r).toBe("released");
    expect(await callExpire(s.studioId, entry, s.userId)).toBe("not_invited");
  });

  it("the caller holds NO expiry authority — only server time decides", async () => {
    // The command takes (studio, entry, actor) and nothing else: there is no
    // clock, no cutoff and no force argument in its signature, so no caller can
    // ask for an early expiry. The TTL itself is spent at ISSUE time and the
    // append-only trigger then freezes expires_at.
    const args = await adminQuery(
      `select pg_get_function_arguments(p.oid) as a
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'expire_new_client_waitlist_invitation'`,
    );
    expect(args.rows[0].a).toBe("p_studio_id uuid, p_entry_id uuid, p_actor_user_id uuid");

    // An application role cannot move the window either: the append-only
    // trigger refuses, which is what makes "server time" enforceable.
    const { entry } = await invitedEntry("wait03-ttl-authority");
    expect(
      await codeOf(() =>
        adminQuery(
          `update public.new_client_waitlist_invitations
              set expires_at = now() - interval '1 day' where entry_id = $1`,
          [entry],
        ),
      ),
    ).toBe("23514");
  });
});

// ---------------------------------------------------------------------------
// 0188 — CLOSURE PROOFS for the two review threads that outlived their commits
// ---------------------------------------------------------------------------
// Both were repaired at 486c3dd9 ("require redemption before conversion" and
// "permit studio cascades through append-only rows") but stayed anchored to
// 07f12ad, so GitHub kept showing them live. These lock the closure down in the
// dimensions the earlier round only demonstrated in a transcript: cross-studio
// satisfaction, concurrent conversion, and selective erasure of lineage.
describe("0188 — conversion and cascade closure, in the dimensions not yet pinned", () => {
  async function invitedEntry(label: string) {
    const s = await seedStudio(label);
    const j = await join(s.studioId, `${label}-${s.studioId.slice(0, 8)}@ex.com`);
    const entry = j.entry_id as string;
    await claim(s.studioId, entry, s.userId);
    const inv = await issue(s.studioId, entry, s.userId);
    return { s, entry, token: inv.raw_token as string };
  }
  const convert = async (studioId: string, entry: string, clientId: string) =>
    (
      await adminQuery(`select public.record_new_client_waitlist_conversion($1,$2,$3) as r`, [
        studioId,
        entry,
        clientId,
      ])
    ).rows[0].r as string;

  it("a redemption in ANOTHER studio cannot satisfy this studio's conversion", async () => {
    const mine = await invitedEntry("wait03-close-mine");
    const theirs = await invitedEntry("wait03-close-theirs");
    await adminQuery(`select result from public.redeem_new_client_waitlist_invitation($1)`, [
      theirs.token,
    ]);

    // Their redeemed entry, addressed under MY studio: not found, not borrowed.
    expect(await convert(mine.s.studioId, theirs.entry, mine.s.clientId)).toBe("not_invited");
    // My unredeemed entry stays refused despite a redemption existing elsewhere.
    expect(await convert(mine.s.studioId, mine.entry, mine.s.clientId)).toBe("not_redeemed");
    // And a foreign client is refused before redemption is even considered.
    expect(await convert(mine.s.studioId, mine.entry, theirs.s.clientId)).toBe("client_not_found");

    // Structurally, an invitation can never sit under a different studio than
    // its entry — the composite FK forbids it, so the predicate cannot be
    // satisfied across a tenant boundary by any row that could exist.
    const skew = await adminQuery(
      `select count(*)::int as n
         from public.new_client_waitlist_invitations i
         join public.new_client_waitlist_entries e on e.id = i.entry_id
        where i.studio_id <> e.studio_id`,
    );
    expect(skew.rows[0].n).toBe(0);
  });

  it("concurrent conversions of one redeemed entry leave ONE coherent terminal state", async () => {
    const { s, entry, token } = await invitedEntry("wait03-close-concurrent");
    await adminQuery(`select result from public.redeem_new_client_waitlist_invitation($1)`, [token]);

    const both = await Promise.all([
      convert(s.studioId, entry, s.clientId),
      convert(s.studioId, entry, s.clientId),
    ]);
    // Exactly one records the conversion; the other is refused, never duplicated.
    expect(both.filter((r) => r === "converted")).toHaveLength(1);
    expect(both.filter((r) => r === "not_invited")).toHaveLength(1);

    const row = await adminQuery(
      `select status, converted_client_id, converted_at
         from public.new_client_waitlist_entries where id = $1`,
      [entry],
    );
    expect(row.rows[0].status).toBe("converted");
    expect(row.rows[0].converted_client_id).toBe(s.clientId);
    expect(row.rows[0].converted_at).not.toBeNull();
    // ...and no stale token survives the terminal state.
    const redeem = await adminQuery(
      `select result from public.redeem_new_client_waitlist_invitation($1)`,
      [token],
    );
    expect(redeem.rows[0].result).toBe("invalid_token");
  });

  it("lineage cannot be selectively erased while the studio survives", async () => {
    // The cascade carve-out is scoped to the STUDIO's own deletion. Anything
    // short of that — wiping the event log, or deleting the ENTRY so its
    // children cascade — is still refused, so history cannot be laundered by
    // removing a parent one level down.
    const { s, entry } = await invitedEntry("wait03-close-lineage");

    expect(
      await codeOf(() =>
        adminQuery(`delete from public.new_client_waitlist_entry_events where studio_id = $1`, [
          s.studioId,
        ]),
      ),
    ).toBe("23514");
    expect(
      await codeOf(() =>
        adminQuery(`delete from public.new_client_waitlist_invitations where studio_id = $1`, [
          s.studioId,
        ]),
      ),
    ).toBe("23514");
    // Deleting the ENTRY would cascade into both children: also refused.
    expect(
      await codeOf(() =>
        adminQuery(`delete from public.new_client_waitlist_entries where id = $1`, [entry]),
      ),
    ).toBe("23514");

    const alive = await adminQuery(`select count(*)::int as n from public.studios where id = $1`, [
      s.studioId,
    ]);
    expect(alive.rows[0].n, "the studio must still exist for this to mean anything").toBe(1);
    const lineage = await adminQuery(
      `select (select count(*) from public.new_client_waitlist_invitations where studio_id = $1)
            + (select count(*) from public.new_client_waitlist_entry_events where studio_id = $1) as n`,
      [s.studioId],
    );
    expect(Number(lineage.rows[0].n)).toBeGreaterThan(0);
  });

  it("one studio's cascade does not disturb another studio's waitlist rows", async () => {
    const doomed = await invitedEntry("wait03-close-doomed");
    const bystander = await invitedEntry("wait03-close-bystander");
    const countFor = async (studioId: string) =>
      Number(
        (
          await adminQuery(
            `select (select count(*) from public.new_client_waitlist_entries where studio_id = $1)
                  + (select count(*) from public.new_client_waitlist_invitations where studio_id = $1)
                  + (select count(*) from public.new_client_waitlist_entry_events where studio_id = $1) as n`,
            [studioId],
          )
        ).rows[0].n,
      );
    const before = await countFor(bystander.s.studioId);
    expect(before).toBeGreaterThan(0);

    expect(
      await codeOf(() =>
        adminQuery(`delete from public.studios where id = $1`, [doomed.s.studioId]),
      ),
    ).toBe("NO_ERROR");

    expect(await countFor(doomed.s.studioId)).toBe(0);
    expect(await countFor(bystander.s.studioId), "a neighbour must be untouched").toBe(before);
  });
});
