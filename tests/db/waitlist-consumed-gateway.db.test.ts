import { afterAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { adminQuery, closePool, resolveLocalDbUrl, seedStudio } from "./helpers/harness";

// ===========================================================================
// 0197 — THE CONSUMED-COUNT GATEWAY, PROVED AS service_role
// ===========================================================================
//
// WHY THESE EXIST AT ALL. 182 DB tests passed while the application's consumed
// read was broken in every environment, because every one of them used the ADMIN
// connection. `adminQuery` is postgres; the application is service_role; and the
// canonical function is SECURITY INVOKER over a table service_role deliberately
// cannot SELECT. Admin proves the ALGORITHM and says nothing about the PATH.
//
// So the decisive assertions here run under `set role service_role`, which is the
// privilege context the server actually has. Admin is used only to seed, and once
// to show why the old coverage missed this.

afterAll(async () => {
  await closePool();
});

/** A session pinned to a role, so the privilege path is the one under test. */
async function asRole<T>(role: string, fn: (q: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: resolveLocalDbUrl() });
  await client.connect();
  try {
    await client.query(`set role ${role}`);
    return await fn(async (sql, params = []) => (await client.query(sql, params)).rows);
  } finally {
    await client.query("reset role").catch(() => undefined);
    await client.end();
  }
}

async function openRound(studio: { studioId: string; userId: string }, allowance: number) {
  const r = await adminQuery(
    `select * from public.open_new_client_waitlist_admission_round($1,$2,$3)`,
    [studio.studioId, studio.userId, allowance],
  );
  expect(r.rows[0].result).toBe("opened");
  return r.rows[0].round_id as string;
}

describe("the privilege path the application actually uses", () => {
  it("service_role still has NO direct SELECT on the invitation table", async () => {
    // THE CONSTRAINT THIS WHOLE DESIGN EXISTS TO PRESERVE. If this ever passes,
    // the gateway was pointless and something granted the table away.
    const denied = await asRole("service_role", async (q) => {
      try {
        await q(`select 1 from public.new_client_waitlist_invitations limit 1`);
        return null;
      } catch (e) {
        return (e as { code?: string }).code ?? "unknown";
      }
    });
    expect(denied, "service_role must not be able to read the table").toBe("42501");
  });

  it("service_role also has no direct SELECT on the rounds table", async () => {
    const denied = await asRole("service_role", async (q) => {
      try {
        await q(`select 1 from public.studio_waitlist_admission_rounds limit 1`);
        return null;
      } catch (e) {
        return (e as { code?: string }).code ?? "unknown";
      }
    });
    expect(denied).toBe("42501");
  });

  it("THE DEFECT: calling 0192's canonical function directly as service_role is DENIED", async () => {
    // Documented rather than repaired. 0192 is applied and frozen, its posture is
    // deliberate, and its one SQL caller invokes it from inside a SECURITY
    // DEFINER function where it works. What must never happen again is the
    // APPLICATION calling it on this path.
    const studio = await seedStudio("gw-canonical");
    const round = await openRound(studio, 3);
    const code = await asRole("service_role", async (q) => {
      try {
        await q(`select public.waitlist_admission_round_consumed($1) as n`, [round]);
        return null;
      } catch (e) {
        return (e as { code?: string }).code ?? "unknown";
      }
    });
    expect(code, "this is the 42501 that made capacity read as unknown").toBe("42501");
  });

  it("and the SAME call as postgres succeeds — which is why the old suites were green", async () => {
    const studio = await seedStudio("gw-admin-contrast");
    const round = await openRound(studio, 3);
    const admin = await adminQuery(
      `select public.waitlist_admission_round_consumed($1) as n`,
      [round],
    );
    expect(Number(admin.rows[0].n)).toBe(0);
  });
});

describe("the 0197 gateway, called as service_role", () => {
  it("returns the count for a valid studio/round pair", async () => {
    const studio = await seedStudio("gw-valid");
    const round = await openRound(studio, 5);
    const n = await asRole("service_role", async (q) => {
      const rows = await q(
        `select public.read_waitlist_admission_round_consumed($1,$2) as n`,
        [studio.studioId, round],
      );
      return rows[0].n;
    });
    expect(Number(n)).toBe(0);
  });

  it("leaks nothing for ANOTHER studio's round", async () => {
    const owner = await seedStudio("gw-owner");
    const other = await seedStudio("gw-other");
    const round = await openRound(owner, 5);
    const n = await asRole("service_role", async (q) => {
      const rows = await q(
        `select public.read_waitlist_admission_round_consumed($1,$2) as n`,
        [other.studioId, round],
      );
      return rows[0].n;
    });
    expect(n, "a mismatched pair must answer NULL, never a number").toBeNull();
  });

  it("leaks nothing for a round that does not exist", async () => {
    const studio = await seedStudio("gw-unknown");
    await openRound(studio, 5);
    const n = await asRole("service_role", async (q) => {
      const rows = await q(
        `select public.read_waitlist_admission_round_consumed($1,$2) as n`,
        [studio.studioId, "00000000-0000-0000-0000-0000000000ff"],
      );
      return rows[0].n;
    });
    expect(n).toBeNull();
  });

  it("answers NULL for a null id on either side", async () => {
    const studio = await seedStudio("gw-nulls");
    const round = await openRound(studio, 5);
    const [a, b] = await asRole("service_role", async (q) => [
      (await q(`select public.read_waitlist_admission_round_consumed(null,$1) as n`, [round]))[0].n,
      (await q(`select public.read_waitlist_admission_round_consumed($1,null) as n`, [studio.studioId]))[0].n,
    ]);
    expect(a).toBeNull();
    expect(b).toBeNull();
  });

  it("NULL means no answer — it is never confused with a real zero", async () => {
    // Both appear as "no number" to a careless reader, and they mean opposite
    // things: zero is an untouched capacity, null is a question that could not
    // be answered. The application withholds on null and offers on zero.
    const studio = await seedStudio("gw-zero-vs-null");
    const round = await openRound(studio, 5);
    const [zero, nul] = await asRole("service_role", async (q) => [
      (await q(`select public.read_waitlist_admission_round_consumed($1,$2) as n`, [studio.studioId, round]))[0].n,
      (await q(`select public.read_waitlist_admission_round_consumed($1,$2) as n`, [studio.studioId, "00000000-0000-0000-0000-0000000000ff"]))[0].n,
    ]);
    expect(Number(zero)).toBe(0);
    expect(nul).toBeNull();
  });
});

