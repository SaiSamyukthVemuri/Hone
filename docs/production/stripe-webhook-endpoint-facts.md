# Stripe webhook endpoint: non-secret facts

Recorded from the operator's read-only Dashboard check on 2026-11-17 (nothing was changed). The endpoint URL host is deliberately not recorded here.
These are dashboard settings; they can change without a code change, so re-read them before relying on them.

| Fact | Value (read 2026-11-17) |
|---|---|
| Endpoint path | `/api/stripe/webhook` |
| Status | Active |
| Events from | Connected accounts |
| Endpoint API version | `2026-06-24.dahlia` (newer than the SDK pin `2026-04-22.dahlia` in `lib/stripe/server.ts`) |
| `charge.refunded` | subscribed |
| `refund.created`, `refund.updated`, `refund.failed` | **not** subscribed |
| Full subscription list | account.updated, capability.updated, charge.dispute.created, charge.refunded, payment_intent.payment_failed, payment_intent.succeeded, setup_intent.setup_failed, setup_intent.succeeded |

## What follows from it (rule from source; nothing was counted on hosted)
- A signed `charge.refunded` without an embedded refund list is the ONLY refund signal this destination delivers. A Charge no longer carries its refund list by default, and `expand` never applies to a webhook payload.
- The `refund.*` handler is never reached for this destination. No reasoning may treat it as a fallback. It stays safe if the subscription ever changes (covered by a route test).

## Limit that remains after the read ships
A pending refund that later fails or succeeds is only learned when another `charge.refunded` arrives; there are no `refund.*` events. Whether to subscribe them or add a read-only sweep is a product decision, not built here.
