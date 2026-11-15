import { afterAll, describe, expect, it } from "vitest";
import { APILUS_3G_TEXT_PROFILES } from "../../lib/machines/apilus-3g";
import { listableProfiles } from "../../lib/machines/listable-profiles";
import { planContractPublication } from "../../lib/machines/contract-publication";
import { activeModes, modeFields } from "../../lib/machines/profile-contract";
import { asRole, closePool, RECORD_GROUP_SQL, seedSession, seedStudio } from "./helpers/harness";

afterAll(closePool);

// HON-8 D4, Privacy F5: what is a profile version with only SOME modes published?
//
// The claim to prove, on a real local database, is the narrow one the design makes: a mode with no published contract is unavailable and
// NOTHING ELSE changes. The published mode records, reads back and shows in history; the unpublished one is refused by the database
// (fail closed) and leaves no row; the owner's model list does not offer the model until every active mode is published; and publishing
// the missing mode afterwards makes it work with the first untouched. Every step runs in ONE transaction (asRole rolls back), with a
// savepoint around each refusal because a database error otherwise aborts the transaction.

const senior = APILUS_3G_TEXT_PROFILES.find((p) => p.profileId === "dectro-apilus:senior-3g")!;
const plan = planContractPublication();
const row = (mode: string) => plan.publish.find((c) => c.p_machine_profile_id === senior.profileId && c.p_mode_key === mode)!;

function readingsFor(modeKey: string) {
  const mode = senior.modes.find((m) => m.key === modeKey)!;
  return modeFields(mode)
    .filter(({ field }) => !field.optional)
    .map(({ field: f, stageKey }) => ({
      stage_key: stageKey,
      field_key: f.key,
      ...(f.valueKind
        ? { value_text: f.valueKind === "choice" ? f.choices![0] : "003i" }
        : { value: f.decimals === 3 ? "0.047" : f.decimals === 2 ? "0.27" : f.decimals === 1 ? "1.3" : "7" }),
      observation_source: f.expectedSource,
    }));
}

describe("partial publication of dectro-apilus:senior-3g v3 (Privacy F5)", () => {
  it("an unpublished mode is unavailable and nothing else is: the published mode works, the other fails closed and leaves no row, and publishing it later fixes only it", async () => {
    expect(activeModes(senior).length, "the premise: several active modes").toBeGreaterThan(2);
    const studio = await seedStudio("f5-partial");
    const visit = await seedSession(studio);
    await asRole("service_role", async (q) => {
      const publish = (mode: string) => {
        const c = row(mode);
        return q("select public.sync_machine_profile_contract($1,$2,$3,$4,$5,$6::jsonb)", [c.p_machine_profile_id, c.p_machine_profile_version, c.p_mode_key, c.p_channels_max, c.p_requires_installed_option, JSON.stringify(c.p_fields)]);
      };
      // Start from NOTHING published for this profile version, whatever an earlier run on this stack left (published rows are immutable, so the
      // reset bypasses the trigger for this ONE rolled-back transaction only). Then ONLY flash is published.
      await q("reset role");
      await q("set local session_replication_role = replica");
      await q("delete from public.machine_profile_field_contract where machine_profile_id=$1 and machine_profile_version=$2", [senior.profileId, senior.version]);
      await q("delete from public.machine_profile_mode_contract where machine_profile_id=$1 and machine_profile_version=$2", [senior.profileId, senior.version]);
      await q("set local session_replication_role = origin");
      await q("set local role service_role");
      await publish("flash");
      const published = async () => (await q("select mode_key from public.machine_profile_mode_contract where machine_profile_id=$1 and machine_profile_version=$2 order by mode_key", [senior.profileId, senior.version])).rows.map((r) => r.mode_key as string);
      expect(await published()).toEqual(["flash"]);

      await q("reset role"); await q("set local role authenticated");
      await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: studio.userId, role: "authenticated" })]);
      const device = (await q("select public.register_studio_machine($1,$2,$3,'F5 partial unit','{}') as id", [studio.studioId, senior.profileId, senior.version])).rows[0].id;

      // 1. The published mode records.
      const flash = readingsFor("flash");
      expect(Number((await q(RECORD_GROUP_SQL, [visit.blockId, device, "flash", "main", [], JSON.stringify(flash), visit.sessionId, studio.clientId])).rows[0].n)).toBe(flash.length);

      // 2. The unpublished mode is refused by the DATABASE, fails closed, and leaves no row.
      await q("savepoint blend_try");
      const blend = readingsFor("blend");
      const refusal = await q(RECORD_GROUP_SQL, [visit.blockId, device, "blend", "main", [], JSON.stringify(blend), visit.sessionId, studio.clientId]).then(() => null, (e: Error) => e);
      await q("rollback to savepoint blend_try");
      expect(refusal, "an unpublished mode must be refused").not.toBeNull();
      console.log(`[F5] unpublished-mode refusal from the database: ${refusal!.message}`);
            const stored = async (mode: string) => Number((await q("select count(*)::int as n from public.treatment_setup_readings where session_block_id=$1 and mode_key=$2", [visit.blockId, mode])).rows[0].n);
      expect(await stored("blend"), "the refused mode left no reading").toBe(0);
      expect(await stored("flash"), "the published mode is untouched by the refusal").toBe(flash.length);

      // 3. The history and the next-visit read still serve the published mode.
      const history = (await q("select public.setup_capture_history_for_block($1) as data", [visit.blockId])).rows[0].data;
      expect(history, "one capture so far (history is per capture, not per reading)").toHaveLength(1);
      expect(history[0].mode_key).toBe("flash");

      // 4. The OWNER LIST (app rule) does not offer the model while a mode is missing, and does once all active modes are published.
      const modesOf = async () => ({ [`${senior.profileId}@${senior.version}`]: await published() });
      const listed = async () => {
        const map = await modesOf();
        return listableProfiles([senior], (p) => map[`${p.profileId}@${p.version}`] ?? null).map((p) => p.profileId);
      };
      expect(await listed(), "partly published: not offered to an owner").toEqual([]);

      // 5. Publishing the missing mode makes THAT mode work and leaves the first exactly as it was.
      // (publication is service_role only: step out of the owner's role for it, then back in)
      await q("reset role"); await q("set local role service_role");
      await publish("blend");
      await q("reset role"); await q("set local role authenticated");
      await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: studio.userId, role: "authenticated" })]);
      expect(await published()).toEqual(["blend", "flash"]);
      expect(Number((await q(RECORD_GROUP_SQL, [visit.blockId, device, "blend", "main", [], JSON.stringify(blend), visit.sessionId, studio.clientId])).rows[0].n)).toBe(blend.length);
      expect(await stored("flash"), "flash unchanged by publishing blend").toBe(flash.length);
      expect(await stored("blend")).toBe(blend.length);
      const after = (await q("select public.setup_capture_history_for_block($1) as data", [visit.blockId])).rows[0].data;
      expect(after.map((h: { mode_key: string }) => h.mode_key).sort()).toEqual(["blend", "flash"]);
      // (the model is listed only when EVERY active mode is published: not yet, two of seven)
      expect(await listed()).toEqual([]);
    });
  });
});