describe("the browser cannot reach the gateway", () => {
  it.each(["anon", "authenticated"])("%s holds no EXECUTE", async (role) => {
    const has = await adminQuery(
      `select has_function_privilege($1,'public.read_waitlist_admission_round_consumed(uuid, uuid)','execute') as ok`,
      [role],
    );
    expect(has.rows[0].ok).toBe(false);
  });

  it("PUBLIC holds no EXECUTE, and the ACL is explicit", async () => {
    const acl = await adminQuery(
      `select coalesce(array_to_string(p.proacl,','),'(default)') as acl, p.prosecdef, p.proconfig
         from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='read_waitlist_admission_round_consumed'`,
    );
    const row = acl.rows[0];
    // A `(default)` ACL would mean PUBLIC still holds EXECUTE by inheritance.
    expect(row.acl).not.toBe("(default)");
    expect(String(row.acl)).not.toMatch(/(^|,)=X/);
    expect(String(row.acl)).not.toContain("anon=");
    expect(String(row.acl)).not.toContain("authenticated=");
    expect(String(row.acl)).toContain("service_role=X");
    // And the posture the design rests on.
    expect(row.prosecdef, "the gateway must be SECURITY DEFINER").toBe(true);
    expect(String(row.proconfig)).toContain("search_path=pg_catalog, pg_temp");
  });

  it("an authenticated session cannot call it even holding a real round id", async () => {
    const studio = await seedStudio("gw-authed");
    const round = await openRound(studio, 5);
    const code = await asRole("authenticated", async (q) => {
      try {
        await q(`select public.read_waitlist_admission_round_consumed($1,$2)`, [studio.studioId, round]);
        return null;
      } catch (e) {
        return (e as { code?: string }).code ?? "unknown";
      }
    });
    expect(code).toBe("42501");
  });
});

describe("the gateway's count IS the canonical count", () => {
  /** Drive an invitation to a terminal or live state and compare both readings. */
  async function bothReadings(studioId: string, round: string) {
    const viaGateway = await asRole("service_role", async (q) => {
      const rows = await q(
        `select public.read_waitlist_admission_round_consumed($1,$2) as n`,
        [studioId, round],
      );
      return Number(rows[0].n);
    });
    const viaCanonical = Number(
      (await adminQuery(`select public.waitlist_admission_round_consumed($1) as n`, [round]))
        .rows[0].n,
    );
    return { viaGateway, viaCanonical };
  }

  it("agrees at zero, with a live seat, and after a release", async () => {
    const studio = await seedStudio("gw-parity");
    const round = await openRound(studio, 5);
    const service = await adminQuery(
      `insert into public.services (studio_id, name, default_duration_minutes, active, modality)
       values ($1,'Consultation',30,true,'consultation') returning id`,
      [studio.studioId],
    );
    const entry = await adminQuery(
      `select * from public.create_practitioner_waitlist_entry($1,$2,'P',$3,null,null)`,
      [studio.studioId, studio.userId, `gw-${Date.now()}@harness.local`],
    );

    // ZERO USED.
    let r = await bothReadings(studio.studioId, round);
    expect(r.viaGateway).toBe(0);
    expect(r.viaGateway, "delegation means these can never disagree").toBe(r.viaCanonical);

    // A LIVE SEAT.
    const admitted = await adminQuery(
      `select * from public.admit_new_client_waitlist_entry($1,$2,$3,$4,'2026-10-01','2026-10-31',null,72)`,
      [studio.studioId, studio.userId, entry.rows[0].entry_id, service.rows[0].id],
    );
    expect(admitted.rows[0].result).toBe("admitted");
    r = await bothReadings(studio.studioId, round);
    expect(r.viaGateway).toBe(1);
    expect(r.viaGateway).toBe(r.viaCanonical);

    // RELEASED — the seat returns, and both readings move together.
    const released = await adminQuery(
      `select public.release_new_client_waitlist_entry($1,$2,$3) as result`,
      [studio.studioId, entry.rows[0].entry_id, studio.userId],
    );
    expect(released.rows[0].result).toBe("released");
    r = await bothReadings(studio.studioId, round);
    expect(r.viaGateway).toBe(r.viaCanonical);
  });
});
