import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { APILUS_3G_PROFILES } from "../../lib/machines/apilus-3g";
import { modeFields } from "../../lib/machines/profile-contract";
import { planContractPublication } from "../../lib/machines/contract-publication";
import { asRole, closePool, RECORD_GROUP_SQL, seedSession, seedStudio } from "./helpers/harness";

afterAll(closePool);

// PENDING SLOT PROOF. Uses synthetic identities with the reviewed native field
// definitions; never activates or publishes a real model's held contract.
for (const original of APILUS_3G_PROFILES) {
  const eligible = original.modes.filter((m) => !m.captureHold && !modeFields(m).some(({ field }) => field.unverified?.length));
  describe(`${original.model} native numeric storage`, () => {
    it.each(eligible)("$key survives database read-back, history and next-visit lookup", async (mode) => {
      const p = structuredClone(original);
      p.profileId = `synthetic:3g-${randomUUID()}`;
      p.availability = "active";
      p.modes = [{ ...structuredClone(mode), availability: "active" }];
      // Questions for modes absent from this fixture must not pretend to hold
      // unrelated fields. No question about this eligible mode is removed.
      p.openQuestions = [];
      const plan = planContractPublication([p]);
      expect(plan.publish).toHaveLength(1);
      const c = plan.publish[0];
      const studio = await seedStudio("3g-native");
      const visit = await seedSession(studio);
      const next = await seedSession(studio);
      const readings = modeFields(mode).map(({ field: f, stageKey }) => ({
        stage_key: stageKey, field_key: f.key,
        value: f.decimals === 3 ? "0.047" : f.decimals === 2 ? "0.27" : f.decimals === 1 ? "1.3" : "7",
        observation_source: f.expectedSource,
      }));
      await asRole("service_role", async (q) => {
        await q("select public.sync_machine_profile_contract($1,$2,$3,$4,$5,$6::jsonb)", [c.p_machine_profile_id, c.p_machine_profile_version, c.p_mode_key, c.p_channels_max, c.p_requires_installed_option, JSON.stringify(c.p_fields)]);
        await q("reset role"); await q("set local role authenticated");
        await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: studio.userId, role: "authenticated" })]);
        const device = (await q("select public.register_studio_machine($1,$2,2,'Native fixture','{}') as id", [studio.studioId, p.profileId])).rows[0].id;
        expect(Number((await q(RECORD_GROUP_SQL, [visit.blockId, device, mode.key, "main", [], JSON.stringify(readings), visit.sessionId, studio.clientId])).rows[0].n)).toBe(readings.length);
        const read = async () => (await q("select stage_key, field_key, value_numeric::text as value, native_unit, decimals, machine_profile_version, observation_source from public.treatment_setup_readings where session_block_id=$1 order by stage_key, field_key", [visit.blockId])).rows;
        const saved = await read();
        expect(saved).toHaveLength(readings.length);
        for (const row of saved) {
          const expected = readings.find((r) => r.field_key === row.field_key)!;
          const field = modeFields(mode).find(({ field }) => field.key === row.field_key)!.field;
          expect(row).toMatchObject({ value: expected.value, native_unit: field.unit, decimals: field.decimals, machine_profile_version: 2, observation_source: field.expectedSource });
        }
        expect(await read()).toEqual(saved);
        const history = (await q("select public.setup_capture_history_for_block($1) as data", [visit.blockId])).rows[0].data;
        expect(history).toHaveLength(1);
        expect(history[0].machine_profile_version).toBe(2);
        const previous = (await q("select public.latest_setup_for_client($1,$2,$3) as data", [studio.studioId, studio.clientId, next.sessionId])).rows[0].data;
        expect(previous).toHaveLength(readings.length);
        for (const row of previous) {
          expect(row.machine_profile_version).toBe(2);
          expect(row.session_block_id).toBe(visit.blockId);
          expect(row.value_numeric).toBe(readings.find((r) => r.field_key === row.field_key)!.value);
        }
        expect(await read()).toEqual(saved);
      });
    });
  });
}
