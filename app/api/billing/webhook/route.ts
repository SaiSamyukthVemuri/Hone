// Hone software-subscription webhook (HON-70, Hone Care Inc US account).
//
// SEPARATE from app/api/stripe/webhook (Hone Canada Connect treatment
// payments): different Stripe account, different signing secret
// (HONE_BILLING_WEBHOOK_SECRET), different code. Never share them.
//
// Milestone 1 ships the decision logic (lib/subscriptions/webhook.ts) but no
// persistence: the entitlement and processed-event tables need a migration
// that is not yet approved. Until a store exists this route cannot grant
// anything, so it fails closed:
//   * flag off (default)  -> 404, as if the endpoint did not exist;
//   * flag on, no store   -> 503, before the body is read.
//
// Only POST is exported, so an anonymous GET gets Next's 405, not a 404 and not
// the /login redirect other unauthenticated API paths get: the route's existence
// is fingerprintable (same as the Stripe webhook; low impact). The path is a
// public middleware entry (exact match). Once a store exists this route MUST
// verify the signature before reading or acting on anything (activation
// condition G-2, docs/billing/HON-70-ACTIVATION-CONDITIONS.md).

import { NextResponse } from "next/server";
import { isSelfServeCheckoutEnabled } from "@/lib/subscriptions/plans";

export const dynamic = "force-dynamic";

export async function POST(): Promise<NextResponse> {
  if (!isSelfServeCheckoutEnabled(process.env)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json(
    { error: "Subscription billing is not available yet." },
    { status: 503 },
  );
}
