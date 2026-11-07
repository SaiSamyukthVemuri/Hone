import { isLoopbackUrl } from "../../../lib/net/loopback";

/**
 * Pure core of the census's trigger-disabling guard. No I/O and no import of e2e/helpers/local-env, so a
 * unit test can run it with E2E_SUPABASE_URL unset, which is exactly how CI's db-integration job runs
 * (it starts the DEFAULT stack and exports no E2E_SUPABASE_URL; Codex P1 #4500640473).
 *
 * This is a LOOPBACK-ONLY check. It does not prove the stack is the owned one; that protection is
 * vitest.db.config.ts' paired-target guard (#879, E2E_SUPABASE_URL + HONE_LOCAL_DB_URL).
 */

/** The API URL in force: the explicit variable when set, else the validated default local-env resolved. */
export function apiUrlInForce(env: Record<string, string | undefined>, validatedDefault: string): string {
  return env.E2E_SUPABASE_URL || validatedDefault;
}

export function assertLoopbackPair(dbUrl: string, apiUrl: string): void {
  if (!dbUrl || !apiUrl || !isLoopbackUrl(dbUrl) || !isLoopbackUrl(apiUrl)) {
    throw new Error(
      "trigger-disabling probe refused: the DB and API URLs must both be loopback (the owned pair is enforced by vitest.db.config.ts)",
    );
  }
}
