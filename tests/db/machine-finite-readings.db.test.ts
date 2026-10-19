import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { publicationFixture } from "../fixtures/machine-publication";
import { planContractPublication } from "../../lib/machines/contract-publication";
import { asRole, closePool, RECORD_GROUP_SQL, seedSession, seedStudio } from "./helpers/harness";

afterAll(closePool);

// Requires allocated 0235's finite-value repair applied by the slot owner to the
// isolated lane stack. Intentionally RED on frozen 0223 alone; never self-applies SQL.
describe("direct RPC callers cannot persist non-finite clinical readings", () => {
  it.each(["NaN", "Infinity", "-Infinity"])("refuses %s with zero persisted capture/reading delta", async (value) => {
    const p = publicationFixture(`synthetic:finite-${randomUUID()}`);
    // preset-identifier is not covered by the non-negative quantity check.
    // This ensures negative infinity reaches the finiteness boundary too.
    p.modes[0].fields[0] = { ...p.modes[0].fields[0], key: "preset", quantity: "preset-identifier", unit: "none", decimals: 0 };
    const c = planContractPublication([p]).publish[0];
    const studio = await seedStudio("finite");
    const { blockId, sessionId } = await seedSession(studio);
    await asRole("service_role", async (q) => {
      await q("select public.sync_machine_profile_contract($1,$2,$3,$4,$5,$6::jsonb)", [c.p_machine_profile_id, c.p_machine_profile_version, c.p_mode_key, c.p_channels_max, c.p_requires_installed_option, JSON.stringify(c.p_fields)]);
      await q("reset role");
      await q("set local role authenticated");
      await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: studio.userId, role: "authenticated" })]);
      const machine = (await q("select public.register_studio_machine($1,$2,1,'Finite fixture','{}') as id", [studio.studioId, p.profileId])).rows[0].id;
      const record = (v: string, group: string) => q(RECORD_GROUP_SQL, [blockId, machine, "galvanic", group, [], JSON.stringify([{ field_key: "preset", value: v, observation_source: "practitioner-entered" }]), sessionId, studio.clientId]);
      expect(Number((await record("0", "zero")).rows[0].n)).toBe(1);
      const counts = async () => (await q("select (select count(*)::int from public.treatment_setup_captures where session_block_id=$1) as captures, (select count(*)::int from public.treatment_setup_readings where session_block_id=$1) as readings", [blockId])).rows;
      const before = await counts();
      await q("savepoint malformed");
      await expect(record(value, "invalid")).rejects.toMatchObject({ code: "23514" });
      await q("rollback to savepoint malformed");
      expect(await counts()).toEqual(before);
      expect(Number((await record("123", "finite")).rows[0].n)).toBe(1);
    });
  });
});
