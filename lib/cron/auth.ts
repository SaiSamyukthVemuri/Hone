import { timingSafeEqual } from "crypto";

// Constant-time authorization check for the /api/cron/* endpoints.
//
// Compares the request's Authorization header against the expected
// `Bearer ${CRON_SECRET}` value using timingSafeEqual instead of a plain
// `!==`, so the comparison time does not leak how many leading characters
// of the secret were guessed. Behavior is otherwise identical to the
// previous inline check:
//   * a valid bearer token is accepted,
//   * a missing Authorization header is rejected,
//   * an invalid bearer token is rejected.
//
// Also rejects (rather than guessing) when CRON_SECRET itself is unset, so
// a misconfigured environment can't be probed with "Bearer undefined". The
// secret is never logged or returned.
export function isAuthorizedCronRequest(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  const provided = req.headers.get("authorization");
  if (!provided) return false;

  const expected = `Bearer ${secret}`;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // Length check first: timingSafeEqual throws on unequal-length buffers.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
