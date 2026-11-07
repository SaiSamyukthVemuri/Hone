import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

import { adminQuery, asUser, closePool, seedSession, seedStudio, type SeededStudio } from "./helpers/harness";

// ===========================================================================
// #1369 / 0301 FOLLOW-UP: THE IDENTITY ENTRYPOINTS VALIDATE THE MODE AGAINST THE PUBLISHED CONTRACT
// (Vercel Security Review 01M6VEJJ83G4GZ10DFCKMJAEVP).
//
// `record_block_machine_identity` is granted to `authenticated`, so a direct Data-API call could store any text
// as a block's `machine_mode_key`. The core `apply_block_machine_identity` now checks the registered unit's
// profile AND version against `machine_profile_mode_contract`, and the unit's installed options; a unitless
// profile is limited to the supported legacy identity. Real JWTs throughout. SYNTHETIC PROFILE IDS ONLY.
//
// This closes the direct Data-API path; service-role writers are unaffected.
// ===========================================================================

const PROFILE = `fixture:mode-contract-${randomUUID().slice(0, 8)}`;
const XCELL = "dectro-apilus:xcell";
const OPTION = "opt-fitted";

afterAll(async () => {
  await closePool();
});

async function publish(): Promise<void> {
  const fields = JSON.stringify([{ field_key: "current", native_unit: "µA", decimals: 0, quantity: "current", optional: true }]);
  await adminQuery(`select public.sync_machine_profile_contract($1,1,$2,4::smallint,null,$3::jsonb)`, [PROFILE, "galvanic", fields]);
  await adminQuery(`select public.sync_machine_profile_contract($1,1,$2,4::smallint,$3,$4::jsonb)`, [PROFILE, "gated", OPTION, fields]);
}

const register = (s: SeededStudio, options: string[]) =>
  asUser(s.userId, async (q) => {
    const r = await q(`select public.register_studio_machine($1,$2,1,$3,$4) as id`, [s.studioId, PROFILE, `Room ${randomUUID().slice(0, 4)}`, options]);
    return r.rows[0].id as string;
  });

type Reply = { updated_at: string; reused: boolean; machine_profile_id: string | null; studio_machine_id: string | null; machine_mode_key: string | null };
const stamp = (s: SeededStudio, sessionId: string, blockId: string, over: { profile?: string | null; machine?: string | null; mode?: string | null; key?: string | null }) =>
  asUser(s.userId, async (q) => {
    const r = await q(`select public.record_block_machine_identity($1,$2,$3,$4,$5,$6,$7,$8::timestamptz) as r`, [
      blockId, sessionId, s.clientId, over.profile ?? null, over.machine ?? null, over.mode ?? null, over.key ?? `k-${randomUUID()}`, null,
    ]);
    return r.rows[0].r as Reply;
  });

const refused = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { code?: string; message: string };
  }
  return null;
};

const stored = async (blockId: string) =>
  (await adminQuery(`select machine_profile_id, studio_machine_id, machine_mode_key from public.session_blocks where id = $1`, [blockId])).rows[0];

