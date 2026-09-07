# WAIT invitation route — the privacy change that must ship with it

**Status: PREPARED, NOT APPLIED.** The bearer route does not exist yet, so no
prefix is registered. This file is the exact change to make in the *same commit*
that creates the route, and `tests/security/waitlist-invitation-route-privacy.test.ts`
is the gate that makes forgetting it fail.

## Why the route needs it

The WAIT invitation URL carries a replayable bearer credential in a **dynamic
path segment**: possession of the URL is possession of the ability to resolve
the invitation. That is the F-PRIV-001 class `lib/security/token-routes.ts` was
written for. The path itself is secret material — a different problem from a
query string, and one `sendDefaultPii: false` does not touch, because the URL is
not PII, it is a credential.

A route needs **both** protections. One alone still leaks:

| Protection | Consumer | Leak it closes |
|---|---|---|
| `Referrer-Policy: no-referrer` + `X-Robots-Tag` | `next.config.ts`, via `TOKEN_ROUTE_PATTERNS` | The credential handed to a third party in a `Referer` header, or indexed by a crawler |
| Credential canonicalization | `lib/observability/sentry-scrub.ts`, via `canonicalizeTokenPaths` | The credential shipped to an observability vendor inside an error string |

Both read the **same registry**, and `tests/lib/security/token-route-parity.test.ts`
fails if they drift apart.

## The change

One line, in `lib/security/token-routes.ts`:

```ts
export const TOKEN_ROUTE_PREFIXES = [
  "/portal/verify",
  "/cancel",
  "/reschedule",
  "/manage",
  "/intake",
  "/calendar-feed",
  "/waitlist/invitation",   // <- the real route path, whatever it turns out to be
] as const;
```

Nothing else. `TOKEN_ROUTE_PATTERNS` derives from it, `next.config.ts` maps over
that, and the Sentry scrubber builds its regex from the same array. The
`:token*` catch-all already covers suffix segments, so
`/waitlist/invitation/<raw>/confirm` is protected by the same entry.

Then update the vacuity pin in
`tests/security/waitlist-invitation-route-privacy.test.ts` — the test that
records "zero bearer routes found today" — to the new count, in the same commit.

## Why no prefix is registered now

A prefix for a route nobody has written protects nothing, and it puts a decoy in
a registry whose whole worth is that every entry is real. The guard test
enforces this in **both** directions, and both directions were verified by
negative control rather than assumed:

- **FORWARD** — a waitlist/invitation route with a dynamic segment that is not
  in the registry fails the build. Verified by creating
  `app/waitlist/invitation/[token]/page.tsx` and watching it go red with the
  offending path named.
- **REVERSE** — a waitlist/invitation prefix in the registry while no such route
  exists also fails. Verified by adding `/waitlist/invitation` to the registry
  with no route and watching it go red.

The forward assertion is keyed on the route's **existence on disk**, not on a
path chosen in advance, because we do not yet know whether it will be
`/waitlist/invitation`, `/waitlist/invite` or something else — and a test that
hard-codes the guess fails to fire exactly when the guess is wrong.

## The proof code is not a route concern

The recipient proof is delivered as a **code, not a link** (see
`lib/email/templates/waitlist-recipient-proof.ts`), so it adds no second
credential-bearing route and needs no registry entry. That was one of the
reasons for choosing a code: a proof URL would have been a second surface to
defend here, on top of landing in the wrong browser session when opened from a
phone.

## Related

- `lib/security/token-routes.ts` — the registry and its two consumers
- `tests/lib/security/token-route-parity.test.ts` — registry ↔ consumers
- `tests/security/waitlist-invitation-route-privacy.test.ts` — route ↔ registry
- `lib/waitlist/delivery/log-safety.ts` — why nothing derived from either secret
  is logged, not even a hash or a prefix
