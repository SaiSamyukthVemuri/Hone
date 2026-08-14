import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  return await updateSession(request);
}

// `fonts/` is excluded for the same reason as `_next/static`: it is a static
// asset directory under public/, not an authenticated resource. It holds the
// SIL OFL 1.1 notices for the self-hosted Inter and Fraunces binaries, which
// OFL clause 2 requires to accompany the copies a browser receives. Without
// this exclusion `updateSession` redirects /fonts/LICENSE-*.txt to /login with
// a 307, so the notices are not actually reachable in the deployed app - which
// is exactly what happened, and what tests/source-guards pins. See FONTS.md.
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|fonts/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
