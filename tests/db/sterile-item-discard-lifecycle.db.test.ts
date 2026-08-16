import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  adminQuery,
  asUser,
  closePool,
  seedSession,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";

// Migration 0182 — structured sterile-item discard lifecycle, proven against the
// REAL migrated local database.
//
// THE LAW UNDER TEST:  CURRENT INVENTORY != HISTORICAL RECORD EXISTENCE.
//
// Discarding stock must remove it from CURRENT inventory behaviour while
// leaving every HISTORICAL fact intact — the record itself, the treatment that
// used it, lot traceability, and the audit trail. The two halves are tested as
// matched pairs throughout: a "stops warning" assertion is worthless without
// the "still exists" assertion beside it, because a global filter (or a DELETE)
// would satisfy the first and destroy the second.

const F3 = "sterex-gold-two-piece-f3-short";

let a: SeededStudio;
let b: SeededStudio;

async function seedItem(
  studio: SeededStudio,
  opts: {
    lot: string;
    probeKey?: string | null;
    expiry?: string | null;
    discarded?: string | null;
  },
): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into public.record_keeping_sterile_items
       (id, studio_id, date_purchased, item_description, lot_number, probe_key,
        expiry_date, date_discarded)
     values ($1,$2,'2026-01-01','Sterex probe box',$3,$4,$5,$6)`,
    [
      id,
      studio.studioId,
      opts.lot,
      opts.probeKey ?? F3,
      opts.expiry ?? null,
      opts.discarded ?? null,
    ],
  );
  return id;
}

beforeAll(async () => {
  a = await seedStudio("rk-discard-a");
  b = await seedStudio("rk-discard-b");
});

afterAll(async () => {
  await closePool();
});

// ---------------------------------------------------------------------------
// Schema shape + existing-row behaviour (contract #11, #12)
// ---------------------------------------------------------------------------

describe("0182 schema — additive, nullable, no default", () => {
  it("the column exists as a nullable date with no default", async () => {
    const r = await adminQuery(
      `select data_type, is_nullable, column_default
         from information_schema.columns
        where table_schema = 'public'
          and table_name   = 'record_keeping_sterile_items'
          and column_name  = 'date_discarded'`,
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].data_type).toBe("date");
    expect(r.rows[0].is_nullable).toBe("YES");
    expect(r.rows[0].column_default).toBeNull();
  });

  it("matches the record_keeping_disinfectants precedent exactly", async () => {
    // Two logbooks, one concept. If these ever diverge, one of them is wrong.
    const r = await adminQuery(
      `select table_name, data_type, is_nullable, column_default
         from information_schema.columns
        where table_schema = 'public'
          and column_name  = 'date_discarded'
          and table_name in ('record_keeping_sterile_items',
                             'record_keeping_disinfectants')
        order by table_name`,
    );
    expect(r.rowCount).toBe(2);
    const [disinfectant, sterile] = r.rows;
    expect(sterile.data_type).toBe(disinfectant.data_type);
    expect(sterile.is_nullable).toBe(disinfectant.is_nullable);
    expect(sterile.column_default).toBe(disinfectant.column_default);
  });

  it("an item inserted WITHOUT the column reads back NULL — existing rows are untouched", async () => {
    // Contract #11. Every pre-0182 production row lands here: no backfill, no
    // reinterpretation, and NULL means exactly "no discard was recorded".
    const id = randomUUID();
    await adminQuery(
      `insert into public.record_keeping_sterile_items
         (id, studio_id, date_purchased, item_description)
       values ($1,$2,'2026-01-01','legacy box')`,
      [id, a.studioId],
    );
    const r = await adminQuery(
      "select date_discarded from public.record_keeping_sterile_items where id=$1",
      [id],
    );
    expect(r.rows[0].date_discarded).toBeNull();
  });

  it("no CHECK constraint blocks a back-dated or future-dated correction", async () => {
    // A logbook must accept a correction. Deliberate: the sibling column has no
    // constraint either, and a health-inspection record should never refuse a
    // typo fix with a database error.
    const before = await seedItem(a, { lot: "LOT-BACKDATE", discarded: "2020-01-01" });
    const after = await seedItem(a, { lot: "LOT-FUTURE", discarded: "2099-01-01" });
    const r = await adminQuery(
      "select id from public.record_keeping_sterile_items where id = any($1)",
      [[before, after]],
    );
    expect(r.rowCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Historical integrity (contracts #5, #6, #7)
// ---------------------------------------------------------------------------

describe("historical truth survives a discard", () => {
  it("#5 a session that used the item stays valid, linked and resolvable AFTER discard", async () => {
    const item = await seedItem(a, { lot: "LOT-HIST-1" });
    const { sessionId } = await seedSession(a);
    const blockId = await asUser(a.userId, async (q) => {
      const r = await q(
        `select public.create_session_block_with_areas($1,$2,$3::jsonb,$4::jsonb) as id`,
        [
          a.studioId,
          sessionId,
          JSON.stringify({
            probe_key: F3,
            probe_inventory_item_id: item,
            probe_lot_number: "LOT-HIST-1",
            probe_lot_confirmed: true,
          }),
          "[]",
        ],
      );
      return r.rows[0].id as string;
    });

    // Discard the stock AFTER the treatment was recorded — the real sequence.
    await adminQuery(
      "update public.record_keeping_sterile_items set date_discarded='2026-07-10' where id=$1",
      [item],
    );

    const block = await asUser(a.userId, (q) =>
      q(
        `select b.probe_inventory_item_id, b.probe_lot_number, i.date_discarded
           from public.session_blocks b
           join public.record_keeping_sterile_items i
             on i.id = b.probe_inventory_item_id
          where b.id = $1`,
        [blockId],
      ),
    );
    // The FK still resolves: the join returns a row. A delete-based "discard"
    // would have nulled the pointer (ON DELETE SET NULL) and this would be 0.
    expect(block.rowCount).toBe(1);
    expect(block.rows[0].probe_inventory_item_id).toBe(item);
    expect(block.rows[0].probe_lot_number).toBe("LOT-HIST-1");
    expect(block.rows[0].date_discarded).not.toBeNull();
  });

  it("#6 lot traceability still finds a discarded item", async () => {
    // Mirrors getLotTraceability's sterile-item leg: ilike on lot_number,
    // studio-scoped, NO lifecycle predicate.
    const item = await seedItem(a, { lot: "LOT-TRACE-9", discarded: "2026-07-10" });
    const r = await asUser(a.userId, (q) =>
      q(
        `select id, date_discarded
           from public.record_keeping_sterile_items
          where studio_id = $1 and lot_number ilike $2`,
        [a.studioId, "LOT-TRACE-9"],
      ),
    );
    expect(r.rows.map((x) => x.id)).toContain(item);
  });

  it("#7 the historical record-keeping list still includes a discarded item", async () => {
    // Mirrors getSterileItemRecords: select * , studio-scoped, NO lifecycle
    // predicate. This is the read the architecture law names explicitly.
    const kept = await seedItem(a, { lot: "LOT-LIST-KEPT", discarded: "2026-07-10" });
    const live = await seedItem(a, { lot: "LOT-LIST-LIVE" });
    const r = await asUser(a.userId, (q) =>
      q(
        `select id from public.record_keeping_sterile_items
          where studio_id = $1
          order by date_purchased desc`,
        [a.studioId],
      ),
    );
    const ids = r.rows.map((x) => x.id);
    expect(ids).toContain(kept);
    expect(ids).toContain(live);
  });

  it("#8 the export's exact column list still resolves for a discarded row", async () => {
    // Scope note: this proves the RLS-scoped read the export performs returns
    // the discarded row with every column it emits — i.e. nothing at the
    // DATABASE layer drops it. That the APPLICATION names date_discarded in
    // both its select and its CSV header is a source-level fact, pinned in
    // tests/app/settings/data/export-owner-gate.test.ts; neither test alone is
    // sufficient and they are deliberately not merged.
    const item = await seedItem(a, { lot: "LOT-EXPORT", discarded: "2026-07-10" });
    const r = await asUser(a.userId, (q) =>
      q(
        `select id, date_purchased, item_description, manufacturer_name,
                amount_purchased, lot_number, expiry_date, date_discarded,
                notes, created_by_practitioner_id, created_at, updated_at
           from public.record_keeping_sterile_items
          where id = $1`,
        [item],
      ),
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].date_discarded).not.toBeNull();
  });

  it("discard is NOT deletion — the table still ships no DELETE policy", async () => {
    // 0085's deliberate omission. If a discard were ever implemented as a
    // delete, this is the guard that would have to be weakened first.
    const r = await adminQuery(
      `select cmd from pg_policies
        where schemaname='public' and tablename='record_keeping_sterile_items'
        order by cmd`,
    );
    const cmds = r.rows.map((x) => String(x.cmd).toUpperCase());
    expect(cmds).not.toContain("DELETE");
    expect(cmds).not.toContain("ALL");
    expect(cmds).toContain("SELECT");
    expect(cmds).toContain("UPDATE");
  });
});

// ---------------------------------------------------------------------------
// Tenancy (contract #9)
// ---------------------------------------------------------------------------

describe("#9 tenancy — no studio may inspect or mark another studio's inventory", () => {
  it("studio B cannot READ studio A's discard state", async () => {
    const item = await seedItem(a, { lot: "LOT-TENANT-R", discarded: "2026-07-10" });
    const r = await asUser(b.userId, (q) =>
      q(
        "select id, date_discarded from public.record_keeping_sterile_items where id=$1",
        [item],
      ),
    );
    expect(r.rowCount).toBe(0);
  });

  it("studio B cannot DISCARD studio A's item", async () => {
    const item = await seedItem(a, { lot: "LOT-TENANT-W" });
    const upd = await asUser(b.userId, (q) =>
      q(
        "update public.record_keeping_sterile_items set date_discarded='2026-07-10' where id=$1",
        [item],
      ),
    );
    // RLS makes the row invisible to B, so the UPDATE matches nothing.
    expect(upd.rowCount).toBe(0);
    const check = await adminQuery(
      "select date_discarded from public.record_keeping_sterile_items where id=$1",
      [item],
    );
    expect(check.rows[0].date_discarded).toBeNull();
  });

  it("studio B cannot UNDISCARD studio A's item either", async () => {
    // The reverse direction matters just as much: a competitor silently
    // returning binned stock to another studio's current inventory would be a
    // clinical-safety problem, not merely a data one.
    const item = await seedItem(a, { lot: "LOT-TENANT-U", discarded: "2026-07-10" });
    const upd = await asUser(b.userId, (q) =>
      q(
        "update public.record_keeping_sterile_items set date_discarded=null where id=$1",
        [item],
      ),
    );
    expect(upd.rowCount).toBe(0);
    const check = await adminQuery(
      "select date_discarded from public.record_keeping_sterile_items where id=$1",
      [item],
    );
    expect(check.rows[0].date_discarded).not.toBeNull();
  });

  it("POSITIVE CONTROL: studio A's OWN member can discard and undiscard it", async () => {
    // Without this the three negatives above would pass just as well if the
    // UPDATE policy were broken for everyone.
    const item = await seedItem(a, { lot: "LOT-TENANT-OK" });
    const set = await asUser(a.userId, (q) =>
      q(
        "update public.record_keeping_sterile_items set date_discarded='2026-07-10' where id=$1",
        [item],
      ),
    );
    expect(set.rowCount).toBe(1);
    const clear = await asUser(a.userId, (q) =>
      q(
        "update public.record_keeping_sterile_items set date_discarded=null where id=$1",
        [item],
      ),
    );
    expect(clear.rowCount).toBe(1);
    const check = await adminQuery(
      "select date_discarded from public.record_keeping_sterile_items where id=$1",
      [item],
    );
    expect(check.rows[0].date_discarded).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Audit (contract #10) — the reason an accidental discard is safely reversible
// ---------------------------------------------------------------------------

describe("#10 the lifecycle transition is auditable within the EXISTING audit model", () => {
  it("discarding writes an audit event naming date_discarded with old/new values", async () => {
    const item = await seedItem(a, { lot: "LOT-AUDIT-1" });
    await asUser(a.userId, (q) =>
      q(
        "update public.record_keeping_sterile_items set date_discarded='2026-07-10' where id=$1",
        [item],
      ),
    );
    const r = await adminQuery(
      `select action, changed_fields, changes, actor_user_id
         from public.record_keeping_audit_events
        where record_type='sterile_item' and record_id=$1 and action='updated'
        order by created_at desc
        limit 1`,
      [item],
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].changed_fields).toContain("date_discarded");
    expect(r.rows[0].changes.date_discarded.old).toBeNull();
    expect(r.rows[0].changes.date_discarded.new).toBe("2026-07-10");
    // Attributable to the human who did it.
    expect(r.rows[0].actor_user_id).toBe(a.userId);
  });

  it("UNDISCARDING is audited too — the correction cannot be made silently", async () => {
    // This is what makes reversibility safe. An accidental discard is undone
    // through the ordinary edit form, and BOTH transitions remain on the
    // append-only trail, so "discarded on the 10th, undone on the 11th" is
    // fully reconstructable rather than vanishing.
    const item = await seedItem(a, { lot: "LOT-AUDIT-2", discarded: "2026-07-10" });
    await asUser(a.userId, (q) =>
      q(
        "update public.record_keeping_sterile_items set date_discarded=null where id=$1",
        [item],
      ),
    );
    const r = await adminQuery(
      `select changed_fields, changes
         from public.record_keeping_audit_events
        where record_type='sterile_item' and record_id=$1 and action='updated'
        order by created_at desc
        limit 1`,
      [item],
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].changed_fields).toContain("date_discarded");
    expect(r.rows[0].changes.date_discarded.old).toBe("2026-07-10");
    expect(r.rows[0].changes.date_discarded.new).toBeNull();
  });

  it("an update that does NOT touch the lifecycle writes no date_discarded diff", async () => {
    // Negative control on the audit: the trigger reports what actually changed,
    // so a discard cannot be inferred from an unrelated edit.
    const item = await seedItem(a, { lot: "LOT-AUDIT-3" });
    await asUser(a.userId, (q) =>
      q(
        "update public.record_keeping_sterile_items set item_description='renamed box' where id=$1",
        [item],
      ),
    );
    const r = await adminQuery(
      `select changed_fields from public.record_keeping_audit_events
        where record_type='sterile_item' and record_id=$1 and action='updated'
        order by created_at desc limit 1`,
      [item],
    );
    expect(r.rows[0].changed_fields).toContain("item_description");
    expect(r.rows[0].changed_fields).not.toContain("date_discarded");
  });
});
