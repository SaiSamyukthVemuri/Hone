/**
 * IS THIS URL ACTUALLY POINTED AT THIS MACHINE?
 *
 * ONE DEFINITION, SHARED. This lived in `e2e/helpers/local-env.ts`, where it
 * was written for #879's paired-stack guard. `lib/machines/synthetic-profile`
 * then needed the same question and asked it with
 * `/127\.0\.0\.1|localhost/.test(url)` — a SUBSTRING test, which
 * `https://localhost.example.com` and `https://localhost@db.example.com` both
 * satisfy while resolving somewhere else entirely (Codex, #860 4298457391).
 *
 * It lives in `lib/` rather than under `e2e/` because production code may not
 * import test helpers; the e2e module now re-exports this one, so there is
 * still exactly one implementation and the two cannot drift.
 *
 * THE HOST MUST BE LOOPBACK, NOT MERELY MENTION IT. The URL is parsed and its
 * hostname compared against the loopback set, so a hostname that merely
 * contains "localhost", or a userinfo section that ends in one, is refused.
 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * Query parameters that move where a client actually connects.
 *
 * A libpq URL can carry `?host=`, `?hostaddr=`, `?port=` or `?service=`, and
 * those WIN over the authority the hostname check just approved:
 * `postgresql://…@127.0.0.1:63322/postgres?host=prod-db.internal` passes a
 * hostname test and connects off-machine. Any such override is refused
 * outright rather than interpreted (Codex P1 on #879).
 */
const CONNECTION_OVERRIDES = new Set(["host", "hostaddr", "port", "service"]);

export function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    for (const key of url.searchParams.keys()) {
      if (CONNECTION_OVERRIDES.has(key.toLowerCase())) return false;
    }
    return LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    // An unparseable string is not a loopback URL. Returning false here is
    // what makes every caller fail CLOSED on a malformed value.
    return false;
  }
}
