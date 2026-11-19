import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { adminQuery, adminTx, asRole, closePool, seedStudio } from "@/tests/db/helpers/harness";

// ===========================================================================
// PER-NUMBER SMS CONSENT EVIDENCE AND THE PHONE-WIDE STOP LIST (migration 0362)
// ===========================================================================
//
// Proven against a real database: evidence is written by the triggers for every
// writer of a consent, erasing a client removes its consent evidence while the
// number-level opt-out SURVIVES, a studio's removal cascades its evidence, the
// helper answers per number, both tables are append-only, and no application
// role has any privilege on them.
//
// Numbers use a fictional +1 999 range so no other suite collides. Every
// assertion is scoped by the ids seeded here, never by global counts.

let counter = 0;
const nextNumber = () => `+1999${String(Date.now() % 1000).padStart(3, "0")}${String(++counter).padStart(4, "0")}`;
const uniqueEmail = () => `n-${randomUUID().slice(0, 8)}@example.com`;

afterAll(async () => {
  // Opt-outs are append-only on purpose (no delete trigger bypass): the fictional numbers are left in place.
  await closePool();
});

async function entry(studioId: string, phone: string | null, consent: boolean, optedOut = false) {
  const r = await adminQuery(
    `insert into public.new_client_waitlist_entries
       (studio_id, name, email, phone, sms_consent_at, sms_consent_source, sms_consent_text_version, sms_opted_out_at, sms_opt_out_source)
     values ($1, 'Entry', $2, $3,
             case when $4 then now() end, case when $4 then 'public_form' end, case when $4 then 'waitlist_sms_operational_v2' end,
             case when $5 then now() end, case when $5 then 'twilio_stop' end)
     returning id`,
    [studioId, uniqueEmail(), phone, consent, optedOut],
  );
  return r.rows[0].id as string;
}

const consentRows = async (where: string, id: string) =>
  (await adminQuery(`select phone_e164, source, text_version from public.sms_number_consents where ${where} = $1`, [id])).rows;
const optOutRows = async (phone: string) =>
  (await adminQuery(`select phone_e164, source from public.sms_number_opt_outs where phone_e164 = $1`, [phone])).rows;

describe("evidence is written by the triggers", () => {
  it("a waitlist entry stamped with consent and a number gets one evidence row for that number", async () => {
    const s = await seedStudio("sms-ev-entry");
    const n = nextNumber();
    const id = await entry(s.studioId, n, true);
    const rows = await consentRows("waitlist_entry_id", id);
    expect(rows).toEqual([{ phone_e164: n, source: "public_form", text_version: "waitlist_sms_operational_v2" }]);
  });

  it("a client stamped with consent gets an evidence row; the number is stored normalized", async () => {
    const s = await seedStudio("sms-ev-client");
    const n = nextNumber();
    await adminQuery(`update public.clients set phone = $2, sms_consent_at = now(), sms_consent_source = 'public_booking' where id = $1`, [
      s.clientId,
      n,
    ]);
    expect(await consentRows("client_id", s.clientId)).toEqual([{ phone_e164: n, source: "public_booking", text_version: null }]);
  });

  it("existing client consent gets NO evidence from the migration (nothing says which number it was for)", async () => {
    const s = await seedStudio("sms-ev-none");
    // A consent already on the row before any phone exists: no number, so no evidence.
    await adminQuery(`update public.clients set sms_consent_at = now(), sms_consent_source = 'public_booking' where id = $1`, [s.clientId]);
    expect(await consentRows("client_id", s.clientId)).toEqual([]);
  });

  it("a number is NOT bound to a different number later: editing the phone adds no consent for the new one", async () => {
    const s = await seedStudio("sms-ev-edit");
    const a = nextNumber();
    const b = nextNumber();
    await adminQuery(`update public.clients set phone = $2, sms_consent_at = now(), sms_consent_source = 'public_booking' where id = $1`, [
      s.clientId,
      a,
    ]);
    await adminQuery(`update public.clients set phone = $2 where id = $1`, [s.clientId, b]);
    const rows = await consentRows("client_id", s.clientId);
    expect(rows.map((r) => r.phone_e164)).toEqual([a]);
  });
});

