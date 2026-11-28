import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { isSelfServeCheckoutEnabled } from "@/lib/subscriptions/plans";
import { selectedPlanFromQuery } from "@/lib/subscriptions/plan-selection";
import { createClient } from "@/lib/supabase/server";
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
  searchParams: Promise<{ plan?: string | string[]; returning?: string }>;
}) {
  if (!isSelfServeCheckoutEnabled(process.env)) notFound();
  const query = await searchParams;
  const plan = selectedPlanFromQuery(query.plan);
  const returning = query.returning === "1";
  if (!plan && !returning) redirect("/pricing");
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (user) redirect(returning ? "/dashboard" : "/no-access?plan=" + plan);
  return <SignupForm plan={returning ? null : plan} />;
}
