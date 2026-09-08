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
 * consumed, and a definitive provider refusal is a different fact entirely.
 *
 * A LITERAL UNION, NOT A HAND-KEPT SET. The previous version listed these
 * strings here while the transport wrote the SAME strings again at each return
 * site, with nothing binding the two. Adding a local refusal there without
 * updating here would have been silent, and the consequence was not cosmetic:
 * `classifyDelivery` would read a zero-provider-call result as a definitive
 * provider rejection, terminate a proof challenge and authorize invalidating
 * it. The union plus `localRefusal` below closes that — a code the union does
 * not contain cannot be constructed.
 */
export const LOCAL_REFUSAL_CODES = [
  "not_configured",
  "invalid_recipient",
  "missing_tenant_scope",
  "missing_event_scope",
] as const;

export type LocalRefusalCode = (typeof LOCAL_REFUSAL_CODES)[number];

/** The refusal shape, matching the transport's outcome type structurally. */
export type LocalRefusal = { status: "rejected"; code: LocalRefusalCode };

/**
 * The ONLY way the transport may refuse locally.
 *
 * Going through a constructor is what makes the taxonomy binding rather than
 * advisory: `localRefusal("something_new")` does not compile until the union
 * gains that member, so a new pre-send refusal cannot reach a consumer
 * disguised as a provider rejection. A source guard additionally forbids the
 * bare object literal at those return sites, so the constructor cannot simply
 * be bypassed.
 */
export function localRefusal(code: LocalRefusalCode): LocalRefusal {
  return { status: "rejected", code };
}

/** Whether a refusal code came from this module's taxonomy. */
export function isLocalRefusalCode(
  code: string | null | undefined,
): code is LocalRefusalCode {
  return (
    typeof code === "string" &&
    (LOCAL_REFUSAL_CODES as readonly string[]).includes(code)
  );
}
