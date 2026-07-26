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

// Migration 0157 — copy_session_setup + descriptor, proven on the REAL migrated
// local DB. The RPC is the ONLY writer and is service_role-only. It is atomic,
// idempotent, SETUP-ONLY (outcomes + minutes dropped), source-authoritative
// (derives the canonical previous session itself; rejects a stale source), and
// target-guarded (electrolysis draft that is EMPTY, under a row lock).

let a: SeededStudio;

beforeAll(async () => {
  a = await seedStudio("wsc");
});
afterAll(async () => {
  await closePool();
});

// ---- seed helpers (own sessions/blocks so counts are exact) ----------------
async function seedSession(
  studio: SeededStudio,
  opts: {
    startedAt: string;
    modality?: string;
    status?: string;
    clientId?: string;
    deletedAt?: string | null;
  },
): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into public.sessions (id, studio_id, client_id, practitioner_id, modality, record_status, started_at, deleted_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      id,
      studio.studioId,
      opts.clientId ?? studio.clientId,
      studio.practitionerId,
      opts.modality ?? "electrolysis",
      opts.status ?? "draft",
      opts.startedAt,
      opts.deletedAt ?? null,
    ],
  );
  return id;
}

// A source session with one block (Chin/left/blend) + area + first entry, so it
// is an eligible copy source with a stable fingerprint.
async function seedSourceWithBlock(studio: SeededStudio, sessionId: string): Promise<string> {
  const blockId = randomUUID();
  await adminQuery(
    `insert into public.session_blocks (id, studio_id, session_id, sort_order, primary_area, side, mode, energy_level, minutes_performed, machine_frequency)
     values ($1,$2,$3,1,'Chin','left','blend',10,15,'13.56 MHz')`,
    [blockId, studio.studioId, sessionId],
  );
  await adminQuery(
    `insert into public.session_block_areas (id, studio_id, session_block_id, area, laterality, display_order)
     values ($1,$2,$3,'Chin','left',0)`,
    [randomUUID(), studio.studioId, blockId],
  );
  await adminQuery(
    `insert into public.electrolysis_entries (id, session_id, block_id, area, areas, mode, energy_level, minutes_performed, machine_frequency, thermolysis_intensity_percent)
     values ($1,$2,$3,'Chin',array['Chin']::text[],'blend',10,15,'13.56 MHz',40)`,
    [randomUUID(), sessionId, blockId],
  );
  return blockId;
}

async function fingerprintOf(sessionId: string): Promise<string> {
  const r = await adminQuery("select public._whole_session_copy_fingerprint($1) as fp", [sessionId]);
  return r.rows[0].fp as string;
}
async function canonicalSourceId(target: string): Promise<string | null> {
  const r = await adminQuery("select public._whole_session_copy_source_id($1,$2) as id", [a.studioId, target]);
  return (r.rows[0].id as string | null) ?? null;
}

function validSpec(withInjectedOutcomes = false) {
  const block: Record<string, unknown> = {
    mode: "blend",
    apilus_modality: "Omniblend",
    energy_level: 12,
    machine_frequency: "13.56 MHz",
    probe_key: "sterex-gold-two-piece-f3-short",
    probe_brand: "Sterex",
    probe_material: "Gold",
    probe_piece_type: "Two-piece",
    probe_shank: "F",
    probe_size_value: "3",
    probe_length: "Short",
    probe_label: "Sterex · Gold · Two-piece · F3 Short",
    primary_area: "Chin",
    side: "left",
    custom_area_detail: null,
  };
  const entry: Record<string, unknown> = {
    area: "Chin",
    areas: ["Chin", "Upper lip"],
    mode: "blend",
    apilus_modality: "Omniblend",
    energy_level: 12,
    machine_frequency: "13.56 MHz",
    thermolysis_intensity_percent: 40,
    thermolysis_duration_seconds: 3,
    galvanic_ma: 0.1,
    galvanic_duration_seconds: 10,
    galvanic_intensity_percent: 50,
    units_of_lye: 30,
    pulse_count: 2,
    pulse_delay_seconds: 0.5,
  };
  if (withInjectedOutcomes) {
    Object.assign(block, {
      minutes_performed: 99,
      numbing_status: "used",
      numbing_notes: "should be ignored",
      tolerance_rating: 3,
      reaction_type: "mild_redness",
      probe_lot_number: "SHOULD-IGNORE",
    });
    Object.assign(entry, {
      minutes_performed: 99,
      comments: "should be ignored",
      hairs_treated: 5,
      observation_chips: ["Coarse hair"],
    });
  }
  return [
    {
      block,
      areas: [
        { area: "Chin", laterality: "left", display_order: 0 },
        { area: "Upper lip", laterality: "bilateral", display_order: 1 },
      ],
      entry,
    },
  ];
}

