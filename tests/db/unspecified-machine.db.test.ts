import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MACHINE_CATALOGUE } from "../../lib/machines/catalogue";
import { planContractPublication } from "../../lib/machines/contract-publication";
import { adminQuery, adminTx, asUser, closePool, seedMember, seedSession, seedStudio, type SeededStudio } from "./helpers/harness";

// Migration 0385: the "Machine not specified" placeholder. REAL published xCell Pur MultiPlex contract (planContractPublication over the
// shipped catalogue, through the real sync command), synthetic studios only. Contract rows are immutable, so they are removed at the end with the
// table owner (the stack is owned and discarded); nothing here touches a shared database.

const PUR = "dectro-apilus:xcell-pur";
const LABEL = "Machine not specified";
const GENERIC = /Machine not available\./;
let a: SeededStudio;
let b: SeededStudio;
let published = false;

async function publishReal(): Promise<void> {
  const plan = planContractPublication(MACHINE_CATALOGUE);
  const c = plan.publish.find((p) => p.p_machine_profile_id === PUR && p.p_mode_key === "multiplex");
  if (!c) throw new Error("the shipped catalogue no longer publishes xCell Pur MultiPlex");
  await adminQuery("select public.sync_machine_profile_contract($1,$2,$3,$4,$5,$6::jsonb)", [c.p_machine_profile_id, c.p_machine_profile_version, c.p_mode_key, c.p_channels_max, c.p_requires_installed_option, JSON.stringify(c.p_fields)]);
  published = true;
}

const ensure = (userId: string, studioId: string) => asUser(userId, (q) => q(`select public.ensure_unspecified_machine($1) as id`, [studioId]));
const rowsFor = (studioId: string) => adminQuery(`select * from public.studio_machines where studio_id=$1 and is_unspecified order by machine_profile_version`, [studioId]);

beforeAll(async () => {
  a = await seedStudio("unspec-a");
  b = await seedStudio("unspec-b");
});

afterAll(async () => {
  await adminQuery(`delete from public.studio_machines where studio_id = any($1::uuid[])`, [[a.studioId, b.studioId]]).catch(() => undefined);
  if (published) {
    await adminQuery(`delete from public.machine_profile_field_contract where machine_profile_id=$1`, [PUR]).catch(() => undefined);
    await adminQuery(`delete from public.machine_profile_mode_contract where machine_profile_id=$1`, [PUR]).catch(() => undefined);
  }
  await closePool();
});

describe("0385 before the contract is published", () => {
  it("is refused with the one generic refusal, and creates nothing", async () => {
    await expect(ensure(a.userId, a.studioId)).rejects.toThrow(GENERIC);
    expect((await rowsFor(a.studioId)).rows).toHaveLength(0);
  });
});

