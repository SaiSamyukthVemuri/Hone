// 0196 — THE RECORDED DELIVERY OUTCOME.
//
// The disposition used to live only in React state, so three separate findings
// were three different ways to unmount it. This writes it down, on the row it
// belongs to, and these cases pin the properties that make that safe:
//
//   * NULL is NOT `unknown` — one means nothing reported back, the other is an
//     observed verdict;
//   * first observation wins, a contradicting repeat is REFUSED without writing;
//   * one studio cannot read or mutate another's;
//   * recording cannot alter admission or invitation truth.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  adminQuery,
  asRole,
  asUser,
  closePool,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";

const RECORD = "select public.record_waitlist_invitation_delivery($1,$2,$3) as r";

let A: SeededStudio;
let B: SeededStudio;

const q = async <T>(text: string, params: unknown[] = []): Promise<T[]> =>
  (await adminQuery(text, params)).rows as T[];

/** A minimal invitation row, written directly: these cases are about the
 *  RECORDING command, not about how an invitation comes to exist. */
async function seedInvitation(s: SeededStudio): Promise<string> {
  const entry = randomUUID();
  // `invited` carries cycle evidence by constraint: claimed_at,
  // claimed_by_practitioner_id and invited_at must all be present.
  await q(
    `insert into public.new_client_waitlist_entries
       (id, studio_id, name, email, status,
        claimed_at, claimed_by_practitioner_id, invited_at)
     values ($1,$2,'Prospect',$3,'invited', now(), $4, now())`,
    [entry, s.studioId, `d-${entry.slice(0, 8)}@harness.local`, s.practitionerId],
  );
  const id = randomUUID();
  await q(
    `insert into public.new_client_waitlist_invitations
       (id, studio_id, entry_id, token_hash, issued_at, expires_at, issued_by_practitioner_id)
     values ($1,$2,$3,$4, now(), now() + interval '72 hours', $5)`,
    [id, s.studioId, entry, randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""), s.practitionerId],
  );
  return id;
}

const readRow = (id: string) =>
  q<{ delivery_disposition: string | null; delivery_recorded_at: string | null }>(
    `select delivery_disposition, delivery_recorded_at
       from public.new_client_waitlist_invitations where id=$1`,
    [id],
  ).then((r) => r[0]!);

beforeAll(async () => {
  A = await seedStudio("delivery-a");
  B = await seedStudio("delivery-b");
});
afterAll(async () => {
  await closePool();
});

describe("never-recorded is distinct from unknown", () => {
  it("a fresh invitation has NO disposition and NO timestamp", async () => {
    const id = await seedInvitation(A);
    const row = await readRow(id);
    expect(row.delivery_disposition).toBeNull();
    expect(row.delivery_recorded_at).toBeNull();
  });

  it("recording `unknown` is an OBSERVED verdict and is stored as one", async () => {
    const id = await seedInvitation(A);
    expect((await q<{ r: string }>(RECORD, [A.studioId, id, "unknown"]))[0]!.r).toBe("recorded");
    const row = await readRow(id);
    expect(row.delivery_disposition, "unknown must be distinguishable from absent").toBe("unknown");
    expect(row.delivery_recorded_at).not.toBeNull();
  });
});

describe("the three dispositions round-trip", () => {
  for (const disposition of ["accepted", "refused", "unknown"] as const) {
    it(`${disposition} is recorded and read back verbatim`, async () => {
      const id = await seedInvitation(A);
      expect((await q<{ r: string }>(RECORD, [A.studioId, id, disposition]))[0]!.r).toBe("recorded");
      expect((await readRow(id)).delivery_disposition).toBe(disposition);
    });
  }

  it("a fourth word is refused by the command, not stored", async () => {
    const id = await seedInvitation(A);
    expect((await q<{ r: string }>(RECORD, [A.studioId, id, "delivered"]))[0]!.r).toBe(
      "invalid_disposition",
    );
    expect((await readRow(id)).delivery_disposition).toBeNull();
  });
});

