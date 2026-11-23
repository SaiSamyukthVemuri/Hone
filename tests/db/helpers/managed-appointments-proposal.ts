import { readFileSync } from "node:fs";
import { adminQuery } from "./harness";

// Applies the studio-managed proposal as COMMITTED state for a suite that needs
// real connections, and puts the catalog back. The teardown runs only when THIS
// handle applied the proposal: a database that already carried it is refused and
// left exactly as found.
export const proposalSql = readFileSync(new URL("../../../docs/proposals/studio-managed-appointments/UP.sql", import.meta.url), "utf8");
export const patchedNames = [
  "create_public_appointment", "create_public_appointment_v2", "create_public_appointment_for_new_client",
  "create_public_appointment_for_new_client_v2", "create_waitlist_public_appointment",
  "redeem_and_book_waitlist_invitation", "public_cancel_appointment_with_token", "reschedule_appointment_v3",
];
export const patchedWhere = `n.nspname='public' and p.proname=any($1) and (p.proname<>'public_cancel_appointment_with_token' or p.pronargs=7)`;
const columnSql = `select 1 from information_schema.columns where table_schema='public' and table_name='studios' and column_name='studio_managed_appointments'`;

export async function catalogSnapshot() {
  return (await adminQuery(
    `select p.oid, p.proowner, p.proconfig, p.proacl::text, pg_get_functiondef(p.oid) as definition
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace where ${patchedWhere} order by p.oid`, [patchedNames])).rows;
}
export const proposalPresent = async () => (await adminQuery(columnSql)).rows.length > 0;

export type ProposalHandle = {
  /** True only after THIS handle's apply succeeded. */
  readonly applied: boolean;
  apply(): Promise<void>;
  /** No-op unless this handle applied the proposal; otherwise restores and asserts the catalog is as it was. */
  teardown(): Promise<void>;
};

export function proposalHandle(): ProposalHandle {
  let applied = false;
  let before: { oid: number; definition: string }[] = [];
  return {
    get applied() { return applied; },
    async apply() {
      if (await proposalPresent()) throw new Error("the proposal is already applied on this database; refusing to run");
      before = (await catalogSnapshot()) as typeof before;
      await adminQuery(proposalSql); // one transaction: all or nothing
      applied = true;
    },
    async teardown() {
      if (!applied) return;
      applied = false;
      // create or replace keeps identity and ACLs; the saved text is the pre-proposal definition.
      for (const o of before) await adminQuery(o.definition);
      await adminQuery(`drop function public.set_studio_managed_appointments(uuid, boolean)`);
      await adminQuery(`drop function public.assert_client_self_service_open(uuid)`);
      await adminQuery(`alter table public.studios drop column studio_managed_appointments`);
      const after = await catalogSnapshot();
      if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error("the catalog differs from its pre-proposal state after teardown");
    },
  };
}