// Commit as postgres (bypasses the service_role-only EXECUTE grant; the function
// is SECURITY DEFINER so the code path is identical). Auto-commits.
async function callCopy(opts: {
  target: string;
  specs: unknown;
  key: string;
  fp: string;
  sourceId?: string | null;
  practitionerId?: string;
  studioId?: string;
}) {
  const r = await adminQuery(
    "select public.copy_session_setup($1,$2,$3,$4::jsonb,$5,$6,$7) as result",
    [
      opts.studioId ?? a.studioId,
      opts.target,
      opts.practitionerId ?? a.practitionerId,
      JSON.stringify(opts.specs),
      opts.key,
      opts.fp,
      opts.sourceId ?? null,
    ],
  );
  return r.rows[0].result as {
    created_block_ids: string[];
    copied_block_count: number;
    idempotent_replay: boolean;
  };
}

// Each scenario gets its OWN client so the canonical-source derivation is
// scoped to just this scenario's sessions (no cross-test pollution).
async function freshClient(): Promise<string> {
  const id = randomUUID();
  await adminQuery("insert into public.clients (id, studio_id, name) values ($1,$2,$3)", [
    id,
    a.studioId,
    `WSC ${id.slice(0, 8)}`,
  ]);
  return id;
}

// A source + target pair for one fresh client; returns ids + source fingerprint.
async function seedScenario(
  targetOpts: { modality?: string; status?: string; deletedAt?: string | null } = {},
) {
  const clientId = await freshClient();
  const source = await seedSession(a, { startedAt: "2026-01-01T10:00:00Z", clientId });
  await seedSourceWithBlock(a, source);
  const target = await seedSession(a, { startedAt: "2026-06-01T10:00:00Z", clientId, ...targetOpts });
  const fp = await fingerprintOf(source);
  return { source, target, fp, clientId };
}
async function seedPair() {
  return seedScenario();
}

describe("copy_session_setup — atomic batch create (setup-only, no minutes)", () => {
  it("creates the block + areas + first entry; injected outcomes AND minutes are dropped", async () => {
    const { source, target, fp } = await seedPair();
    const res = await callCopy({ target, specs: validSpec(true), key: "k-create", fp, sourceId: source });
    expect(res.created_block_ids).toHaveLength(1);
    expect(res.copied_block_count).toBe(1);
    expect(res.idempotent_replay).toBe(false);

    const blk = (
      await adminQuery(
        "select mode, energy_level, machine_frequency, primary_area, side, minutes_performed, numbing_status, tolerance_rating, reaction_type, probe_lot_number, probe_label from public.session_blocks where id=$1",
        [res.created_block_ids[0]],
      )
    ).rows[0];
    expect(blk).toMatchObject({ mode: "blend", primary_area: "Chin", side: "left", probe_label: "Sterex · Gold · Two-piece · F3 Short" });
    expect(Number(blk.energy_level)).toBe(12);
    // minutes + outcomes NOT copied.
    expect(blk.minutes_performed).toBeNull();
    expect(blk.numbing_status).toBeNull();
    expect(blk.tolerance_rating).toBeNull();
    expect(blk.reaction_type).toBeNull();
    expect(blk.probe_lot_number).toBeNull();

    const areas = await adminQuery(
      "select area, laterality from public.session_block_areas where session_block_id=$1 order by display_order",
      [res.created_block_ids[0]],
    );
    expect(areas.rows).toEqual([
      { area: "Chin", laterality: "left" },
      { area: "Upper lip", laterality: "bilateral" },
    ]);

    const entry = (
      await adminQuery(
        "select minutes_performed, thermolysis_intensity_percent, units_of_lye, pulse_count, comments, hairs_treated from public.electrolysis_entries where block_id=$1",
        [res.created_block_ids[0]],
      )
    ).rows[0];
    expect(entry.minutes_performed).toBeNull(); // <-- P1-5
    expect(entry.comments).toBeNull();
    expect(entry.hairs_treated).toBeNull();
    expect(Number(entry.thermolysis_intensity_percent)).toBe(40);
    expect(Number(entry.units_of_lye)).toBe(30);
    expect(Number(entry.pulse_count)).toBe(2);
  });

  it("records truthful ledger provenance (source, target, practitioner, hash, fingerprint, count)", async () => {
    const { source, target, fp } = await seedPair();
    await callCopy({ target, specs: validSpec(), key: "k-ledger", fp, sourceId: source });
    const led = (
      await adminQuery(
        "select studio_id, target_session_id, source_session_id, created_by_practitioner_id, request_hash, source_fingerprint, copied_block_count from public.session_copy_operations where target_session_id=$1",
        [target],
      )
    ).rows[0];
    expect(led.studio_id).toBe(a.studioId);
    expect(led.target_session_id).toBe(target);
    expect(led.source_session_id).toBe(source);
    expect(led.created_by_practitioner_id).toBe(a.practitionerId);
    expect(led.source_fingerprint).toBe(fp);
    expect(typeof led.request_hash).toBe("string");
    expect(led.request_hash.length).toBeGreaterThan(0);
    expect(led.copied_block_count).toBe(1);
  });
});

