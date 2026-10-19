import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { planContractPublication, publishContracts, type Publication } from "../../lib/machines/contract-publication";
import { publicationFixture } from "../fixtures/machine-publication";
import { asRole, closePool, RECORD_GROUP_SQL, seedSession, seedStudio } from "./helpers/harness";

afterAll(closePool);

describe("catalogue publication through the real service_role command", () => {
  it("publishes verified modes, records them, skips pending modes, replays and refuses mutation", async () => {
    const p = publicationFixture(`synthetic:publish-${randomUUID()}`);
    const pending = structuredClone(p.modes[0]);
    pending.key = "pending";
    pending.availability = "blocked";
    pending.verification = "pending-evidence";
    p.modes.push(pending);
    const plan = planContractPublication([p]);
    expect(plan.publish).toHaveLength(1);
    expect(plan.skipped).toHaveLength(1);
    const studio = await seedStudio("publication");
    const { blockId, sessionId } = await seedSession(studio);
    // This helper rolls back the whole transaction. No global contracts are
    // left behind, and the real service_role privilege is exercised, not postgres.
    await asRole("service_role", async (q) => {
      const publish = async (c: Publication) => Number((await q(
        "select public.sync_machine_profile_contract($1,$2,$3,$4,$5,$6::jsonb) as n",
        [c.p_machine_profile_id, c.p_machine_profile_version, c.p_mode_key, c.p_channels_max, c.p_requires_installed_option, JSON.stringify(c.p_fields)],
      )).rows[0].n);
      expect((await publishContracts(plan, publish))[0].inserted).toBe(1);
      const before = (await q("select * from public.machine_profile_field_contract where machine_profile_id=$1", [p.profileId])).rows;
      expect((await publishContracts(plan, publish))[0].inserted).toBe(0);
      expect((await q("select * from public.machine_profile_field_contract where machine_profile_id=$1", [p.profileId])).rows).toEqual(before);
      const changed = structuredClone(plan);
      changed.publish[0].p_fields[0].decimals = 2;
      await q("savepoint changed_contract");
      await expect(publishContracts(changed, publish)).rejects.toThrow(/NEW version/i);
      await q("rollback to savepoint changed_contract");
      expect((await q("select * from public.machine_profile_field_contract where machine_profile_id=$1", [p.profileId])).rows).toEqual(before);
      expect((await q("select * from public.machine_profile_mode_contract where machine_profile_id=$1 and mode_key=$2", [p.profileId, pending.key])).rows).toEqual([]);

      // The operator cannot chart as service_role; recording is a separate,
      // authenticated member command with full route ownership checks.
      await q("reset role");
      await q("set local role authenticated");
      await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: studio.userId, role: "authenticated" })]);
      const register = async (profile: string, name: string) => (await q(
        "select public.register_studio_machine($1,$2,1,$3,'{}') as id",
        [studio.studioId, profile, name],
      )).rows[0].id;
      const machine = await register(p.profileId, "Verified fixture");
      const record = (id: string, modeKey = "galvanic") => q(RECORD_GROUP_SQL, [blockId, id, modeKey, "main", [], JSON.stringify([{ field_key: "current", value: "120.5", observation_source: "practitioner-entered" }]), sessionId, studio.clientId]);
      expect(Number((await record(machine)).rows[0].n)).toBe(1);
      expect((await q("select value_numeric::text as value from public.treatment_setup_readings where session_block_id=$1", [blockId])).rows).toEqual([{ value: "120.5" }]);
      await expect(record(machine, pending.key)).rejects.toThrow(/No field contract is published/i);
    });
  });
});