describe("repeat writes are governed deterministically", () => {
  it("the SAME disposition again is an idempotent no-op", async () => {
    const id = await seedInvitation(A);
    await q(RECORD, [A.studioId, id, "accepted"]);
    const first = await readRow(id);
    expect((await q<{ r: string }>(RECORD, [A.studioId, id, "accepted"]))[0]!.r).toBe("unchanged");
    // Including the timestamp: a no-op does not restamp.
    expect(String((await readRow(id)).delivery_recorded_at)).toBe(String(first.delivery_recorded_at));
  });

  it("a CONTRADICTING repeat is refused and writes NOTHING", async () => {
    const id = await seedInvitation(A);
    await q(RECORD, [A.studioId, id, "accepted"]);
    const before = await readRow(id);

    expect((await q<{ r: string }>(RECORD, [A.studioId, id, "refused"]))[0]!.r).toBe("conflict");

    const after = await readRow(id);
    expect(after.delivery_disposition, "the first observation was overwritten").toBe("accepted");
    expect(String(after.delivery_recorded_at)).toBe(String(before.delivery_recorded_at));
  });
});

describe("tenancy", () => {
  it("another studio cannot record against this invitation", async () => {
    const id = await seedInvitation(A);
    expect((await q<{ r: string }>(RECORD, [B.studioId, id, "accepted"]))[0]!.r).toBe("not_found");
    expect((await readRow(id)).delivery_disposition).toBeNull();
  });

  it("the OWNER studio can read the columns; another studio sees no row", async () => {
    const id = await seedInvitation(A);
    await q(RECORD, [A.studioId, id, "refused"]);

    const mine = await asUser(A.userId, (query) =>
      query(
        `select delivery_disposition from public.new_client_waitlist_invitations where id=$1`,
        [id],
      ),
    );
    expect(mine.rows).toHaveLength(1);
    expect((mine.rows[0] as { delivery_disposition: string }).delivery_disposition).toBe("refused");

    const theirs = await asUser(B.userId, (query) =>
      query(
        `select delivery_disposition from public.new_client_waitlist_invitations where id=$1`,
        [id],
      ),
    );
    expect(theirs.rows, "cross-studio read returned a row").toHaveLength(0);
  });

  it("anon cannot read the disposition at all", async () => {
    const id = await seedInvitation(A);
    await q(RECORD, [A.studioId, id, "accepted"]);
    await expect(
      asRole("anon", (query) =>
        query(
          `select delivery_disposition from public.new_client_waitlist_invitations where id=$1`,
          [id],
        ),
      ),
    ).rejects.toThrow();
  });

  it("no browser role may EXECUTE the recording command", async () => {
    const acl = await q<{ acl: string }>(
      `select coalesce(array_to_string(p.proacl,' '),'(default)') as acl
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname='record_waitlist_invitation_delivery'`,
    );
    expect(acl[0]!.acl).toContain("service_role=X");
    expect(acl[0]!.acl).not.toMatch(/(^|\s)anon=/);
    expect(acl[0]!.acl).not.toMatch(/authenticated=/);
  });
});

describe("recording cannot alter invitation or admission truth", () => {
  it("a refused or conflicting record leaves every lifecycle column untouched", async () => {
    const id = await seedInvitation(A);
    const lifecycleBefore = await q<Record<string, unknown>>(
      `select entry_id, studio_id, token_hash, issued_at, expires_at,
              redeemed_at, expired_at, released_at, declined_at
         from public.new_client_waitlist_invitations where id=$1`,
      [id],
    );
    await q(RECORD, [A.studioId, id, "accepted"]);
    await q(RECORD, [A.studioId, id, "refused"]);       // conflict
    await q(RECORD, [B.studioId, id, "unknown"]);        // not_found
    await q(RECORD, [A.studioId, id, "nonsense"]);       // invalid_disposition

    const lifecycleAfter = await q<Record<string, unknown>>(
      `select entry_id, studio_id, token_hash, issued_at, expires_at,
              redeemed_at, expired_at, released_at, declined_at
         from public.new_client_waitlist_invitations where id=$1`,
      [id],
    );
    expect(lifecycleAfter).toEqual(lifecycleBefore);

    // And the entry's own status is untouched by any of it.
    const entry = await q<{ status: string }>(
      `select e.status from public.new_client_waitlist_entries e
         join public.new_client_waitlist_invitations i on i.entry_id = e.id
        where i.id = $1`,
      [id],
    );
    expect(entry[0]!.status).toBe("invited");
  });

  it("a missing invitation is a closed refusal, never an exception", async () => {
    const r = await q<{ r: string }>(RECORD, [A.studioId, randomUUID(), "accepted"]);
    expect(r[0]!.r).toBe("not_found");
  });
});
