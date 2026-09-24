import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  return await updateSession(request);
}

// TWO EXACT PATHS are excluded, never a `fonts/` prefix.
//
// The exclusion exists because OFL 1.1 clause 2 requires the licence to
// accompany the copies of the font a browser receives, and `next/font/local`
// emits only the .woff2 files. The notices are served from public/fonts, and
// without an exclusion `updateSession` answered them 307 -> /login, so they
// were not reachable in the deployed app at all.
//
// It is scoped to the two exact filenames because a `fonts/` PREFIX exemption
// is an auth hole, not merely untidy. Next route groups do not appear in the
// URL, so `app/(app)/fonts/private/page.tsx` serves `/fonts/private` - a real
// authenticated route, matched by the prefix, silently never running
// updateSession. No file named `app/fonts/...` would exist to notice, so a
// guard watching that directory stays green while the route is anonymous.
//
// The .woff2 assets need nothing here: Next emits them under
// /_next/static/media, already covered by the `_next/static` exclusion.
//
// The trailing `$` on each alternative is load-bearing - it is what makes this
// an exact-path exclusion rather than a prefix one, so `/fonts/private` and
// `/fonts/LICENSE-Inter.txt/extra` both still run the middleware.
// tests/source-guards/self-hosted-fonts-guards.test.ts parses this matcher and
// pins both directions. See FONTS.md.
// MKT-02C added `mp4` to the static-extension alternation. The product film on
// /features/treatment-memory is served from public/, and every extension NOT in
// this list runs updateSession: an anonymous visitor requesting the film got
// 307 -> /login, so the video on a PUBLIC marketing page would not play for the
// exact audience it exists for. Identical in shape to the font-licence defect
// above, and fixed in the same place rather than by allowlisting an asset in
// `isPublicRoute`, which enumerates public ROUTES, not files.
//
// Extension-scoped rather than path-scoped, and that is safe here for the
// reason the `fonts/` prefix was not: this alternative requires a literal dot
// and a trailing `$`, and no Next route resolves to a URL ending in `.mp4` -
// unlike `/fonts/private`, which a grouped route really does serve.
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|fonts/LICENSE-Inter\\.txt$|fonts/LICENSE-Fraunces\\.txt$|.*\\.(?:svg|png|jpg|jpeg|gif|webp|mp4)$).*)",
  ],
};
