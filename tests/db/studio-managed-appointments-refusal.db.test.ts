import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, closePool } from "./helpers/harness";
import { catalogSnapshot, proposalHandle, proposalPresent } from "./helpers/managed-appointments-proposal";

// CONTROL for the applied-state suite's refusal path. A database that already
// carries the proposal must be refused AND left exactly as found: the refused run
// must not drop the existing setter, guard or column, and must not rewrite the
// command definitions. Here an outer handle applies the proposal (standing in for
// a real setup), and a second handle, the suite's own, must refuse.
const outer = proposalHandle();
beforeAll(() => outer.apply());
afterAll(async () => {
  try { await outer.teardown(); } finally { await closePool(); }
});

const objects = async () => (await adminQuery(
  `select (select count(*)::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('set_studio_managed_appointments','assert_client_self_service_open')) as fns`)).rows[0];

describe("a database that already carries the proposal", () => {
  it("is refused, and the refused run's teardown leaves the existing setup untouched", async () => {
    expect(await proposalPresent()).toBe(true);
    const catalog = await catalogSnapshot();
    const fns = await objects();
    expect(fns.fns).toBe(2);

    const second = proposalHandle();
    await expect(second.apply()).rejects.toThrow(/already applied/);
    expect(second.applied).toBe(false);
    await second.teardown(); // must be a no-op

    expect(await proposalPresent()).toBe(true);
    expect(await objects()).toEqual(fns);
    expect(await catalogSnapshot()).toEqual(catalog);
  });
});