describe("0385 ensure_unspecified_machine (real published contract)", () => {
  beforeAll(publishReal);

  it("OPTION GATE: the real xCell Pur MultiPlex contract requires NO installed option, so the placeholder's empty options can record it", async () => {
    const r = await adminQuery(`select requires_installed_option from public.machine_profile_mode_contract where machine_profile_id=$1 and mode_key='multiplex'`, [PUR]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].requires_installed_option).toBeNull();
  });

  it("a practitioner of the studio gets the row; idempotent; the shape is the reserved one at the current published version", async () => {
    const first = (await ensure(a.userId, a.studioId)).rows[0].id as string;
    const again = (await ensure(a.userId, a.studioId)).rows[0].id as string;
    expect(again).toBe(first);
    const rows = (await rowsFor(a.studioId)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first, machine_profile_id: PUR, machine_profile_version: 1, display_name: LABEL, installed_options: [], retired_at: null, is_unspecified: true });
  });

  it("returns only the id (a uuid), nothing else", async () => {
    const r = await ensure(a.userId, a.studioId);
    expect(Object.keys(r.rows[0])).toEqual(["id"]);
    expect(r.rows[0].id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("a non-member, a member of ANOTHER studio and a receptionist get the one generic refusal; no row is created for them", async () => {
    const stranger = randomUUID();
    await adminQuery(`insert into auth.users (id, email) values ($1, $2)`, [stranger, `stranger-${stranger.slice(0, 8)}@harness.local`]);
    await expect(ensure(stranger, a.studioId)).rejects.toThrow(GENERIC);
    await expect(ensure(b.userId, a.studioId)).rejects.toThrow(GENERIC);
    const recep = randomUUID();
    await adminQuery(`insert into auth.users (id, email) values ($1, $2)`, [recep, `recep-${recep.slice(0, 8)}@harness.local`]);
    await adminQuery(`insert into public.studio_receptionists (studio_id, user_id, display_name, active) values ($1,$2,'Synthetic Front Desk',true)`, [a.studioId, recep]);
    await expect(ensure(recep, a.studioId)).rejects.toThrow(GENERIC);
    // the same words for a studio that does not exist (no oracle)
    await expect(ensure(a.userId, randomUUID())).rejects.toThrow(GENERIC);
    expect((await rowsFor(b.studioId)).rows).toHaveLength(0);
  });

  it("two studios each hold their own row with the same name (the display-name index exempts the placeholder)", async () => {
    const ida = (await ensure(a.userId, a.studioId)).rows[0].id;
    const idb = (await ensure(b.userId, b.studioId)).rows[0].id;
    expect(ida).not.toBe(idb);
    expect((await rowsFor(b.studioId)).rows[0].display_name).toBe(LABEL);
  });

  it("RACE: two sessions at once create exactly one row and return the same id", async () => {
    const c = await seedStudio("unspec-race");
    try {
      const [x, y] = await Promise.all([ensure(c.userId, c.studioId), ensure(c.userId, c.studioId)]);
      expect(x.rows[0].id).toBe(y.rows[0].id);
      expect((await rowsFor(c.studioId)).rows).toHaveLength(1);
    } finally {
      await adminQuery(`delete from public.studio_machines where studio_id=$1`, [c.studioId]).catch(() => undefined);
    }
  });

  it("a practitioner who is not the owner may create it (a member action), and the owner is not required", async () => {
    const m = await seedMember(b, "unspec-pract");
    expect((await ensure(m.userId, b.studioId)).rows[0].id).toBe((await rowsFor(b.studioId)).rows[0].id);
  });
});

describe("0385 the placeholder is inert", () => {
  beforeAll(async () => {
    if (!published) await publishReal();
    await ensure(a.userId, a.studioId);
  });
  const placeholderId = async () => (await rowsFor(a.studioId)).rows[0].id as string;

  it("an owner cannot REGISTER the reserved name, in any case or spacing; a different name still registers", async () => {
    // Leading and trailing tab, newline, non-breaking and other Unicode spaces are whitespace too: none may make a lookalike.
    for (const name of ["Machine not specified", "  machine   NOT specified ", "MACHINE NOT SPECIFIED", "\tMachine not specified ", "\nMachine not specified\n", "\u00a0Machine not specified\u00a0", "Machine\u00a0not\u2003specified", "\u3000machine not specified\ufeff"]) {
      await expect(asUser(a.userId, (q) => q(`select public.register_studio_machine($1,$2,1,$3,'{}')`, [a.studioId, PUR, name]))).rejects.toThrow(/reserved/i);
    }
    const ok = await asUser(a.userId, (q) => q(`select public.register_studio_machine($1,$2,1,'Dectro xCell','{}') as id`, [a.studioId, PUR]));
    expect(ok.rows[0].id).toBeTruthy();
    // the placeholder still counts for nothing: a REAL xCell registered beside it, and the unique index still stops a second real one
    await expect(asUser(a.userId, (q) => q(`select public.register_studio_machine($1,$2,1,'Dectro xCell','{}')`, [a.studioId, PUR]))).rejects.toMatchObject({ code: "23505" });
  });

  it("retire refuses it (as 'Unknown machine') and leaves it in service", async () => {
    const id = await placeholderId();
    await expect(asUser(a.userId, (q) => q(`select public.retire_studio_machine($1)`, [id]))).rejects.toThrow(/Unknown machine/);
    expect((await rowsFor(a.studioId)).rows[0].retired_at).toBeNull();
  });

  it("set_own_default_machine refuses it", async () => {
    const id = await placeholderId();
    await expect(asUser(a.userId, (q) => q(`select public.set_own_default_machine($1,$2,'multiplex')`, [a.studioId, id]))).rejects.toThrow(/Unknown machine/);
  });

  it("the freeze trigger: it cannot be retired, renamed, re-optioned or unflagged, and a real unit cannot become one", async () => {
    const id = await placeholderId();
    for (const sql of [
      `update public.studio_machines set retired_at = now() where id = $1`,
      `update public.studio_machines set display_name = 'Room 1' where id = $1`,
      `update public.studio_machines set installed_options = '{x}' where id = $1`,
      `update public.studio_machines set is_unspecified = false where id = $1`,
    ]) await expect(adminQuery(sql, [id]), sql).rejects.toThrow();
    const real = (await adminQuery(`select id from public.studio_machines where studio_id=$1 and not is_unspecified limit 1`, [a.studioId])).rows[0].id;
    await expect(adminQuery(`update public.studio_machines set is_unspecified = true where id = $1`, [real])).rejects.toThrow(/immutable/i);
  });

  it("the shape constraint: a hand-made placeholder with a retired date, options or another name is refused", async () => {
    await expect(adminQuery(`insert into public.studio_machines (studio_id, machine_profile_id, machine_profile_version, display_name, installed_options, is_unspecified) values ($1,$2,7,'Room 1','{}',true)`, [a.studioId, PUR])).rejects.toThrow();
    await expect(adminQuery(`insert into public.studio_machines (studio_id, machine_profile_id, machine_profile_version, display_name, installed_options, is_unspecified) values ($1,$2,7,'Machine not specified','{x}',true)`, [a.studioId, PUR])).rejects.toThrow();
  });
});

describe("0385 end to end as a practitioner: MultiPlex with ZERO registered machines", () => {
  beforeAll(async () => {
    if (!published) await publishReal();
  });
  const groups = (pulse: string, el = "12") => JSON.stringify([{
    new_group_ref: "g1", channels: [],
    readings: [
      { field_key: "displayed_el", value: el, observation_source: "machine-displayed" },
      { stage_key: "slow_thermolysis", field_key: "slow_thermolysis_duration", value: "1.85", observation_source: "practitioner-entered" },
      { stage_key: "slow_thermolysis", field_key: "slow_thermolysis_intensity", value: "30", observation_source: "practitioner-entered" },
      { stage_key: "snap", field_key: "snap_duration", value: "0.033", observation_source: "practitioner-entered" },
      { stage_key: "snap", field_key: "snap_intensity", value: "60", observation_source: "practitioner-entered" },
      { stage_key: "snap", field_key: "snap_count", value: pulse, observation_source: "practitioner-entered" },
    ],
  }]);

  it("a studio with no machine records 3 pulses with exact decimals and optional blanks, and the block carries profile, mode and the placeholder", async () => {
    const s = await seedStudio("unspec-e2e");
    try {
      const { sessionId, blockId } = await seedSession(s);
      const id = (await ensure(s.userId, s.studioId)).rows[0].id as string;
      expect((await adminQuery(`select count(*)::int n from public.studio_machines where studio_id=$1 and not is_unspecified`, [s.studioId])).rows[0].n).toBe(0);
      await asUser(s.userId, (q) =>
        q(`select public.record_setup_submission_with_identity($1,$2,$3,$4,$5::jsonb,$6,$7)`, [blockId, id, "multiplex", `unspec-e2e-${randomUUID()}`.slice(0, 40), groups("3"), sessionId, s.clientId]),
      );
      const blk = (await adminQuery(`select machine_profile_id, studio_machine_id, machine_mode_key from public.session_blocks where id=$1`, [blockId])).rows[0];
      expect(blk).toEqual({ machine_profile_id: PUR, studio_machine_id: id, machine_mode_key: "multiplex" });
      const rd = (await adminQuery(`select field_key, value_numeric::text as v, value_text from public.treatment_setup_readings where session_block_id=$1 order by field_key`, [blockId])).rows;
      const byKey = Object.fromEntries(rd.map((r) => [r.field_key, r.v]));
      expect(byKey.snap_count).toBe("3");
      expect(byKey.snap_duration).toBe("0.033");
      expect(byKey.slow_thermolysis_duration).toBe("1.85");
      expect(byKey).not.toHaveProperty("snap_interval");
      expect(byKey).not.toHaveProperty("displayed_ul");
      // latest setup for the client (next-visit recall) carries the 3 pulses
      const latest = await asUser(s.userId, (q) => q(`select * from public.latest_setup_for_client($1,$2,$3)`, [s.studioId, s.clientId, null]));
      expect(JSON.stringify(latest.rows)).toContain("snap_count");
      // the machine is never a registered one
      expect((await adminQuery(`select count(*)::int n from public.studio_machines where studio_id=$1 and not is_unspecified`, [s.studioId])).rows[0].n).toBe(0);
    } finally {
      await adminQuery(`delete from public.studio_machines where studio_id=$1`, [s.studioId]).catch(() => undefined);
    }
  });

  it("a receptionist cannot chart through the command (no practitioner row), whatever unit id they are given", async () => {
    const s = await seedStudio("unspec-recep");
    const { sessionId, blockId } = await seedSession(s);
    const id = (await ensure(s.userId, s.studioId)).rows[0].id as string;
    const recep = randomUUID();
    await adminQuery(`insert into auth.users (id, email) values ($1, $2)`, [recep, `recep-${recep.slice(0, 8)}@harness.local`]);
    await adminQuery(`insert into public.studio_receptionists (studio_id, user_id, display_name, active) values ($1,$2,'Synthetic Front Desk',true)`, [s.studioId, recep]);
    await expect(asUser(recep, (q) => q(`select public.record_setup_submission_with_identity($1,$2,$3,$4,$5::jsonb,$6,$7)`, [blockId, id, "multiplex", `unspec-r-${randomUUID()}`.slice(0, 40), groups("3"), sessionId, s.clientId]))).rejects.toThrow();
    expect((await adminQuery(`select count(*)::int n from public.treatment_setup_readings where session_block_id=$1`, [blockId])).rows[0].n).toBe(0);
    await adminQuery(`delete from public.studio_machines where studio_id=$1`, [s.studioId]).catch(() => undefined);
  });
});

describe("0385 a version transition", () => {
  it("a new published version gets a NEW row for new areas; the old area keeps its own row and version; one row per version", async () => {
    if (!published) await publishReal();
    const s = await seedStudio("unspec-version");
    try {
      const v1 = (await ensure(s.userId, s.studioId)).rows[0].id as string;
      const { sessionId, blockId } = await seedSession(s);
      await asUser(s.userId, (q) => q(`select public.record_setup_submission_with_identity($1,$2,$3,$4,$5::jsonb,$6,$7)`, [blockId, v1, "multiplex", `unspec-v-${randomUUID()}`.slice(0, 40), groups1("3"), sessionId, s.clientId]));
      // publish version 2 of the same mode (a test-only copy of the v1 contract rows)
      await adminQuery(`insert into public.machine_profile_mode_contract (machine_profile_id, machine_profile_version, mode_key) values ($1, 2, 'multiplex')`, [PUR]);
      const v2 = (await ensure(s.userId, s.studioId)).rows[0].id as string;
      expect(v2).not.toBe(v1);
      const rows = (await rowsFor(s.studioId)).rows;
      expect(rows.map((r) => r.machine_profile_version)).toEqual([1, 2]);
      // the old area is untouched and still points at the v1 row
      expect((await adminQuery(`select studio_machine_id from public.session_blocks where id=$1`, [blockId])).rows[0].studio_machine_id).toBe(v1);
      // while two versions are published, a repeat call keeps returning the highest
      expect((await ensure(s.userId, s.studioId)).rows[0].id).toBe(v2);
    } finally {
      await adminQuery(`delete from public.studio_machines where studio_id=$1`, [s.studioId]).catch(() => undefined);
      await adminQuery(`delete from public.machine_profile_mode_contract where machine_profile_id=$1 and machine_profile_version=2`, [PUR]).catch(() => undefined);
    }
  });
});

function groups1(pulse: string): string {
  return JSON.stringify([{
    new_group_ref: "g1", channels: [],
    readings: [
      { field_key: "displayed_el", value: "12", observation_source: "machine-displayed" },
      { stage_key: "slow_thermolysis", field_key: "slow_thermolysis_duration", value: "1.85", observation_source: "practitioner-entered" },
      { stage_key: "slow_thermolysis", field_key: "slow_thermolysis_intensity", value: "30", observation_source: "practitioner-entered" },
      { stage_key: "snap", field_key: "snap_duration", value: "0.033", observation_source: "practitioner-entered" },
      { stage_key: "snap", field_key: "snap_intensity", value: "60", observation_source: "practitioner-entered" },
      { stage_key: "snap", field_key: "snap_count", value: pulse, observation_source: "practitioner-entered" },
    ],
  }]);
}

describe("0385 command census: every function that takes a machine id is classified accept or refuse", () => {
  // ACCEPT: the unspecified unit is a valid unit for the identity, readings and capture commands.
  // REFUSE: retire and the default command take a machine id and refuse the placeholder; register takes none but refuses its reserved name (all proved above).
  const ACCEPT = new Set([
    "apply_block_machine_identity", "assert_setup_scope", "create_block_with_initial_setup", "create_block_with_initial_setup_and_identity",
    "record_block_machine_identity", "record_setup_group_in_scope", "record_setup_submission_with_identity", "record_treatment_setup_group",
    "record_treatment_setup_submission",
  ]);
  const REFUSE = new Set(["register_studio_machine", "retire_studio_machine", "set_own_default_machine"]);
  // Not commands on a unit's identity: the placeholder's own creator, and READS that return what a block holds.
  const OTHER = new Set(["ensure_unspecified_machine", "setup_readings_for_block", "latest_setup_for_client", "setup_capture_history_for_block", "refuse_unspecified_machine_change"]);

  it("reads pg_proc and fails on any public function that takes a machine / studio_machine id and is not classified", async () => {
    const r = await adminQuery(
      `select distinct p.proname
         from pg_proc p
         cross join lateral unnest(p.proargnames, coalesce(p.proallargtypes, string_to_array(p.proargtypes::text, ' ')::oid[])) as a(arg_name, arg_type)
        where p.pronamespace = 'public'::regnamespace
          and a.arg_type = 'uuid'::regtype
          and a.arg_name ~* '(machine|unit|device)'
        order by 1`,
    );
    const names = [...new Set(r.rows.map((x) => x.proname as string))];
    const unclassified = names.filter((n) => !ACCEPT.has(n) && !REFUSE.has(n) && !OTHER.has(n));
    expect(unclassified, "classify these as accept or refuse in the 0385 census").toEqual([]);
    // and every classified command that exists is actually found (the census is not vacuous)
    for (const n of ["retire_studio_machine", "set_own_default_machine", "record_treatment_setup_group", "record_setup_submission_with_identity", "create_block_with_initial_setup_and_identity", "record_block_machine_identity"]) expect(names, n).toContain(n);
  });
});

describe("0385 the down refuses on every referencing table", () => {
  it("the guard names every table that references studio_machines (derived from the catalog, not a list)", async () => {
    const r = await adminQuery(
      `select conrelid::regclass::text as t from pg_constraint where contype = 'f' and confrelid = 'public.studio_machines'::regclass order by 1`,
    );
    const referencing = r.rows.map((x) => x.t as string);
    const fs = await import("node:fs");
    const down = fs.readFileSync("supabase/rollbacks/0385_unspecified_machine.down.sql", "utf8");
    for (const t of referencing) expect(down, `the down must check ${t}`).toContain(t.replace(/^public\./, ""));
  });
});

describe("0385 the down with data present", () => {
  const stripTx = (sql: string) => sql.split("\n").filter((l) => !/^\s*(begin|commit);\s*$/i.test(l)).join("\n");
  const runDown = async () => {
    const fs = await import("node:fs");
    const sql = stripTx(fs.readFileSync("supabase/rollbacks/0385_unspecified_machine.down.sql", "utf8"));
    // Inside a transaction that is always rolled back: the down is never really applied to this suite's database.
    await adminTx(async (q) => {
      await q(sql);
      throw new Error("ROLLED_BACK_ON_PURPOSE");
    });
  };

  it("refuses, and changes nothing, while any block or reading points at an unspecified row", async () => {
    if (!published) await publishReal();
    const s = await seedStudio("unspec-down");
    const { sessionId, blockId } = await seedSession(s);
    const id = (await ensure(s.userId, s.studioId)).rows[0].id as string;
    await asUser(s.userId, (q) => q(`select public.record_setup_submission_with_identity($1,$2,$3,$4,$5::jsonb,$6,$7)`, [blockId, id, "multiplex", `unspec-d-${randomUUID()}`.slice(0, 40), groups1("3"), sessionId, s.clientId]));
    const before = (await adminQuery(`select count(*)::int n from public.studio_machines where is_unspecified`)).rows[0].n;
    await expect(runDown()).rejects.toThrow(/0385 down refuses: charted data/);
    expect((await adminQuery(`select count(*)::int n from public.studio_machines where is_unspecified`)).rows[0].n).toBe(before);
    expect((await adminQuery(`select count(*)::int n from public.session_blocks where studio_machine_id=$1`, [id])).rows[0].n).toBe(1);
  });

  it("each referencing table alone is enough to refuse (readings, captures, submissions, receipts, block, default)", async () => {
    const fs = await import("node:fs");
    const down = fs.readFileSync("supabase/rollbacks/0385_unspecified_machine.down.sql", "utf8");
    for (const t of ["session_blocks", "treatment_setup_readings", "treatment_setup_submissions", "treatment_setup_captures", "block_write_receipts", "practitioners"]) {
      expect(down, t).toMatch(new RegExp(`from public\\.${t} \\w+ join public\\.studio_machines m on m\\.id = \\w+\\.\\w+ where m\\.is_unspecified`));
    }
  });
});