describe("copy_session_setup — idempotency & session-wide serialization", () => {
  it("same key + same request → replay (no new rows); ledger stays at 1", async () => {
    const { source, target, fp } = await seedPair();
    const first = await callCopy({ target, specs: validSpec(), key: "k-idem", fp, sourceId: source });
    const second = await callCopy({ target, specs: validSpec(), key: "k-idem", fp, sourceId: source });
    expect(second.idempotent_replay).toBe(true);
    expect(second.created_block_ids).toEqual(first.created_block_ids);
    const n = (await adminQuery("select count(*)::int n from public.session_blocks where session_id=$1 and deleted_at is null", [target])).rows[0].n;
    expect(n).toBe(1);
    const led = (await adminQuery("select count(*)::int n from public.session_copy_operations where target_session_id=$1", [target])).rows[0].n;
    expect(led).toBe(1);
  });

  it("same key + DIFFERENT payload → rejected as ambiguous (HN006)", async () => {
    const { source, target, fp } = await seedPair();
    await callCopy({ target, specs: validSpec(), key: "k-amb", fp, sourceId: source });
    // A second spec with an extra area changes the request hash.
    const other = validSpec();
    other[0].areas.push({ area: "Neck", laterality: "left", display_order: 2 });
    await expect(callCopy({ target, specs: other, key: "k-amb", fp, sourceId: source })).rejects.toMatchObject({ code: "HN006" });
  });

  it("a NEW key after a successful commit is rejected (target no longer empty, HN003)", async () => {
    const { source, target, fp } = await seedPair();
    await callCopy({ target, specs: validSpec(), key: "k-first", fp, sourceId: source });
    await expect(callCopy({ target, specs: validSpec(), key: "k-second", fp, sourceId: source })).rejects.toMatchObject({ code: "HN003" });
    const n = (await adminQuery("select count(*)::int n from public.session_blocks where session_id=$1 and deleted_at is null", [target])).rows[0].n;
    expect(n).toBe(1);
  });
});

