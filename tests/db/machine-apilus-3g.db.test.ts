import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { APILUS_3G_PROFILES } from "../../lib/machines/apilus-3g";
import { APILUS_3G_TEXT_FIXTURES } from "../../lib/machines/apilus-3g-fixtures";
import { modeFields } from "../../lib/machines/profile-contract";
import { planContractPublication } from "../../lib/machines/contract-publication";
import { asRole, closePool, RECORD_GROUP_SQL, seedSession, seedStudio } from "./helpers/harness";

afterAll(closePool);

// Uses synthetic identities with the reviewed native field
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

// 0237 proof PREPARED, UNRUN until OPS grants a target/candidate and heavy slot.
// Uses the existing role/seed/record helpers, never self-applies a migration.
for (const original of APILUS_3G_TEXT_FIXTURES) {
  describe(`${original.model} v3 faithful categorical/text storage`, () => {
    it.each(original.modes.filter((m) => m.fields.some((f) => f.valueKind === "choice")))("$key records both native starting-current choices and preserves program text", async (mode) => {
      const p = structuredClone(original);
      p.profileId = `synthetic:3g-text-${randomUUID()}`;
      p.modes = [structuredClone(mode)];
      const c = planContractPublication([p]).publish[0];
      const studio = await seedStudio("3g-text");
      const visit = await seedSession(studio);
      const next = await seedSession(studio);
      const choice = mode.fields.find((f) => f.valueKind === "choice")!;
      const readings = modeFields(mode).map(({ field, stageKey }) => ({
        stage_key: stageKey, field_key: field.key, observation_source: field.expectedSource,
        ...(field.valueKind ? { value_text: field.valueKind === "choice" ? choice.choices![0] : "003i" } : { value: field.decimals === 3 ? "0.047" : field.decimals === 2 ? "0.27" : field.decimals === 1 ? "1.3" : "7" }),
      }));
      const setText = (payload: typeof readings, key: string, value: string) => {
        const reading = payload.find((r) => r.field_key === key);
        if (!reading || !("value_text" in reading)) throw new Error(`Missing native text field ${key}`);
        reading.value_text = value;
      };
      await asRole("service_role", async (q) => {
        const publishArgs = [c.p_machine_profile_id, c.p_machine_profile_version, c.p_mode_key, c.p_channels_max, c.p_requires_installed_option, JSON.stringify(c.p_fields)];
        const publish = "select public.sync_machine_profile_contract($1,$2,$3,$4,$5,$6::jsonb) as n";
        expect(Number((await q(publish, publishArgs)).rows[0].n)).toBe(c.p_fields.length);
        expect(Number((await q(publish, publishArgs)).rows[0].n)).toBe(0);
        const changed = structuredClone(c.p_fields);
        changed.find((f) => f.field_key === choice.key)!.choices = ["forged"];
        await q("savepoint changed_contract");
        await expect(q(publish, [...publishArgs.slice(0, 5), JSON.stringify(changed)])).rejects.toMatchObject({ code: "23001" });
        await q("rollback to savepoint changed_contract");
        await q("reset role"); await q("set local role authenticated");
        await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: studio.userId, role: "authenticated" })]);
        const device = (await q("select public.register_studio_machine($1,$2,3,'Native text fixture','{}') as id", [studio.studioId, p.profileId])).rows[0].id;
        let recordedGroupKey = "main";
        const record = (payload: unknown[]) => q(RECORD_GROUP_SQL, [visit.blockId, device, mode.key, recordedGroupKey, [], JSON.stringify(payload), visit.sessionId, studio.clientId]);
        const read = async () => (await q("select group_key,stage_key,field_key,value_numeric::text as value_numeric,value_text,native_unit,decimals,revision from public.treatment_setup_readings where session_block_id=$1 order by revision,stage_key,field_key", [visit.blockId])).rows;
        await record(readings);
        const first = await read();
        recordedGroupKey = first[0].group_key;
        expect(first.find((r) => r.field_key === "program_identifier")).toMatchObject({ value_numeric: null, value_text: "003i", native_unit: "none", decimals: 0 });
        for (const value of ["forged", "0", "Hf Glv "]) {
          const invalid = structuredClone(readings);
          setText(invalid, choice.key, value);
          await q("savepoint malformed_choice");
          await expect(record(invalid)).rejects.toMatchObject({ code: "23514" });
          await q("rollback to savepoint malformed_choice");
          expect(await read()).toEqual(first);
        }
        const blankText = structuredClone(readings);
        setText(blankText, "program_identifier", "\t");
        await q("savepoint malformed_text");
        await expect(record(blankText)).rejects.toMatchObject({ code: "23514" });
        await q("rollback to savepoint malformed_text");
        expect(await read()).toEqual(first);
        const revised = structuredClone(readings);
        setText(revised, choice.key, choice.choices![1]);
        setText(revised, "program_identifier", "03i");
        await record(revised);
        const history = (await q("select public.setup_capture_history_for_block($1) as data", [visit.blockId])).rows[0].data;
        expect(history).toHaveLength(2);
        const previous = (await q("select public.latest_setup_for_client($1,$2,$3) as data", [studio.studioId, studio.clientId, next.sessionId])).rows[0].data;
        expect(previous.find((r: { field_key: string }) => r.field_key === "program_identifier").value_text).toBe("03i");
        expect(previous.find((r: { field_key: string }) => r.field_key === choice.key).value_text).toBe(choice.choices![1]);
        expect((await read()).filter((r) => r.revision === 1)).toEqual(first);
      });
    });
  });
}
