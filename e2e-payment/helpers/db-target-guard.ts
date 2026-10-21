// Refuse to seed a payment browser run into a different database from the one
// the browser app is using.
//
// The payment fixtures seed through the tests/db harness (adminQuery), which
// reads HONE_LOCAL_DB_URL and FALLS BACK to the shared 54322 stack
// (Hone-0162). The browser app uses e2e/helpers/local-env.ts. A run pointed
// at an isolated stack by local-env alone therefore seeds the SHARED stack:
// that happened twice on 2026-10-12 (4 rows, then 53 partial studios), and
// each time the seeds failed half-way and their cleanup never ran.
//
// Pure, so it is unit-tested without a database. Host and port only: the
// credentials and database name are the same everywhere locally.

function hostPort(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || "5432"}`;
  } catch {
    return `unparseable(${url.length} chars)`;
  }
}

export function assertSeedTargetsE2eDatabase(harnessDbUrl: string, e2eDbUrl: string): void {
  const seed = hostPort(harnessDbUrl);
  const app = hostPort(e2eDbUrl);
  if (seed !== app) {
    throw new Error(
      `e2e-payment refuses to seed: the tests/db harness would write to ${seed} ` +
        `but the browser app's database is ${app}. Set HONE_LOCAL_DB_URL to the same ` +
        `stack as e2e/helpers/local-env.ts (both, or neither).`,
    );
  }
}
