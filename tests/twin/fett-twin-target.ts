// LOCAL-ONLY synthetic Fett twin: the TARGET GUARD. Every twin seed/cleanup run starts here.
//
// The twin runs on ONE owned, isolated local stack. This refuses anything else: a hosted database, a
// non-loopback host, and the SHARED fleet stack (Hone-0162 on 54321/54322) in particular. Credentials are
// not committed: scripts/fett-twin/reset.sh reads the service-role key from `supabase status -o env` for
// the guarded workdir and passes it in, which is the repository's existing local-stack credential path.
const SHARED_PORTS = new Set(["54321", "54322", "54323", "54324"]);

export type TwinTarget = { dbUrl: string; apiUrl: string; serviceKey: string };

export function assertTwinTarget(): TwinTarget {
  const dbUrl = process.env.HONE_LOCAL_DB_URL ?? "";
  const apiUrl = process.env.FETT_TWIN_API_URL ?? "";
  const serviceKey = process.env.FETT_TWIN_SERVICE_ROLE_KEY ?? "";
  const db = /^postgresql:\/\/postgres:postgres@127\.0\.0\.1:(\d+)\/postgres$/.exec(dbUrl);
  const api = /^http:\/\/127\.0\.0\.1:(\d+)$/.exec(apiUrl);
  if (!db) throw new Error(`fett-twin refusing: HONE_LOCAL_DB_URL must be a loopback local stack, got ${dbUrl || "<unset>"}`);
  if (!api) throw new Error(`fett-twin refusing: FETT_TWIN_API_URL must be http://127.0.0.1:<port>, got ${apiUrl || "<unset>"}`);
  if (SHARED_PORTS.has(db[1]!) || SHARED_PORTS.has(api[1]!)) {
    throw new Error("fett-twin refusing: that is the SHARED fleet stack (Hone-0162). Use an owned isolated stack.");
  }
  if (!serviceKey) throw new Error("fett-twin refusing: FETT_TWIN_SERVICE_ROLE_KEY unset (run through scripts/fett-twin/reset.sh)");
  return { dbUrl, apiUrl, serviceKey };
}