describe("copy_session_setup — source authority & stale detection", () => {
  it("rejects a wrong fingerprint (HN005), creating nothing", async () => {
    const { source, target } = await seedPair();
    await expect(callCopy({ target, specs: validSpec(), key: "k-badfp", fp: "deadbeef", sourceId: source })).rejects.toMatchObject({ code: "HN005" });
    const n = (await adminQuery("select count(*)::int n from public.session_blocks where session_id=$1", [target])).rows[0].n;
    expect(n).toBe(0);
  });

  it("rejects when the source changed since the preview (edited source block → HN005)", async () => {
    const { source, target, fp } = await seedPair();
    // Edit the source AFTER capturing fp.
    await adminQuery("update public.session_blocks set energy_level=99 where session_id=$1", [source]);
    await expect(callCopy({ target, specs: validSpec(), key: "k-changed", fp, sourceId: source })).rejects.toMatchObject({ code: "HN005" });
  });

  it("rejects when a source area changed since the preview (HN005)", async () => {
    const { source, target, fp } = await seedPair();
    await adminQuery(
      "update public.session_block_areas set laterality='right' where session_block_id in (select id from public.session_blocks where session_id=$1)",
      [source],
    );
    await expect(callCopy({ target, specs: validSpec(), key: "k-areachg", fp, sourceId: source })).rejects.toMatchObject({ code: "HN005" });
  });

  it("fails closed (zero rows) when the source became ineligible after preview (all areas removed)", async () => {
    const { source, target, fp } = await seedPair();
    await adminQuery(
      "delete from public.session_block_areas where session_block_id in (select id from public.session_blocks where session_id=$1)",
      [source],
    );
    // No eligible source now → HN004; either way, ZERO destination rows.
    await expect(callCopy({ target, specs: validSpec(), key: "k-areadel", fp, sourceId: source })).rejects.toMatchObject({ code: "HN004" });
    const n = (await adminQuery("select count(*)::int n from public.session_blocks where session_id=$1", [target])).rows[0].n;
    expect(n).toBe(0);
  });

  it("rejects when the browser's source id disagrees with the canonical source (HN005)", async () => {
    const { target, fp } = await seedPair();
    await expect(callCopy({ target, specs: validSpec(), key: "k-wrongsrc", fp, sourceId: randomUUID() })).rejects.toMatchObject({ code: "HN005" });
  });

  it("rejects when there is NO eligible source (HN004)", async () => {
    // A target with no prior session for the client.
    const lonelyClient = randomUUID();
    await adminQuery("insert into public.clients (id, studio_id, name) values ($1,$2,'Lonely')", [lonelyClient, a.studioId]);
    const target = await seedSession(a, { startedAt: "2026-06-01T10:00:00Z", clientId: lonelyClient });
    const fp = "whatever";
    await expect(callCopy({ target, specs: validSpec(), key: "k-nosrc", fp })).rejects.toMatchObject({ code: "HN004" });
  });

  it("does NOT pick a source from a DIFFERENT client, a LATER session, or a LASER session", async () => {
    const cMain = await freshClient();
    const cOther = await freshClient();
    // prior for a DIFFERENT client — must be ignored.
    const otherPrior = await seedSession(a, { startedAt: "2026-01-01T10:00:00Z", clientId: cOther });
    await seedSourceWithBlock(a, otherPrior);
    // a LASER prior for our client — must be ignored.
    const laserPrior = await seedSession(a, { startedAt: "2026-02-01T10:00:00Z", modality: "laser", clientId: cMain });
    await seedSourceWithBlock(a, laserPrior);
    // a LATER electrolysis session (after target) — must be ignored.
    const later = await seedSession(a, { startedAt: "2026-09-01T10:00:00Z", clientId: cMain });
    await seedSourceWithBlock(a, later);
    const target = await seedSession(a, { startedAt: "2026-06-01T10:00:00Z", clientId: cMain });
    expect(await canonicalSourceId(target)).toBeNull();
  });
});

describe("copy_session_setup — target eligibility", () => {
  it("rejects a LASER target (HN002)", async () => {
    const { source, target, fp } = await seedScenario({ modality: "laser" });
    await expect(callCopy({ target, specs: validSpec(), key: "k-laser", fp, sourceId: source })).rejects.toMatchObject({ code: "HN002" });
  });

  it("rejects a FINALIZED target (HN002)", async () => {
    const { source, target, fp } = await seedScenario({ status: "finalized" });
    await expect(callCopy({ target, specs: validSpec(), key: "k-final", fp, sourceId: source })).rejects.toMatchObject({ code: "HN002" });
  });

  it("rejects a DELETED target (HN002 not found)", async () => {
    const { source, target, fp } = await seedScenario({ deletedAt: "2026-06-02T10:00:00Z" });
    await expect(callCopy({ target, specs: validSpec(), key: "k-deltarget", fp, sourceId: source })).rejects.toMatchObject({ code: "HN002" });
  });

  it("rejects a target that already has a block (HN003)", async () => {
    const { source, target, fp } = await seedPair();
    await seedSourceWithBlock(a, target); // target no longer empty
    await expect(callCopy({ target, specs: validSpec(), key: "k-nonempty", fp, sourceId: source })).rejects.toMatchObject({ code: "HN003" });
  });

  it("rejects a target that has a live orphan entry (HN003)", async () => {
    const { source, target, fp } = await seedPair();
    await adminQuery(
      "insert into public.electrolysis_entries (id, session_id, area, areas, mode) values ($1,$2,'Chin',array['Chin']::text[],'blend')",
      [randomUUID(), target],
    );
    await expect(callCopy({ target, specs: validSpec(), key: "k-orphan", fp, sourceId: source })).rejects.toMatchObject({ code: "HN003" });
  });
});

