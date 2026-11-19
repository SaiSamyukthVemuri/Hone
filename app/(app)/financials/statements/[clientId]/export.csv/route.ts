import { NextResponse, type NextRequest } from "next/server";

import { loadOwnerClientStatement } from "@/lib/finance/owner-client-statement";
import { statementCsv, statementCsvFileName } from "@/lib/finance/statement-csv";
import { IdentityRefusalError } from "@/lib/supabase/identity-refusal";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";

// ===========================================================================
// One client's statement as a CSV download. Owner-only, READ-ONLY: it never charges, messages or writes anything.
// ===========================================================================
// The session middleware already refuses an anonymous or inactive caller; the owner gate below is the first thing this handler decides, through
// the same loader the screen uses (so the file can never describe a different client or selection than the screen). Every refusal of a specific
// client is the same 404 ("another studio's client" and "no such client" are indistinguishable). A month or view that is present but invalid is a
// 400, never silently today's month. NEVER cached, no CORS. The file name is the month (or "full-history") only: no client name, no id.
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_STORE = { "Cache-Control": "no-store, private" } as const;
const refuse = (status: number, error: string) => NextResponse.json({ error }, { status, headers: NO_STORE });

export async function GET(request: NextRequest, { params }: { params: Promise<{ clientId: string }> }) {
  let who: Awaited<ReturnType<typeof getCurrentPractitionerWithStudio>>;
  try {
    who = await getCurrentPractitionerWithStudio();
  } catch (error) {
    // A caller who is refused (signed out, no active studio, or a studio to choose) is a 403. A FAILED READ (a database outage) is not a refusal and
    // must not read as one: it is a 503, so the owner retries rather than concluding they have no access.
    const redirected = typeof (error as { digest?: unknown })?.digest === "string" && String((error as { digest: string }).digest).startsWith("NEXT_REDIRECT");
    return error instanceof IdentityRefusalError || redirected ? refuse(403, "forbidden") : refuse(503, "unavailable");
  }
  const { practitioner, studio } = who;
  if (practitioner.role !== "owner") return refuse(403, "forbidden");

  const { clientId } = await params;
  if (!UUID.test(clientId)) return refuse(404, "not_found");

  const q = request.nextUrl.searchParams;
  const result = await loadOwnerClientStatement({
    practitioner,
    studio,
    clientId,
    monthParam: q.getAll("month").length > 1 ? "invalid" : (q.get("month") ?? undefined),
    viewParam: q.getAll("view").length > 1 ? "invalid" : (q.get("view") ?? undefined),
    strict: true,
    now: new Date(),
  });
  if (!result.ok) {
    if (result.refusal === "not_owner") return refuse(403, "forbidden");
    if (result.refusal === "bad_request") return refuse(400, "bad_request");
    if (result.refusal === "not_found") return refuse(404, "not_found");
    return refuse(503, "unavailable");
  }

  let body: string;
  try {
    body = statementCsv(result.document, result.offDocumentWithMoney);
  } catch {
    return refuse(503, "unavailable"); // a file that cannot be built is not produced, and is not an unexplained 500
  }

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${statementCsvFileName(result.document.scope)}"`,
      ...NO_STORE,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
