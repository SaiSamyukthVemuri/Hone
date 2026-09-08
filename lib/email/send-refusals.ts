// The refusal taxonomy for the waitlist email transport.
//
// A SEPARATE MODULE BECAUSE OF WHAT IMPORTING IT MUST NOT COST. These codes are
// produced by lib/email/new-client-waitlist-send.ts and consumed by
// lib/waitlist/delivery/policy.ts, and the obvious shortcut — have the policy
// import them from the transport — turned out to be expensive in a way nothing
// in the type system showed:
//
//   lib/rate-limit/public.ts
//     -> lib/waitlist/delivery/policy.ts        (for PROOF_REQUEST_LIMITS)
//       -> lib/email/new-client-waitlist-send.ts
//         -> lib/email/client.ts
//
// and `client.ts` does real work at module scope: it runs the fake-transport
// deployment assertion, constructs the Resend client when configured, and warns
// when it is not. So merely LOADING a rate-limited action — public booking,
// portal login, intake, consent, portal links — evaluated email initialization,
// for routes that send no email at all. It also broke the "pure, no I/O, no
// env" contract policy.ts states about itself in its own header.
//
// Keeping the taxonomy here fixes that without reintroducing the defect the
// shared list exists to prevent: a second copy of these strings would drift the
// first time a code was added, and silently.
//
// PURE BY CONTRACT: no imports, no I/O, no env reads, no `server-only`. Adding
// any of those re-creates the coupling, which is why
// tests/lib/waitlist/delivery-send.test.ts asserts this file's import list is
// empty and that policy.ts reaches neither the transport nor the client.

/**
 * Refusals the transport produces ITSELF, before any request is made.
 *
 * They share the `rejected` shape with a provider refusal — the outcome type
 * has no room to distinguish them — and a consumer reading that shape
 * generically will treat "we never called anyone" as "the provider said no".
 * Those deserve opposite handling: nothing was transmitted, nothing was
 * consumed, and correcting the local condition makes the very same send work.
 */
export const LOCAL_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "not_configured",
  "invalid_recipient",
  "missing_tenant_scope",
  "missing_event_scope",
]);
