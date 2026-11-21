import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isSelfServeCheckoutEnabled } from "@/lib/subscriptions/plans";
import { selectedPlanFromQuery } from "@/lib/subscriptions/plan-selection";
import { PLANS } from "@/lib/subscriptions/plans";
import { SignupForm } from "./SignupForm";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Create your account",
  robots: { index: false, follow: false },
};

// HON-70 account step (PROPOSED, flag-gated). With the flag off this route is
// a 404 and nothing links to it.
export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string | string[] }>;
}) {
  if (!isSelfServeCheckoutEnabled(process.env)) notFound();
  const plan = selectedPlanFromQuery((await searchParams).plan);
  return (
    <SignupForm
      planSummary={plan ? `${PLANS[plan].label}: US$${PLANS[plan].unitAmount / 100}/month` : null}
    />
  );
}
