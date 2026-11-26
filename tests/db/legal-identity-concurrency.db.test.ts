// HON-58: concurrency of the legal-identity save (saveLegalIdentityAction). The action writes with a conditional UPDATE (every
// loaded name part in the WHERE) or, when there was no row at load, an INSERT whose unique violation (23505) means "changed by
// someone else". These tests run that exact statement shape as the signed-in practitioner. Synthetic values only.
// Known limit (documented, not tested as a pass): the compare is by value, so a change A -> B -> A between load and save is not seen.
import { afterAll, describe, expect, it } from "vitest";
import { adminQuery, adminTx, asUser, closePool, seedStudio, type SeededStudio } from "./helpers/harness";

afterAll(closePool);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Parts = { given: string | null; middle: string | null; family: string | null };

const seedRow = (s: SeededStudio, p: Parts) =>
  adminQuery(
    `insert into public.client_legal_identities (client_id, studio_id, legal_given_name, legal_middle_name, legal_family_name, source)
     values ($1,$2,$3,$4,$5,'staff_entry')`,
    [s.clientId, s.studioId, p.given, p.middle, p.family],
  );

/** The action's conditional UPDATE. Returns the number of rows it changed. */
const conditionalUpdate = (s: SeededStudio, next: Parts, baseline: Parts, updatedBy: string | null = null) =>
  asUser(s.userId, async (q) =>
    (
      await q(
        `update public.client_legal_identities
            set legal_given_name = $3, legal_middle_name = $4, legal_family_name = $5, updated_by = $9
          where client_id = $1 and studio_id = $2
            and legal_given_name is not distinct from $6
            and legal_middle_name is not distinct from $7
            and legal_family_name is not distinct from $8
        returning client_id`,
        [s.clientId, s.studioId, next.given, next.middle, next.family, baseline.given, baseline.middle, baseline.family, updatedBy],
      )
    ).rows.length,
  );

/** The action's INSERT. Resolves to "inserted" or the SQLSTATE of the refusal. */
const insertRow = (s: SeededStudio, p: Parts) =>
  asUser(s.userId, async (q) => {
    await q(
      `insert into public.client_legal_identities (client_id, studio_id, legal_given_name, legal_middle_name, legal_family_name, source)
       values ($1,$2,$3,$4,$5,'staff_entry')`,
      [s.clientId, s.studioId, p.given, p.middle, p.family],
    );
    return "inserted";
  }).catch((e: { code?: string }) => e.code ?? "error");

const stored = async (clientId: string) =>
  (await adminQuery(`select legal_given_name g, legal_middle_name m, legal_family_name f, revision from public.client_legal_identities where client_id = $1`, [clientId])).rows;
const auditCount = async (clientId: string) =>
  Number((await adminQuery(`select count(*)::int n from public.client_identity_audit where client_id = $1 and concept = 'legal_name'`, [clientId])).rows[0].n);

const BASE: Parts = { given: "Given", middle: null, family: "Family" };

