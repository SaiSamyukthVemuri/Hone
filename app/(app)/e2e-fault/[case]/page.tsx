import { notFound, redirect } from "next/navigation";
import {
  asRouteFaultCase,
  assertRouteFaultNotRequestedInDeployment,
  E2E_ROUTE_FAULT_CANARY,
  isE2eRouteFaultEnabled,
  shouldFailOnceForToken,
} from "@/lib/reliability/e2e-route-fault";
import { ClientFault } from "./ClientFault";

// GUARDED failure-injection route: E2E ONLY. See lib/reliability/e2e-route-fault.ts.
//
// In every deployed build the activation guard is fail-closed (it requires the
// server-only HONE_E2E_ROUTE_FAULT marker AND rejects every deployed runtime),
// so this page calls notFound() and the URL is a plain 404. There is no
// production-accessible crash route. It is additionally behind the normal auth
// gates: middleware bounces anonymous visitors to /login before this file runs,
// and app/(app)/layout.tsx re-checks the practitioner/studio membership.
//
// The case lives in a DYNAMIC segment because it is chosen per invocation: the
// harness addresses a failure mode, never a fixed destination. That also keeps
// it out of the Global Search navigation census in
// tests/lib/search/navigation-registry.test.ts, whose tripwire is scoped to
// STATIC authenticated destinations that could carry a registry href. This
// route can never carry one, and it must never be advertised anywhere.

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Fault injection",
  robots: { index: false, follow: false },
};

export default async function E2eFaultPage({
  params,
  searchParams,
}: {
  params: Promise<{ case: string }>;
  searchParams: Promise<{ token?: string }>;
}) {
  // Fail LOUD if the marker was requested in a deployed runtime, rather than
  // silently 404ing and hiding the misconfiguration.
  assertRouteFaultNotRequestedInDeployment(process.env);

  if (!isE2eRouteFaultEnabled(process.env)) notFound();

  const { case: rawCase } = await params;
  const faultCase = asRouteFaultCase(rawCase);
  if (!faultCase) notFound();

  if (faultCase === "not-found") notFound();
  if (faultCase === "redirect") redirect("/dashboard");

  const faultMessage = `Failed to load fault fixture: ${E2E_ROUTE_FAULT_CANARY}`;

  if (faultCase === "server-throw") {
    throw new Error(faultMessage);
  }

  if (faultCase === "once") {
    const { token } = await searchParams;
    if (!token) notFound();
    if (shouldFailOnceForToken(token)) {
      throw new Error(faultMessage);
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Fault fixture</h1>
      <p className="mt-3 text-sm text-neutral-600 dark:text-neutral-400">
        This route rendered normally.
      </p>
      <p className="mt-2 text-sm" data-testid="fault-fixture-ok">
        fault-fixture-rendered
      </p>
      {faultCase === "client-throw" && <ClientFault message={faultMessage} />}
    </div>
  );
}