describe("record_block_machine_identity validates the mode (real JWT)", () => {
  it("a mode the unit's contract publishes is accepted and stored", async () => {
    await publish();
    const s = await seedStudio("mc-ok");
    const machine = await register(s, []);
    const { sessionId, blockId } = await seedSession(s);
    const r = await stamp(s, sessionId, blockId, { machine, mode: "galvanic" });
    expect(r.machine_mode_key).toBe("galvanic");
    expect((await stored(blockId)).machine_mode_key).toBe("galvanic");
  });

  it("an unknown mode key is refused and nothing is stored", async () => {
    await publish();
    const s = await seedStudio("mc-unk");
    const machine = await register(s, []);
    const { sessionId, blockId } = await seedSession(s);
    for (const mode of ["totally-bogus-mode", "x".repeat(120)]) {
      const e = await refused(stamp(s, sessionId, blockId, { machine, mode }));
      expect(e?.code, mode.slice(0, 20)).toBe("23514");
      expect(e?.message).toMatch(/does not offer that mode/);
    }
    expect((await stored(blockId)).machine_mode_key).toBeNull();
  });

  it("an option-gated mode is refused on a unit without the option and accepted on one with it", async () => {
    await publish();
    const s = await seedStudio("mc-opt");
    const bare = await register(s, []);
    const fitted = await register(s, [OPTION]);
    const a = await seedSession(s);
    const e = await refused(stamp(s, a.sessionId, a.blockId, { machine: bare, mode: "gated" }));
    expect(e?.code).toBe("23514");
    expect((await stored(a.blockId)).machine_mode_key).toBeNull();
    const b = await seedSession(s);
    const r = await stamp(s, b.sessionId, b.blockId, { machine: fitted, mode: "gated" });
    expect(r.machine_mode_key).toBe("gated");
  });

  it("a mode published only for another version of the profile is refused for this unit's version", async () => {
    await publish();
    const fields = JSON.stringify([{ field_key: "current", native_unit: "µA", decimals: 0, quantity: "current", optional: true }]);
    await adminQuery(`select public.sync_machine_profile_contract($1,2,$2,4::smallint,null,$3::jsonb)`, [PROFILE, "v2only", fields]);
    const s = await seedStudio("mc-ver");
    const machine = await register(s, []);
    const { sessionId, blockId } = await seedSession(s);
    const e = await refused(stamp(s, sessionId, blockId, { machine, mode: "v2only" }));
    expect(e?.code).toBe("23514");
    expect((await stored(blockId)).machine_mode_key).toBeNull();
  });

  it("a unitless identity is accepted for the legacy xCell and refused for any other profile", async () => {
    await publish();
    const s = await seedStudio("mc-unitless");
    const a = await seedSession(s);
    const ok = await stamp(s, a.sessionId, a.blockId, { profile: XCELL });
    expect(ok.machine_profile_id).toBe(XCELL);
    const b = await seedSession(s);
    const e = await refused(stamp(s, b.sessionId, b.blockId, { profile: PROFILE }));
    expect(e?.code).toBe("23514");
    expect(e?.message).toMatch(/xCell/);
    expect((await stored(b.blockId)).machine_profile_id).toBeNull();
  });

  it("a committed receipt replays its stored answer even if the unit has since lost the option", async () => {
    await publish();
    const s = await seedStudio("mc-replay");
    const machine = await register(s, [OPTION]);
    const { sessionId, blockId } = await seedSession(s);
    const key = `replay-${randomUUID()}`;
    const first = await stamp(s, sessionId, blockId, { machine, mode: "gated", key });
    await adminQuery(`update public.studio_machines set installed_options = '{}' where id = $1`, [machine]);
    const second = await stamp(s, sessionId, blockId, { machine, mode: "gated", key });
    expect(second.reused).toBe(true);
    expect(second.machine_mode_key).toBe(first.machine_mode_key);
    expect(second.updated_at).toBe(first.updated_at);
  });
});

describe("the other identity entrypoints go through the same validation", () => {
  it("record_setup_submission_with_identity and create_block_with_initial_setup_and_identity call apply_block_machine_identity", async () => {
    for (const fn of ["record_setup_submission_with_identity", "create_block_with_initial_setup_and_identity", "record_block_machine_identity"]) {
      const def = (await adminQuery(`select pg_get_functiondef(p.oid) as d from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1`, [fn])).rows;
      expect(def.length, fn).toBe(1);
      expect(def[0].d, fn).toMatch(/apply_block_machine_identity/);
    }
  });

  it("a setup submission with an option-gated mode on a unit without the option is refused and records nothing", async () => {
    await publish();
    const s = await seedStudio("mc-sub");
    const bare = await register(s, []);
    const { sessionId, blockId } = await seedSession(s);
    const groups = [{ new_group_ref: "g1", channels: [1], readings: [{ field_key: "current", value: "9", observation_source: "practitioner-entered" }] }];
    const e = await refused(
      asUser(s.userId, (q) =>
        q(`select public.record_setup_submission_with_identity($1,$2,$3,$4,$5::jsonb,$6,$7,$8::timestamptz)`, [
          blockId, bare, "gated", `sub-${randomUUID()}`, JSON.stringify(groups), sessionId, s.clientId, null,
        ]),
      ),
    );
    expect(e).not.toBeNull();
    expect((await stored(blockId)).machine_mode_key).toBeNull();
    const n = (await adminQuery(`select count(*)::int as n from public.treatment_setup_captures where session_block_id = $1`, [blockId])).rows[0].n;
    expect(n).toBe(0);
  });
});