describe("legal identity save: concurrency", () => {
  it("applies from an unchanged baseline with the real practitioner as updated_by: revision and audit move once, the audit actor is that practitioner", async () => {
    const s = await seedStudio("legal-ok");
    await seedRow(s, BASE);
    const audit0 = await auditCount(s.clientId);
    expect(await conditionalUpdate(s, { given: "Other", middle: null, family: "Family" }, BASE, s.practitionerId)).toBe(1);
    expect((await stored(s.clientId))[0]).toMatchObject({ g: "Other", revision: 2 });
    expect(await auditCount(s.clientId)).toBe(audit0 + 1);
    const by = (await adminQuery(`select updated_by from public.client_legal_identities where client_id = $1`, [s.clientId])).rows[0].updated_by;
    expect(by).toBe(s.practitionerId);
    const actor = (await adminQuery(`select changed_by from public.client_identity_audit where client_id = $1 and concept = 'legal_name' order by revision desc limit 1`, [s.clientId])).rows[0].changed_by;
    expect(actor, "the audit actor is the signed-in practitioner").toBe(s.practitionerId);
  });

  it("deterministic: a save that waits on a concurrent committed change re-checks, changes nothing and writes no audit row", async () => {
    const s = await seedStudio("legal-wait");
    await seedRow(s, BASE);
    const audit0 = await auditCount(s.clientId);
    let bPid: number | null = null;
    let aPid: number | null = null;
    let bDone = false;
    let bCount = -1;
    let bPromise: Promise<void> = Promise.resolve();
    let auditAfterA = 0;
    await adminTx(async (qa) => {
      aPid = (await qa(`select pg_backend_pid() as pid`)).rows[0].pid;
      await qa(`update public.client_legal_identities set legal_family_name = 'Changed' where client_id = $1`, [s.clientId]);
      bPromise = asUser(s.userId, async (qb) => {
        bPid = (await qb(`select pg_backend_pid() as pid`)).rows[0].pid;
        bCount = (
          await qb(
            `update public.client_legal_identities set legal_given_name = 'Mine', updated_by = null
              where client_id = $1 and studio_id = $2
                and legal_given_name is not distinct from $3 and legal_middle_name is not distinct from $4 and legal_family_name is not distinct from $5
            returning client_id`,
            [s.clientId, s.studioId, BASE.given, BASE.middle, BASE.family],
          )
        ).rows.length;
      }).finally(() => {
        bDone = true;
      });
      let waiting = false;
      for (let i = 0; i < 100 && !bDone && !waiting; i++) {
        if (bPid !== null) {
          const w = await adminQuery(`select wait_event_type from pg_stat_activity where pid = $1`, [bPid]);
          waiting = w.rows[0]?.wait_event_type === "Lock";
        }
        if (!waiting) await sleep(50);
      }
      expect(waiting, "the stale save must be WAITING on the row, not have read-and-written already").toBe(true);
      const blockers = (await adminQuery(`select pg_blocking_pids($1) as b`, [bPid])).rows[0].b as number[];
      expect(blockers, "the stale save is blocked by the open writer, not by something else").toContain(aPid);
    });
    await bPromise;
    auditAfterA = await auditCount(s.clientId);
    expect(bCount, "stale save changed rows").toBe(0);
    expect((await stored(s.clientId))[0]).toMatchObject({ g: "Given", f: "Changed", revision: 2 });
    expect(auditAfterA, "only the committed change is audited; the refused save added nothing").toBe(audit0 + 1);
  });

  it("randomised: two saves from the SAME baseline at once: exactly one applies, never both", async () => {
    for (let i = 0; i < 12; i += 1) {
      const s = await seedStudio(`legal-pair-${i}`);
      await seedRow(s, BASE);
      const audit0 = await auditCount(s.clientId);
      const [x, y] = await Promise.all([
        conditionalUpdate(s, { given: "Writer-X", middle: null, family: "Family" }, BASE),
        conditionalUpdate(s, { given: "Writer-Y", middle: null, family: "Family" }, BASE),
      ]);
      expect([x, y].sort(), `round ${i}`).toEqual([0, 1]);
      const [row] = await stored(s.clientId);
      expect(["Writer-X", "Writer-Y"]).toContain(row.g);
      expect(row.revision, `round ${i}: one real change`).toBe(2);
      expect(await auditCount(s.clientId), `round ${i}`).toBe(audit0 + 1);
    }
  });

  it("insert against insert: exactly one row is created, the other gets 23505 and writes nothing", async () => {
    const control = await seedStudio("legal-ins-control");
    await seedRow(control, BASE);
    const oneInsertAudit = await auditCount(control.clientId);
    for (let i = 0; i < 8; i += 1) {
      const s = await seedStudio(`legal-ins-${i}`);
      const [x, y] = await Promise.all([
        insertRow(s, { given: "Writer-X", middle: null, family: "Family" }),
        insertRow(s, { given: "Writer-Y", middle: null, family: "Family" }),
      ]);
      expect([x, y].sort(), `round ${i}`).toEqual(["23505", "inserted"]);
      const rows = await stored(s.clientId);
      expect(rows).toHaveLength(1);
      expect(rows[0].revision).toBe(1);
      expect(await auditCount(s.clientId), `round ${i}: audit of the winner only`).toBe(oneInsertAudit);
    }
  });

  it("deterministic insert: an insert that waits on an uncommitted insert is refused with 23505 once it commits", async () => {
    const s = await seedStudio("legal-ins-wait");
    let bPid: number | null = null;
    let aPid: number | null = null;
    let bDone = false;
    let bResult = "";
    let bPromise: Promise<void> = Promise.resolve();
    await adminTx(async (qa) => {
      aPid = (await qa(`select pg_backend_pid() as pid`)).rows[0].pid;
      await qa(
        `insert into public.client_legal_identities (client_id, studio_id, legal_given_name, legal_family_name, source) values ($1,$2,'First','Family','staff_entry')`,
        [s.clientId, s.studioId],
      );
      bPromise = asUser(s.userId, async (qb) => {
        bPid = (await qb(`select pg_backend_pid() as pid`)).rows[0].pid;
        await qb(
          `insert into public.client_legal_identities (client_id, studio_id, legal_given_name, legal_family_name, source) values ($1,$2,'Second','Family','staff_entry')`,
          [s.clientId, s.studioId],
        );
        bResult = "inserted";
      })
        .catch((e: { code?: string }) => {
          bResult = e.code ?? "error";
        })
        .finally(() => {
          bDone = true;
        });
      let waiting = false;
      for (let i = 0; i < 100 && !bDone && !waiting; i++) {
        if (bPid !== null) {
          const w = await adminQuery(`select wait_event_type from pg_stat_activity where pid = $1`, [bPid]);
          waiting = w.rows[0]?.wait_event_type === "Lock";
        }
        if (!waiting) await sleep(50);
      }
      expect(waiting, "the second insert must be WAITING on the first").toBe(true);
      const blockers = (await adminQuery(`select pg_blocking_pids($1) as b`, [bPid])).rows[0].b as number[];
      expect(blockers, "the second insert is blocked by the open first insert").toContain(aPid);
    });
    await bPromise;
    expect(bResult).toBe("23505");
    const rows = await stored(s.clientId);
    expect(rows).toHaveLength(1);
    expect(rows[0].g).toBe("First");
  });

  it("a refused (stale) save writes nothing: values, revision and audit are exactly as before", async () => {
    const s = await seedStudio("legal-refused");
    await seedRow(s, BASE);
    await adminQuery(`update public.client_legal_identities set legal_given_name = 'Moved' where client_id = $1`, [s.clientId]);
    const before = { rows: await stored(s.clientId), audit: await auditCount(s.clientId) };
    expect(await conditionalUpdate(s, { given: "Mine", middle: "M", family: "Mine" }, BASE)).toBe(0);
    expect({ rows: await stored(s.clientId), audit: await auditCount(s.clientId) }).toEqual(before);
  });

  it("an insert refused because a row already exists writes nothing and adds no audit row", async () => {
    const s = await seedStudio("legal-ins-refused");
    await seedRow(s, BASE);
    const before = { rows: await stored(s.clientId), audit: await auditCount(s.clientId) };
    expect(await insertRow(s, { given: "Mine", middle: null, family: "Mine" })).toBe("23505");
    expect({ rows: await stored(s.clientId), audit: await auditCount(s.clientId) }).toEqual(before);
  });

  it("KNOWN LIMIT: the compare is by value, so A -> B -> A before the save is not detected", async () => {
    const s = await seedStudio("legal-aba");
    await seedRow(s, BASE);
    await adminQuery(`update public.client_legal_identities set legal_given_name = 'Interim' where client_id = $1`, [s.clientId]);
    await adminQuery(`update public.client_legal_identities set legal_given_name = 'Given' where client_id = $1`, [s.clientId]);
    // Documents the gap: the save applies, although the row changed twice since the page loaded. The revision (now 3) is the signal
    // a follow-up could compare instead of the values.
    expect(await conditionalUpdate(s, { given: "Mine", middle: null, family: "Family" }, BASE)).toBe(1);
  });
});
