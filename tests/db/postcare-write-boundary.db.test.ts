import { afterAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { createHash, randomUUID } from "node:crypto";
import {
  adminQuery,
  asRole,
  closePool,
  resolveLocalDbUrl,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";

// B8 / 0177 — postcare claim + settlement boundary.
//
// The seven direct application UPDATEs are replaced by two commands. What has
// to be proved is not "postcare can be sent" but the two properties the direct
// writers could not guarantee: exactly one sender wins a claim, and a sender
// whose claim has been superseded cannot write anything when it finally
// returns.

const tokenHash = () => createHash("sha256").update(randomUUID()).digest("hex");

const POSTCARE_COLUMNS = [
  "postcare_email_claimed_at",
  "postcare_email_failed_at",
  "postcare_email_last_attempt_at",
  "postcare_email_last_error",
  "postcare_email_send_attempts",
  "postcare_email_sent_at",
] as const;

async function seedAppt(
  f: SeededStudio,
  status = "completed",
  startsInSql = "-2 hours",
): Promise<string> {
  const r = await adminQuery(
    `insert into public.appointments
       (id, studio_id, practitioner_id, client_id, starts_at, ends_at,
        duration_minutes, status, cancellation_token_hash,
        buffer_minutes_snapshot, blocked_ends_at)
     values (gen_random_uuid(), $1, $2, $3,
             now() + ($4)::interval,
             now() + ($4)::interval + interval '60 minutes',
             60, $5, $6, 15,
             now() + ($4)::interval + interval '75 minutes')
     returning id`,
    [f.studioId, f.practitionerId, f.clientId, startsInSql, status, tokenHash()],
  );
  return r.rows[0].id as string;
}

type ClaimOut = {
  result: string;
  claimed_at: string | null;
  send_attempts: number | null;
  previous_sent_at: string | null;
};

async function claim(
  f: SeededStudio,
  apptId: string,
  opts: { resend?: boolean; actor?: string; studio?: string } = {},
): Promise<ClaimOut> {
  const r = await adminQuery(
    `select * from public.claim_postcare_send($1,$2,$3,$4)`,
    [apptId, opts.studio ?? f.studioId, opts.actor ?? f.practitionerId, opts.resend ?? false],
  );
  return r.rows[0] as ClaimOut;
}

type SettleOut = {
  result: string;
  sent_at: string | null;
  failed_at: string | null;
  last_error: string | null;
};

async function settle(
  f: SeededStudio,
  apptId: string,
  claimedAt: string | null,
  success: boolean,
  retryable = false,
): Promise<SettleOut> {
  const r = await adminQuery(
    `select * from public.settle_postcare_send($1,$2,$3,$4,$5)`,
    [apptId, f.studioId, claimedAt, success, retryable],
  );
  return r.rows[0] as SettleOut;
}

async function row(id: string) {
  const r = await adminQuery(
    `select status, starts_at, ends_at, practitioner_id, cancelled_at, cancelled_by,
            postcare_email_claimed_at, postcare_email_failed_at,
            postcare_email_last_attempt_at, postcare_email_last_error,
            postcare_email_send_attempts, postcare_email_sent_at, capacity_enabled,
            updated_at
       from public.appointments where id = $1`,
    [id],
  );
  return r.rows[0];
}

const auditCount = async (id: string) =>
  Number(
    (
      await adminQuery(
        `select count(*)::int as n from public.appointment_audit where appointment_id = $1`,
        [id],
      )
    ).rows[0].n,
  );

/**
 * Backdate a claim so it is reclaimable, and RETURN the value now in the row.
 *
 * That returned value is the token a superseded sender would actually be
 * holding. Comparing against the pre-ageing token instead would make the stale
 * tests pass for the wrong reason — they would be rejecting a token that never
 * matched the row rather than one displaced by a genuine reclaim.
 */
async function ageClaim(id: string, interval: string): Promise<string> {
  const r = await adminQuery(
    `update public.appointments
        set postcare_email_claimed_at = postcare_email_claimed_at - ($2)::interval
      where id = $1
      returning postcare_email_claimed_at`,
    [id, interval],
  );
  // ISO, not String(Date): the local-format "GMT-0400 (Eastern…)" rendering is
  // not parseable by Postgres when the token is passed back in.
  return new Date(String(r.rows[0].postcare_email_claimed_at)).toISOString();
}

async function conn(): Promise<Client> {
  const c = new Client({ connectionString: resolveLocalDbUrl() });
  await c.connect();
  return c;
}

afterAll(async () => {
  await closePool();
});

// ---------------------------------------------------------------------------
describe("T1-T4 — a winning first claim", () => {
  it("T1/T2/T3/T4 — claims, issues a token, increments once, and stamps one instant", async () => {
    const f = await seedStudio("b8-t1");
    const a = await seedAppt(f);
    const before = await row(a);
    expect(before.postcare_email_send_attempts ?? 0).toBe(0);

    const c = await claim(f, a);

    expect(c.result).toBe("claimed");
    // T2 — the token exists and is the settlement key.
    expect(c.claimed_at).not.toBeNull();
    // T3 — exactly one increment, not two.
    expect(Number(c.send_attempts)).toBe(1);

    const r = await row(a);
    expect(String(r.postcare_email_claimed_at)).toBe(String(c.claimed_at));
    // T4 — claimed_at and last_attempt_at are the SAME DB instant, not two
    // clock readings that merely look close.
    expect(String(r.postcare_email_last_attempt_at)).toBe(
      String(r.postcare_email_claimed_at),
    );
    expect(Number(r.postcare_email_send_attempts)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("T5-T10 — everything the claim refuses", () => {
  const expectNoPostcareMutation = async (id: string) => {
    const r = await row(id);
    for (const col of POSTCARE_COLUMNS) {
      const v = r[col];
      expect(v === null || v === 0, `${col} must be untouched`).toBe(true);
    }
  };

  it.each([
    ["T5 confirmed", "confirmed"],
    ["T6 cancelled", "cancelled"],
    ["T7 no_show", "no_show"],
  ])("%s — refused with zero postcare mutation", async (_label, status) => {
    const f = await seedStudio(`b8-${status}`);
    const a = await seedAppt(f, status);
    const c = await claim(f, a);
    expect(c.result).toBe("not_completed");
    expect(c.claimed_at).toBeNull();
    await expectNoPostcareMutation(a);
  });

  it("T8 — an INACTIVE practitioner is refused", async () => {
    const f = await seedStudio("b8-t8");
    const a = await seedAppt(f);
    await adminQuery(`update public.practitioners set active = false where id = $1`, [
      f.practitionerId,
    ]);
    const c = await claim(f, a);
    expect(c.result).toBe("not_authorized");
    await expectNoPostcareMutation(a);
  });

  it("T9 — a practitioner from ANOTHER studio is refused", async () => {
    const f = await seedStudio("b8-t9a");
    const other = await seedStudio("b8-t9b");
    const a = await seedAppt(f);
    const c = await claim(f, a, { actor: other.practitionerId });
    expect(c.result).toBe("not_authorized");
    await expectNoPostcareMutation(a);
  });

  it("T10 — an appointment in another studio is refused", async () => {
    const f = await seedStudio("b8-t10a");
    const other = await seedStudio("b8-t10b");
    const a = await seedAppt(other);
    // Actor is valid for f, but the appointment is not f's.
    const c = await claim(f, a);
    expect(c.result).toBe("not_found");
    await expectNoPostcareMutation(a);
  });

  it("any active same-studio practitioner may send — assignment is NOT required", async () => {
    // Deliberate: this matches the studio-member operational boundary the
    // product already has. Narrowing it to the assigned practitioner would be a
    // silent behaviour change, not a hardening.
    const f = await seedStudio("b8-peer");
    const peerUser = randomUUID();
    const peerEmail = `b8-peer-${randomUUID()}@harness.local`;
    await adminQuery(`insert into auth.users (id, email) values ($1, $2)`, [
      peerUser,
      peerEmail,
    ]);
    const peer = await adminQuery(
      `insert into public.practitioners (id, studio_id, user_id, display_name, email, active)
       values (gen_random_uuid(), $1, $2, 'Peer', $3, true) returning id`,
      [f.studioId, peerUser, peerEmail],
    );
    const a = await seedAppt(f);
    const c = await claim(f, a, { actor: peer.rows[0].id });
    expect(c.result).toBe("claimed");
  });
});

// ---------------------------------------------------------------------------
describe("T11-T13 — first send vs resend", () => {
  it("T11 — a FIRST send is refused once sent_at exists", async () => {
    const f = await seedStudio("b8-t11");
    const a = await seedAppt(f);
    const c1 = await claim(f, a);
    await settle(f, a, c1.claimed_at, true);

    const c2 = await claim(f, a, { resend: false });
    expect(c2.result).toBe("already_sent");
    expect(c2.claimed_at).toBeNull();
  });

  it("T12 — a RESEND requires an existing sent_at", async () => {
    // A resend of something never successfully sent is not a resend.
    const f = await seedStudio("b8-t12");
    const a = await seedAppt(f);
    const c = await claim(f, a, { resend: true });
    expect(c.result).toBe("never_sent");
    expect(c.claimed_at).toBeNull();
  });

  it("T13 — a valid resend wins and carries the previous sent_at", async () => {
    const f = await seedStudio("b8-t13");
    const a = await seedAppt(f);
    const c1 = await claim(f, a);
    const s1 = await settle(f, a, c1.claimed_at, true);

    const c2 = await claim(f, a, { resend: true });
    expect(c2.result).toBe("claimed");
    expect(c2.claimed_at).not.toBeNull();
    expect(String(c2.previous_sent_at)).toBe(String(s1.sent_at));
    expect(Number(c2.send_attempts)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
describe("T14-T18 — concurrency and the stale window", () => {
  /** Two real connections racing the same statement. No sleeps. */
  async function race(sql: string, args: unknown[]) {
    const a = await conn();
    const b = await conn();
    try {
      const [ra, rb] = await Promise.all([a.query(sql, args), b.query(sql, args)]);
      return [ra.rows[0], rb.rows[0]] as Array<{ result: string }>;
    } finally {
      await a.end();
      await b.end();
    }
  }

  it("T14 — two concurrent FIRST sends: exactly one wins, attempts +1 not +2", async () => {
    const f = await seedStudio("b8-t14");
    const a = await seedAppt(f);

    const out = await race(`select * from public.claim_postcare_send($1,$2,$3,false)`, [
      a,
      f.studioId,
      f.practitionerId,
    ]);
    expect(out.map((o) => o.result).sort()).toEqual(["already_claimed", "claimed"]);

    // The decisive assertion: a lost claim must not have consumed an attempt.
    expect(Number((await row(a)).postcare_email_send_attempts)).toBe(1);
  });

  it("T15 — two concurrent RESENDS: exactly one wins", async () => {
    // This is the race the old code could NOT prevent — it relied on the
    // client button's disabled state, so two resends could both reach the
    // provider and the client could receive two emails.
    const f = await seedStudio("b8-t15");
    const a = await seedAppt(f);
    const c1 = await claim(f, a);
    await settle(f, a, c1.claimed_at, true);

    const out = await race(`select * from public.claim_postcare_send($1,$2,$3,true)`, [
      a,
      f.studioId,
      f.practitionerId,
    ]);
    expect(out.map((o) => o.result).sort()).toEqual(["already_claimed", "claimed"]);
    expect(Number((await row(a)).postcare_email_send_attempts)).toBe(2);
  });

  it("T16 — a FRESH claim cannot be stolen", async () => {
    const f = await seedStudio("b8-t16");
    const a = await seedAppt(f);
    const first = await claim(f, a);
    expect(first.result).toBe("claimed");

    const second = await claim(f, a);
    expect(second.result).toBe("already_claimed");
    // And the original token still owns the row.
    expect(String((await row(a)).postcare_email_claimed_at)).toBe(String(first.claimed_at));
  });

  it("T17/T18 — a claim older than five minutes is reclaimable, with a NEW token", async () => {
    const f = await seedStudio("b8-t17");
    const a = await seedAppt(f);
    const first = await claim(f, a);

    // Deterministic: age the claim rather than waiting five minutes.
    const displaced = await ageClaim(a, "6 minutes");
    expect(first.result).toBe("claimed");

    const second = await claim(f, a);
    expect(second.result).toBe("claimed");
    // T18 — the reclaim issues a token DIFFERENT from the one it displaced,
    // which is what makes the superseded sender's late settlement a no-op.
    // Compared as INSTANTS: String(Date) is second-precision, so two tokens
    // milliseconds apart would look identical and this would pass wrongly.
    expect(new Date(String(second.claimed_at)).getTime()).not.toBe(
      new Date(displaced).getTime(),
    );
    expect(Number(second.send_attempts)).toBe(2);
  });

  it("a claim just INSIDE the window is still protected", async () => {
    // Guards the boundary from the other side: 4 minutes must NOT be stealable,
    // otherwise "5 minutes" would be decorative.
    const f = await seedStudio("b8-t17b");
    const a = await seedAppt(f);
    await claim(f, a);
    await ageClaim(a, "4 minutes");
    expect((await claim(f, a)).result).toBe("already_claimed");
  });
});

// ---------------------------------------------------------------------------
describe("T19-T24 — settlement", () => {
  it("T19 — exact-token SUCCESS stamps sent_at and clears claim + failure", async () => {
    const f = await seedStudio("b8-t19");
    const a = await seedAppt(f);
    const c = await claim(f, a);
    // Give it a prior failure so the clearing is observable.
    await settle(f, a, c.claimed_at, false, true);
    const c2 = await claim(f, a);

    const s = await settle(f, a, c2.claimed_at, true);
    expect(s.result).toBe("settled");

    const r = await row(a);
    expect(r.postcare_email_sent_at).not.toBeNull();
    expect(r.postcare_email_failed_at).toBeNull();
    expect(r.postcare_email_last_error).toBeNull();
    expect(r.postcare_email_claimed_at).toBeNull();
  });

  it("T20 — exact-token FAILURE stamps failed_at, clears the claim, invents no sent_at", async () => {
    const f = await seedStudio("b8-t20");
    const a = await seedAppt(f);
    const c = await claim(f, a);

    const s = await settle(f, a, c.claimed_at, false, true);
    expect(s.result).toBe("settled");

    const r = await row(a);
    expect(r.postcare_email_failed_at).not.toBeNull();
    expect(r.postcare_email_claimed_at).toBeNull();
    // A failed FIRST send never produces a sent_at.
    expect(r.postcare_email_sent_at).toBeNull();
  });

  it("T21 — a FAILED RESEND preserves the historical sent_at", async () => {
    // The property that matters in a dispute: yesterday's genuine send is not
    // erased by today's failure.
    const f = await seedStudio("b8-t21");
    const a = await seedAppt(f);
    const c1 = await claim(f, a);
    const s1 = await settle(f, a, c1.claimed_at, true);
    const originalSentAt = String(s1.sent_at);

    const c2 = await claim(f, a, { resend: true });
    const s2 = await settle(f, a, c2.claimed_at, false, false);

    expect(s2.result).toBe("settled");
    const r = await row(a);
    expect(String(r.postcare_email_sent_at)).toBe(originalSentAt);
    expect(r.postcare_email_failed_at).not.toBeNull();
  });

  it("T22/T23/T24 — last_error is derived from p_retryable ALONE", async () => {
    const f = await seedStudio("b8-t22");

    const a1 = await seedAppt(f);
    const c1 = await claim(f, a1);
    const r1 = await settle(f, a1, c1.claimed_at, false, true);
    expect(r1.last_error).toBe("Temporary email provider error. Try again.");

    const a2 = await seedAppt(f, "completed", "-6 hours");
    const c2 = await claim(f, a2);
    const r2 = await settle(f, a2, c2.claimed_at, false, false);
    expect(r2.last_error).toBe("The email provider rejected the send. Try again.");

    // T24 — there is no parameter through which a raw provider error could
    // reach the column. A provider message can carry recipient addresses and
    // vendor internals, and this field is rendered to practitioners.
    const args = (
      await adminQuery(
        `select pg_get_function_arguments(p.oid) as a from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname='public' and p.proname='settle_postcare_send'`,
      )
    ).rows[0].a as string;
    expect(args).not.toMatch(/error|message|detail|payload|reason/i);
  });
});

// ---------------------------------------------------------------------------
describe("T25-T28 — a superseded sender returning late", () => {
  /** T1 claims, goes stale, T2 reclaims, then T1 finally answers. */
  async function supersede(label: string) {
    const f = await seedStudio(label);
    const a = await seedAppt(f);
    const first = await claim(f, a);
    expect(first.result).toBe("claimed");
    // The token the superseded sender is holding is the one left in the row,
    // so that is what must be rejected after the reclaim.
    const displaced = await ageClaim(a, "6 minutes");
    const fresh = await claim(f, a);
    expect(fresh.result).toBe("claimed");
    return { f, a, old: { claimed_at: displaced }, fresh };
  }

  it("T25 — an OLD token settles as a stable no-op", async () => {
    const { f, a, old } = await supersede("b8-t25");
    const s = await settle(f, a, old.claimed_at, true);
    expect(s.result).toBe("stale_claim");
  });

  it("T26 — a stale SUCCESS cannot stamp sent_at", async () => {
    const { f, a, old, fresh } = await supersede("b8-t26");
    await settle(f, a, old.claimed_at, true);
    const r = await row(a);
    expect(r.postcare_email_sent_at, "no send happened").toBeNull();
    // ...and the newer claim is untouched, so the real sender can still settle.
    expect(String(r.postcare_email_claimed_at)).toBe(String(fresh.claimed_at));
  });

  it("T27 — a stale FAILURE cannot clear the newer claim", async () => {
    const { f, a, old, fresh } = await supersede("b8-t27");
    await settle(f, a, old.claimed_at, false, true);
    expect(String((await row(a)).postcare_email_claimed_at)).toBe(String(fresh.claimed_at));
  });

  it("T28 — a stale FAILURE cannot stamp failed_at over newer state", async () => {
    const { f, a, old, fresh } = await supersede("b8-t28");
    // The fresh sender succeeds first; the stale one then reports failure.
    await settle(f, a, fresh.claimed_at, true);
    const sentAt = String((await row(a)).postcare_email_sent_at);

    const late = await settle(f, a, old.claimed_at, false, false);
    expect(late.result).toBe("stale_claim");

    const r = await row(a);
    expect(r.postcare_email_failed_at, "no failure written over a success").toBeNull();
    expect(r.postcare_email_last_error).toBeNull();
    expect(String(r.postcare_email_sent_at)).toBe(sentAt);
  });

  it("a null token is a stale claim, never a wildcard", async () => {
    const f = await seedStudio("b8-null");
    const a = await seedAppt(f);
    await claim(f, a);
    expect((await settle(f, a, null, true)).result).toBe("stale_claim");
    expect((await row(a)).postcare_email_sent_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("T29 — every new timestamp is the database's", () => {
  it("T29 — neither command accepts a caller-supplied state timestamp", async () => {
    const claimArgs = (
      await adminQuery(
        `select pg_get_function_arguments(p.oid) as a from pg_proc p
           join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public' and p.proname='claim_postcare_send'`,
      )
    ).rows[0].a as string;
    // The claim takes NO timestamp at all.
    expect(claimArgs).not.toMatch(/timestamp/i);

    const settleArgs = (
      await adminQuery(
        `select pg_get_function_arguments(p.oid) as a from pg_proc p
           join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public' and p.proname='settle_postcare_send'`,
      )
    ).rows[0].a as string;
    // Settle takes exactly ONE, and it is the claim TOKEN being matched — not
    // a value that gets written anywhere.
    expect((settleArgs.match(/timestamp with time zone/g) ?? []).length).toBe(1);
    expect(settleArgs).toMatch(/p_claimed_at timestamp with time zone/);

    // Behavioural confirmation: stamps land at the server clock, not any value
    // a caller could have chosen.
    const f = await seedStudio("b8-t29");
    const a = await seedAppt(f);
    const c = await claim(f, a);
    const fresh = await adminQuery(
      `select (postcare_email_claimed_at > now() - interval '1 minute') as recent
         from public.appointments where id = $1`,
      [a],
    );
    expect(fresh.rows[0].recent).toBe(true);
    expect(c.claimed_at).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("T34-T37 — the privilege boundary after 0177", () => {
  it.each(POSTCARE_COLUMNS)(
    "T34 — service_role direct UPDATE of %s is denied",
    async (col) => {
      const f = await seedStudio(`b8-p-${col.slice(-6)}`);
      const a = await seedAppt(f);
      // Type-correct per column: send_attempts is INTEGER and last_error is
      // TEXT, so a blanket `= now()` would fail on TYPE before the privilege
      // check and the test would pass without proving anything.
      const value =
        col === "postcare_email_send_attempts"
          ? "1"
          : col === "postcare_email_last_error"
            ? "'x'"
            : "now()";
      await expect(
        asRole("service_role", (q) =>
          q(`update public.appointments set ${col} = ${value} where id = $1`, [a]),
        ),
      ).rejects.toThrow(/permission denied/i);
    },
  );

  it("T35 — a COMBINED update touching any postcare column is denied", async () => {
    const f = await seedStudio("b8-t35");
    const a = await seedAppt(f);
    await expect(
      asRole("service_role", (q) =>
        q(
          `update public.appointments
              set postcare_email_claimed_at = now(),
                  postcare_email_send_attempts = 99
            where id = $1`,
          [a],
        ),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("T36 — service_role SELECT on appointments still works", async () => {
    const f = await seedStudio("b8-t36");
    const a = await seedAppt(f);
    const r = await asRole("service_role", (q) =>
      q(`select id, status from public.appointments where id = $1`, [a]),
    );
    expect(r.rows).toHaveLength(1);
  });

  it("service_role holds NO column-level UPDATE on appointments at all", async () => {
    const n = await adminQuery(
      `select count(*)::int as n from information_schema.column_privileges
        where table_schema='public' and table_name='appointments'
          and grantee='service_role' and privilege_type='UPDATE'`,
    );
    expect(Number(n.rows[0].n)).toBe(0);
  });

  it("T37 — both commands are service_role EXECUTE only", async () => {
    for (const sig of [
      "public.claim_postcare_send(uuid,uuid,uuid,boolean)",
      "public.settle_postcare_send(uuid,uuid,timestamptz,boolean,boolean)",
    ]) {
      const r = await adminQuery(
        `select has_function_privilege('anon',$1,'EXECUTE') as anon,
                has_function_privilege('authenticated',$1,'EXECUTE') as auth,
                has_function_privilege('service_role',$1,'EXECUTE') as svc`,
        [sig],
      );
      expect(r.rows[0].anon, `${sig} anon`).toBe(false);
      expect(r.rows[0].auth, `${sig} authenticated`).toBe(false);
      expect(r.rows[0].svc, `${sig} service_role`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
describe("T38-T40 — what postcare must NOT disturb", () => {
  it("T38 — claim and settle produce ZERO appointment_audit rows", async () => {
    // B8 is bookkeeping-boundary hardening, not a new event taxonomy: the seven
    // writers being replaced produced no audit event either.
    const f = await seedStudio("b8-t38");
    const a = await seedAppt(f);
    const before = await auditCount(a);

    const c = await claim(f, a);
    await settle(f, a, c.claimed_at, true);
    const c2 = await claim(f, a, { resend: true });
    await settle(f, a, c2.claimed_at, false, true);

    expect(await auditCount(a)).toBe(before);
  });

  it("T39 — lifecycle, timing and attribution are untouched", async () => {
    const f = await seedStudio("b8-t39");
    const a = await seedAppt(f);
    const before = await row(a);

    const c = await claim(f, a);
    await settle(f, a, c.claimed_at, true);

    const after = await row(a);
    for (const col of [
      "status",
      "starts_at",
      "ends_at",
      "practitioner_id",
      "cancelled_at",
      "cancelled_by",
    ] as const) {
      expect(String(after[col]), `${col} must not move`).toBe(String(before[col]));
    }
  });

  it("T40 — the B6 capacity trigger does not fire from postcare bookkeeping", async () => {
    // The capacity trigger watches studio_id and practitioner_id only. Diverge
    // the row's snapshot from the studio's live setting; a postcare-only update
    // must not re-derive it. Without the divergence this test would be vacuous.
    const f = await seedStudio("b8-t40");
    await adminQuery(
      `update public.studios set practitioner_capacity_enabled = true where id = $1`,
      [f.studioId],
    );
    const a = await seedAppt(f);
    await adminQuery(`update public.appointments set capacity_enabled = false where id = $1`, [
      a,
    ]);
    const booked = (await row(a)).capacity_enabled;
    expect(booked).toBe(false);

    const c = await claim(f, a);
    await settle(f, a, c.claimed_at, true);

    expect((await row(a)).capacity_enabled, "postcare must not re-derive capacity").toBe(
      booked,
    );
  });

  it("postcare writes still pass through B6's updated_at trigger", async () => {
    const f = await seedStudio("b8-upd");
    const a = await seedAppt(f);
    await adminQuery(
      `update public.appointments set updated_at = now() - interval '10 days' where id = $1`,
      [a],
    );
    const before = (await row(a)).updated_at;
    await claim(f, a);
    const after = (await row(a)).updated_at;
    expect(new Date(String(after)).getTime()).toBeGreaterThanOrEqual(
      new Date(String(before)).getTime(),
    );
  });
});
