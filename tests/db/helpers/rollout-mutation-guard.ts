import { adminQuery } from "./harness";

// Some DB suites switch the platform's front_desk rollout to 'pilot' and list studios in it, then put it
// back to 'off'. That is a write to a PLATFORM setting, so these suites must never run on a stack that is
// standing in for production: a rehearsal stack, an apply rehearsal base, or anything hosted-shaped.
//
// A suite calls this first in beforeAll. It refuses when:
//   * HONE_REHEARSAL_STACK is set (the owner of a rehearsal stack declares it in the run environment), or
//   * the stack is not pristine for this setting: front_desk is not 'off' or a studio is already listed.
//     (A restore to 'off' would silently erase an operator's or a rehearsal's own configuration.)
// The harness already refuses any non-local database; this refuses a LOCAL stack that is not disposable.
export async function assertMayMutateFrontDeskRollout(): Promise<void> {
  if (process.env.HONE_REHEARSAL_STACK) {
    throw new Error("refusing to flip the front_desk rollout: HONE_REHEARSAL_STACK is set (a rehearsal stack is not disposable)");
  }
  const r = await adminQuery(
    `select (select mode from public.platform_rollouts where key='front_desk') as mode,
            (select count(*)::int from public.platform_rollout_studios where rollout_key='front_desk') as listed`,
  );
  const { mode, listed } = r.rows[0] as { mode: string | null; listed: number };
  if (mode !== "off" || listed !== 0) {
    throw new Error(`refusing to flip the front_desk rollout: the stack is not pristine (mode=${mode}, listed=${listed})`);
  }
}