describe("the STOP list is keyed by number, across studios", () => {
  it("a client or entry opt-out writes the number once with its source", async () => {
    const s = await seedStudio("sms-oo-row");
    const n = nextNumber();
    await entry(s.studioId, n, false, true);
    expect(await optOutRows(n)).toEqual([{ phone_e164: n, source: "twilio_stop" }]);
  });

  it("record_sms_number_opt_out remembers a number no row holds, is idempotent, and normalizes", async () => {
    const n = nextNumber();
    const first = await adminQuery(`select public.record_sms_number_opt_out($1, 'twilio_stop') as ok`, [n]);
    const again = await adminQuery(`select public.record_sms_number_opt_out($1, 'twilio_stop') as ok`, [n]);
    expect(first.rows[0].ok).toBe(true);
    expect(again.rows[0].ok).toBe(true);
    expect(await optOutRows(n)).toHaveLength(1);
    // a number that cannot be addressed, and a malformed source, record nothing and say false
    const bad = await adminQuery(`select public.record_sms_number_opt_out('n/a', 'twilio_stop') as ok`);
    const badSource = await adminQuery(`select public.record_sms_number_opt_out($1, 'Bad Source') as ok`, [nextNumber()]);
    expect(bad.rows[0].ok).toBe(false);
    expect(badSource.rows[0].ok).toBe(false);
  });
});

describe("erasure and removal", () => {
  it("erasing a client removes its consent evidence, but a number-level opt-out SURVIVES", async () => {
    const s = await seedStudio("sms-erase");
    const n = nextNumber();
    await adminQuery(`update public.clients set phone = $2, sms_consent_at = now(), sms_consent_source = 'public_booking' where id = $1`, [
      s.clientId,
      n,
    ]);
    await adminQuery(`select public.record_sms_number_opt_out($1, 'twilio_stop')`, [n]);
    expect(await consentRows("client_id", s.clientId)).toHaveLength(1);
    await adminQuery(`delete from public.clients where id = $1`, [s.clientId]);
    expect(await consentRows("client_id", s.clientId)).toEqual([]);
    expect(await optOutRows(n)).toHaveLength(1);
  });

  it("a waitlist entry is never hard-deleted (its lifecycle events are append-only): removing it keeps the consent evidence and the opt-out", async () => {
    const s = await seedStudio("sms-erase-entry");
    const n = nextNumber();
    const id = await entry(s.studioId, n, true);
    await adminQuery(`select public.record_sms_number_opt_out($1, 'twilio_stop')`, [n]);
    // The existing guard: a direct delete is refused, so the evidence cannot be orphaned by one.
    await expect(adminQuery(`delete from public.new_client_waitlist_entries where id = $1`, [id])).rejects.toThrow(/append-only evidence/);
    await adminQuery(
      `update public.new_client_waitlist_entries set status = 'removed', removed_at = now(), removed_by_practitioner_id = $2 where id = $1`,
      [id, s.practitionerId],
    );
    // DOCUMENTED BEHAVIOUR for Sam: removal does not erase the number evidence; only a client's or a studio's deletion does.
    expect(await consentRows("waitlist_entry_id", id)).toHaveLength(1);
    expect(await optOutRows(n)).toHaveLength(1);
  });

  it("removing a studio cascades its consent evidence (and its number-level opt-outs stay)", async () => {
    const s = await seedStudio("sms-studio-gone");
    const n = nextNumber();
    const id = await entry(s.studioId, n, true);
    await adminQuery(`select public.record_sms_number_opt_out($1, 'twilio_stop')`, [n]);
    await adminQuery(`delete from public.studios where id = $1`, [s.studioId]);
    expect(await consentRows("waitlist_entry_id", id)).toEqual([]);
    expect(
      (await adminQuery(`select 1 from public.sms_number_consents where studio_id = $1`, [s.studioId])).rows,
    ).toEqual([]);
    expect(await optOutRows(n)).toHaveLength(1);
  });
});

describe("waitlist_sms_number_consented", () => {
  it("is true for the number consented to, false for any other number, and for an unknown entry", async () => {
    const s = await seedStudio("sms-helper");
    const n = nextNumber();
    const other = nextNumber();
    const id = await entry(s.studioId, n, true);
    const ask = async (e: string, num: string) =>
      (await adminQuery(`select public.waitlist_sms_number_consented($1::uuid, $2) as ok`, [e, num])).rows[0].ok;
    expect(await ask(id, n)).toBe(true);
    expect(await ask(id, other)).toBe(false);
    expect(await ask(randomUUID(), n)).toBe(false);
    expect(await ask(id, "n/a")).toBe(false);
  });

  it("turns false once the number has a STOP anywhere (another studio's, or the bare list)", async () => {
    const s = await seedStudio("sms-helper-stop");
    const n = nextNumber();
    const id = await entry(s.studioId, n, true);
    await adminQuery(`select public.record_sms_number_opt_out($1, 'twilio_stop')`, [n]);
    const r = await adminQuery(`select public.waitlist_sms_number_consented($1::uuid, $2) as ok`, [id, n]);
    expect(r.rows[0].ok).toBe(false);
  });
});

