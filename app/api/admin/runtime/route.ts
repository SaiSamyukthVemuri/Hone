import "server-only";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/admin";

// HON-57: platform-operator runtime probe (CVE-2026-111497 verification).
//
// Returns the Node version of the function instance that served the request,
// so an operator can read it on production. Version metadata only; it reads
// no table and holds no service-role client. See docs/ops/runtime-probe.md for
// the procedure and for what one reading does and does not prove.
//
// The gate is the same ADMIN_EMAILS allowlist the /admin surface uses
// (lib/admin.ts isAdmin, fail-closed in production when the variable is unset
// or empty). Every refusal is the same 404 with an empty body: anonymous (if
// the middleware ever lets one through), a non-admin, a missing email, an auth
// error returned by getUser, and anything thrown while resolving the user. A
// refusal never carries version metadata or exception text.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
  "CDN-Cache-Control": "no-store",
  "Vercel-CDN-Cache-Control": "no-store",
} as const;

function refuse(): NextResponse {
  return new NextResponse(null, { status: 404, headers: NO_STORE_HEADERS });
}

async function callerIsPlatformAdmin(): Promise<boolean> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.getUser();
    if (error) return false;
    return isAdmin(data.user?.email);
  } catch {
    return false;
  }
}

export async function GET(): Promise<NextResponse> {
  if (!(await callerIsPlatformAdmin())) return refuse();

  return NextResponse.json(
    {
      node: process.version,
      brotli: process.versions.brotli ?? null,
      env: process.env.VERCEL_ENV ?? null,
      deploymentId: process.env.VERCEL_DEPLOYMENT_ID ?? null,
      region: process.env.VERCEL_REGION ?? null,
      commitSha: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      observedAt: new Date().toISOString(),
    },
    { status: 200, headers: NO_STORE_HEADERS },
  );
}
