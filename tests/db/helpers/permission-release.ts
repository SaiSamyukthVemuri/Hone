import { adminQuery } from "./harness";

// Activation rule (0287): a key with no release row is inert (it resolves to the existing snapshot). Engine tests that exercise STORED or
// DEFAULT values on a key treat that key as released (FULL) long ago. Idempotent. The release rows are seeded PENDING (released_at null), so a
// pending row is released here too; a row already released keeps its time, tag and kind. The PRODUCTION configuration is tested separately
// (tests/db/permission-production-config.db.test.ts) and must not call this.
export async function releaseAllKeys(): Promise<void> {
  await adminQuery(
    "insert into public.permission_key_release (key, released_at, release_tag) select key, timestamptz '2000-01-01', 'TEST-LONG-AGO' from public.permission_catalog on conflict (key) do update set released_at = excluded.released_at where public.permission_key_release.released_at is null",
  );
  // The engine suites exercise the FULL release semantics (a stored widening takes effect). The six deny_only keys are seeded 'narrow'; make them full
  // here. The narrow semantics are proved in permission-production-config.db.test.ts, which uses the seeded kinds.
  await adminQuery("update public.permission_key_release set release_kind = 'full' where release_kind = 'narrow' and released_at < timestamptz '2001-01-01'");
}
