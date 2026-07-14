import { type NextRequest, NextResponse } from "next/server";
import { getRequiredAppOrigin } from "@/lib/app-origin";
import { OAUTH_CALLBACK_PATH } from "@/lib/google-calendar/config";
import { assertE2eFakeGoogleAllowed } from "@/lib/google-calendar/e2e/fake-google-guard";
import { recordFakeAuthorizeRequest } from "@/lib/google-calendar/e2e/fake-google-provider";

// GUARDED fake Google OAuth authorize endpoint — E2E ONLY.
//
// In production the fake-Google activation guard is fail-closed (rejects every
// deployed environment + requires the server-only HONE_E2E_* markers), so this
// route returns 404 and is NOT usable — no fake authorize is exposed in any
// deployed build. Only the guarded local E2E lane reaches the redirect below,
// standing in for accounts.google.com so the browser never leaves the local origin.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    assertE2eFakeGoogleAllowed(process.env);
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }

  const params = request.nextUrl.searchParams;
  const state = params.get("state");
  if (!state) return new NextResponse("Bad request", { status: 400 });

  // Record the ACTIVE request's requested scope so a test can assert it asked for
  // ONLY the exact destination scope (never broad calendar.events).
  recordFakeAuthorizeRequest(params.get("scope"));

  // Redirect straight back to the REAL callback with a synthetic code (the fake
  // token exchange ignores the code value; the per-run scenario drives the actual
  // granted scopes + identity). Same-origin, so the httpOnly nonce + session
  // cookies are sent.
  const callback = new URL(OAUTH_CALLBACK_PATH, getRequiredAppOrigin());
  callback.searchParams.set("code", `fake-code-${state.slice(0, 12)}`);
  callback.searchParams.set("state", state);
  return NextResponse.redirect(callback);
}