describe("copy_session_setup — authorization & atomicity", () => {
  it("rejects a non-member practitioner (HN001)", async () => {
    const b = await seedStudio("wsc-other");
    const { source, target, fp } = await seedPair();
    await expect(
      callCopy({ target, specs: validSpec(), key: "k-nonmember", fp, sourceId: source, practitionerId: b.practitionerId }),
    ).rejects.toMatchObject({ code: "HN001" });
  });

  it("rejects an INACTIVE practitioner (HN001)", async () => {
    const inactiveUser = randomUUID();
    await adminQuery("insert into auth.users (id, email) values ($1,$2)", [inactiveUser, `inactive-${inactiveUser}@harness.local`]);
    const inactivePrac = randomUUID();
    await adminQuery(
      "insert into public.practitioners (id, studio_id, user_id, display_name, email, role, active) values ($1,$2,$3,'Inactive','x@h.local','practitioner',false)",
      [inactivePrac, a.studioId, inactiveUser],
    );
    const { source, target, fp } = await seedPair();
    await expect(
      callCopy({ target, specs: validSpec(), key: "k-inactive", fp, sourceId: source, practitionerId: inactivePrac }),
    ).rejects.toMatchObject({ code: "HN001" });
  });

  it("the authenticated role CANNOT execute copy_session_setup (service_role-only grant)", async () => {
    const { source, target, fp } = await seedPair();
    await expect(
      asUser(a.userId, (q) =>
        q("select public.copy_session_setup($1,$2,$3,$4::jsonb,$5,$6,$7)", [
          a.studioId, target, a.practitionerId, JSON.stringify(validSpec()), "k-authrole", fp, source,
        ]),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("anon CANNOT execute the source descriptor (grant)", async () => {
    const { target } = await seedPair();
    await expect(
      asRole("anon", (q) => q("select public.whole_session_copy_source_descriptor($1,$2)", [a.studioId, target])),
    ).rejects.toThrow(/permission denied/i);
  });

  it("a bad spec mid-batch rolls back the WHOLE copy (no partial blocks, no ledger row)", async () => {
    const { source, target, fp } = await seedPair();
    const specs = [
      validSpec()[0],
      { block: { mode: "blend", primary_area: "Neck" }, areas: [{ area: "Neck", laterality: "sideways" }], entry: null },
    ];
    await expect(callCopy({ target, specs, key: "k-atomic", fp, sourceId: source })).rejects.toThrow();
    const n = (await adminQuery("select count(*)::int n from public.session_blocks where session_id=$1", [target])).rows[0].n;
    expect(n).toBe(0);
    const led = (await adminQuery("select count(*)::int n from public.session_copy_operations where target_session_id=$1", [target])).rows[0].n;
    expect(led).toBe(0);
  });
});

describe("whole_session_copy_source_descriptor — member-gated preview", () => {
  it("returns the SERVER-derived source id + fingerprint for an eligible empty target", async () => {
    const { source, target, fp } = await seedPair();
    const r = await asUser(a.userId, (q) =>
      q("select public.whole_session_copy_source_descriptor($1,$2) as d", [a.studioId, target]),
    );
    const d = r.rows[0].d as { eligible: boolean; source_session_id: string; source_fingerprint: string };
    expect(d.eligible).toBe(true);
    expect(d.source_session_id).toBe(source);
    expect(d.source_fingerprint).toBe(fp);
  });

  it("reports not-eligible for a non-empty target", async () => {
    const { target } = await seedPair();
    await seedSourceWithBlock(a, target);
    const r = await asUser(a.userId, (q) =>
      q("select public.whole_session_copy_source_descriptor($1,$2) as d", [a.studioId, target]),
    );
    expect((r.rows[0].d as { eligible: boolean }).eligible).toBe(false);
  });

  it("a non-member is rejected (HN001)", async () => {
    const b = await seedStudio("wsc-desc-other");
    const { target } = await seedPair();
    await expect(
      asUser(b.userId, (q) => q("select public.whole_session_copy_source_descriptor($1,$2)", [a.studioId, target])),
    ).rejects.toMatchObject({ code: "HN001" });
  });
});
