import { adminQuery } from "./harness";

// Activation rule (0287): a key with no release row is inert (it resolves to the existing snapshot). Engine tests that exercise STORED or
// DEFAULT values on a key treat that key as released long ago. Idempotent; never touches an existing release row.
export async function releaseAllKeys(): Promise<void> {
  await adminQuery(
    "insert into public.permission_key_release (key, released_at, release_tag) select key, timestamptz '2000-01-01', 'TEST-LONG-AGO' from public.permission_catalog on conflict (key) do nothing",
  );
}