describe("a waitlist consent needs a number (validated check)", () => {
  it("refuses an entry holding consent with no phone", async () => {
    const s = await seedStudio("sms-check");
    await expect(entry(s.studioId, null, true)).rejects.toThrow(/consent_needs_phone|check constraint/i);
  });
});

describe("append-only", () => {
  it("consent evidence cannot be updated", async () => {
    const s = await seedStudio("sms-append");
    const id = await entry(s.studioId, nextNumber(), true);
    await expect(
      adminQuery(`update public.sms_number_consents set source = 'edited' where waitlist_entry_id = $1`, [id]),
    ).rejects.toThrow(/append-only/);
  });

  it("an opt-out can be neither updated nor deleted", async () => {
    const n = nextNumber();
    await adminQuery(`select public.record_sms_number_opt_out($1, 'twilio_stop')`, [n]);
    await expect(adminQuery(`update public.sms_number_opt_outs set source = 'edited' where phone_e164 = $1`, [n])).rejects.toThrow(/append-only/);
    await expect(adminQuery(`delete from public.sms_number_opt_outs where phone_e164 = $1`, [n])).rejects.toThrow(/append-only/);
  });
});

describe("grants", () => {
  it("no application role can read or write either table", async () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      for (const table of ["sms_number_consents", "sms_number_opt_outs"]) {
        const r = await adminQuery(
          `select has_table_privilege($1, 'public.${table}', 'select,insert,update,delete') as any_priv,
                  has_table_privilege($1, 'public.${table}', 'select') as sel,
                  has_table_privilege($1, 'public.${table}', 'insert') as ins`,
          [role],
        );
        expect(r.rows[0].sel, `${role} select ${table}`).toBe(false);
        expect(r.rows[0].ins, `${role} insert ${table}`).toBe(false);
      }
    }
  });

  it("the two functions are executable by service_role only", async () => {
    for (const fn of ["record_sms_number_opt_out(text, text)", "waitlist_sms_number_consented(uuid, text)"]) {
      const exec = async (role: string) =>
        (await adminQuery(`select has_function_privilege($1, 'public.${fn}', 'execute') as ok`, [role])).rows[0].ok;
      expect(await exec("service_role"), `service_role ${fn}`).toBe(true);
      expect(await exec("anon"), `anon ${fn}`).toBe(false);
      expect(await exec("authenticated"), `authenticated ${fn}`).toBe(false);
    }
  });

  it("a signed-in studio member sees nothing through RLS", async () => {
    const s = await seedStudio("sms-rls");
    const id = await entry(s.studioId, nextNumber(), true);
    expect(id).toBeTruthy();
    await expect(
      asRole("authenticated", async (q) => q(`select 1 from public.sms_number_consents limit 1`)),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("TRUNCATE is refused on both tables", () => {
  it("cannot be used to bypass the row guards", async () => {
    await expect(adminQuery(`truncate public.sms_number_consents`)).rejects.toThrow(/append-only/);
    await expect(adminQuery(`truncate public.sms_number_opt_outs`)).rejects.toThrow(/append-only/);
  });
});

describe("the waitlist consent check is VALIDATED, not just added", () => {
  it("is validated in the catalog", async () => {
    const r = await adminQuery(
      `select convalidated from pg_constraint where conname = 'new_client_waitlist_entries_consent_needs_phone_ck'`,
    );
    expect(r.rows).toEqual([{ convalidated: true }]);
  });
});

// ---------------------------------------------------------------------------
// THE BACKFILL, replayed over seeded rows. A fresh chain runs it over empty tables, so it needs its own proof.
// The two statements are read out of the migration file itself (never a copy). Rows are seeded with triggers off
// (session_replication_role = replica) so only the backfill can have produced the evidence; everything is rolled back.
// ---------------------------------------------------------------------------
const migration = readFileSync("supabase/migrations/0362_sms_number_consent_evidence.sql", "utf8");
const backfillSection = migration.slice(migration.indexOf("-- 5. Backfill"), migration.indexOf("-- 6. A waitlist consent needs a number"));
const backfill = backfillSection
  .split("\n")
  .filter((l) => !l.startsWith("--"))
  .join("\n")
  .split(/;\s*\n/)
  .map((x) => x.trim())
  .filter((x) => x.length > 0);

class Rollback extends Error {}

describe("backfill", () => {
  it("is exactly two statements", () => {
    expect(backfill).toHaveLength(2);
    expect(backfill[0]).toMatch(/^insert into public\.sms_number_consents/);
    expect(backfill[1]).toMatch(/^insert into public\.sms_number_opt_outs/);
  });

  it("carries forward waitlist consents and every opt-out number with the minimum time and the right sources, and is idempotent", async () => {
    const s = await seedStudio("sms-backfill");
    const nA = nextNumber(); // consented entry, plain
    const nB = nextNumber(); // two entries consented on the same number
    const nC = nextNumber(); // opted out on two rows (earlier and later), one a client
    const nD = nextNumber(); // consent with no phone number that normalizes
    const early = "2026-01-01T00:00:00Z";
    const late = "2026-06-01T00:00:00Z";
    let result: Record<string, unknown> = {};
    await adminTx(async (q) => {
      await q(`set local session_replication_role = replica`);
      const ins = async (phone: string | null, consent: boolean, outAt: string | null) =>
        (
          await q(
            `insert into public.new_client_waitlist_entries
               (studio_id, name, email, phone, sms_consent_at, sms_consent_source, sms_consent_text_version, sms_opted_out_at, sms_opt_out_source)
             values ($1, 'Entry', $2, $3,
                     case when $4 then '2026-03-01T00:00:00Z'::timestamptz end, case when $4 then 'public_form' end,
                     case when $4 then 'waitlist_sms_operational_v2' end,
                     $5::timestamptz, case when $5::timestamptz is not null then 'twilio_stop' end)
             returning id`,
            [s.studioId, uniqueEmail(), phone, consent, outAt],
          )
        ).rows[0].id as string;
      const eA = await ins(nA, true, null);
      const eB1 = await ins(nB, true, null);
      const eB2 = await ins(nB, true, null);
      await ins(nC, false, late);
      await ins(nD, false, null);
      await ins("n/a", false, null); // unnormalizable: never evidenced
      await q(`update public.clients set phone = $2, sms_opted_out_at = $3::timestamptz, sms_opt_out_source = 'twilio_stop' where id = $1`, [
        s.clientId,
        nC,
        early,
      ]);
      const counts = async () => ({
        consents: (await q(`select count(*)::int n from public.sms_number_consents where studio_id = $1`, [s.studioId])).rows[0].n,
        optOutsMine: (await q(`select count(*)::int n from public.sms_number_opt_outs where phone_e164 = any($1)`, [[nA, nB, nC, nD]])).rows[0].n,
      });
      const before = await counts();
      for (const stmt of backfill) await q(stmt);
      const after1 = await counts();
      const consents = (
        await q(`select waitlist_entry_id, phone_e164, source, text_version, consented_at from public.sms_number_consents where studio_id = $1 order by phone_e164, waitlist_entry_id`, [s.studioId])
      ).rows;
      const optC = (await q(`select source, opted_out_at from public.sms_number_opt_outs where phone_e164 = $1`, [nC])).rows[0];
      for (const stmt of backfill) await q(stmt);
      const after2 = await counts();
      result = { before, after1, after2, consents, optC, eA, eB1, eB2 };
      throw new Rollback();
    }).catch((e) => {
      if (!(e instanceof Rollback)) throw e;
    });
    const r = result as {
      before: { consents: number; optOutsMine: number };
      after1: { consents: number; optOutsMine: number };
      after2: { consents: number; optOutsMine: number };
      consents: Array<{ waitlist_entry_id: string; phone_e164: string; source: string; text_version: string; consented_at: Date }>;
      optC: { source: string; opted_out_at: Date };
      eA: string; eB1: string; eB2: string;
    };
    expect(r.before).toEqual({ consents: 0, optOutsMine: 0 });
    // one consent row per consented entry with a normalizable number (A, B1, B2); none for no-consent or junk-phone entries
    expect(r.after1.consents).toBe(3);
    expect(r.consents.map((c) => c.waitlist_entry_id).sort()).toEqual([r.eA, r.eB1, r.eB2].sort());
    for (const c of r.consents) {
      expect(c.source).toBe("carried_forward_waitlist");
      expect(c.text_version).toBe("waitlist_sms_operational_v2");
      expect(c.consented_at.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    }
    // every opted-out number (C from a row and a client, D and no others of mine are not opted out): only C is opted out
    expect(r.after1.optOutsMine).toBe(1);
    expect(r.optC.source).toBe("carried_forward");
    expect(r.optC.opted_out_at.toISOString()).toBe("2026-01-01T00:00:00.000Z"); // the MINIMUM of the two
    // a second run adds nothing
    expect(r.after2).toEqual(r.after1);
    // nothing leaked: the transaction was rolled back
    expect((await adminQuery(`select count(*)::int n from public.sms_number_consents where studio_id = $1`, [s.studioId])).rows[0].n).toBe(0);
  });
});
