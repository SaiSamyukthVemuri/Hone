import { NextResponse, type NextRequest } from "next/server";

import { type PaymentCurrency } from "@/lib/billing/payment-jurisdiction";
import { getStudioPaymentJurisdiction } from "@/lib/billing/payment-jurisdiction-server";
import { localDateString } from "@/lib/booking/tz";
import { overviewCsv, overviewCsvFileName } from "@/lib/business-analytics/overview-csv";
import { loadOverview } from "@/lib/business-analytics/server/overview-read";
import { IdentityRefusalError } from "@/lib/supabase/identity-refusal";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";

// ===========================================================================
// The Analytics Overview as a CSV download. Owner-only, READ-ONLY: it never charges, messages or writes anything.
// ===========================================================================
// The owner gate is the first thing this handler decides, and the same loader the screen uses builds the data, so the file cannot describe a different
// period or team member than the screen. A value that is present but invalid is a 400, never silently today's period. NEVER cached, no CORS.
// The file name is the period's dates only; the request's query (which may hold a team member's id) is never logged, echoed or put in the name.
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, private" } as const;
const refuse = (status: number, error: string) => NextResponse.json({ error }, { status, headers: NO_STORE });

export async function GET(request: NextRequest) {
  let who: Awaited<ReturnType<typeof getCurrentPractitionerWithStudio>>;
  try {
    who = await getCurrentPractitionerWithStudio();
  } catch (error) {
    // Refused (signed out, no active studio, or a studio to choose) is a 403. A FAILED READ is not a refusal: it is a 503, so the owner retries.
    const redirected = typeof (error as { digest?: unknown })?.digest === "string" && String((error as { digest: string }).digest).startsWith("NEXT_REDIRECT");
    return error instanceof IdentityRefusalError || redirected ? refuse(403, "forbidden") : refuse(503, "unavailable");
  }
  const { practitioner, studio } = who;
  if (practitioner.role !== "owner") return refuse(403, "forbidden");

  const jurisdiction = await getStudioPaymentJurisdiction(studio.id);
  const currency: PaymentCurrency | null = jurisdiction.ok ? jurisdiction.jurisdiction.currency : null;

  const raw: Record<string, string | string[]> = {};
  for (const key of new Set(request.nextUrl.searchParams.keys())) {
    const all = request.nextUrl.searchParams.getAll(key);
    raw[key] = all.length === 1 ? all[0] : all;
  }
  const now = new Date();
  const read = await loadOverview(practitioner, studio, currency, raw, { strict: true }, now);
  if (read.access !== "granted") return refuse(403, "forbidden");
  if (!read.ok) return read.reason === "bad_request" ? refuse(400, "bad_request") : refuse(503, "unavailable");

  let body: string;
  try {
    body = overviewCsv(read.view, { preparedOn: localDateString(now, studio.timezone) });
  } catch {
    return refuse(503, "unavailable"); // a file that cannot be built is not produced, and is not an unexplained 500
  }
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${overviewCsvFileName(read.view.currentRange)}"`,
      ...NO_STORE,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
