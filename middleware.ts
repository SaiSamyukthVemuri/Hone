import { NextResponse, type NextRequest } from "next/server";
import {
  appendVaryAccept, isUnknownPublicPath, normalizePublicPathname,
  NOT_FOUND_HTML, preferredPublicRepresentation,
} from "@/lib/marketing/agent-http";
import { NOT_FOUND_MARKDOWN, PUBLIC_MARKDOWN } from "@/lib/marketing/agent-content";
import { updateSession } from "@/lib/supabase/middleware";

// Serve only the exact, non-sensitive company/agent files without requiring a
// practitioner login. Do NOT widen this to /portal, /api or any route family.
const PUBLIC_AGENT_ROUTES = new Set(["/about", "/contact", "/llms.txt"]);

export async function middleware(request: NextRequest) {
  const rawPathname = request.nextUrl.pathname;
  const isRead = request.method === "GET" || request.method === "HEAD";
  const accept = request.headers.get("Accept");

  // Do not send unknown anonymous public paths to /login (a soft-404).
  // Protected and token-bearing families still run their existing handlers.
  if (isRead && isUnknownPublicPath(rawPathname)) {
    const markdown = preferredPublicRepresentation(accept) === "markdown";
    return new NextResponse(
      request.method === "HEAD" ? null : markdown ? NOT_FOUND_MARKDOWN : NOT_FOUND_HTML,
      {
        status: 404,
        headers: {
          "Content-Type": markdown ? "text/markdown; charset=utf-8" : "text/html; charset=utf-8",
          "Vary": "Accept",
          "Cache-Control": "no-store",
          "X-Robots-Tag": "noindex, nofollow",
        },
      },
    );
  }

  // Only three explicitly public company pages participate in Markdown
  // negotiation; no patient, authenticated or token route can enter here.
  const pathname = normalizePublicPathname(rawPathname);
  const negotiated = isRead && Object.prototype.hasOwnProperty.call(PUBLIC_MARKDOWN, pathname);
  if (negotiated) {
    const chosen = preferredPublicRepresentation(accept);
    if (chosen !== "html") {
      const markdown = chosen === "markdown";
      return new NextResponse(
        request.method === "HEAD"
          ? null
          : markdown ? PUBLIC_MARKDOWN[pathname] : "Available representations: text/html, text/markdown.",
        {
          status: markdown ? 200 : 406,
          headers: {
            "Content-Type": markdown ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8",
            "Vary": "Accept",
            "Cache-Control": markdown ? "public, s-maxage=300" : "no-store",
          },
        },
      );
    }
  }

  const response = isRead && PUBLIC_AGENT_ROUTES.has(pathname)
    ? NextResponse.next({ request })
    : await updateSession(request);
  // Next 15.5 may replace Vary on rendered HTML; Vercel's narrow
  // post-render response transform provides final Vary: Accept there.
  if (negotiated) appendVaryAccept(response.headers);
  return response;
}

// FOUR EXACT PATHS are excluded, never a directory prefix.
//
// The exclusion exists because OFL 1.1 clause 2 requires the licence to
// accompany the copies of the font a browser receives, and `next/font/local`
// emits only the .woff2 files. The notices are served from public/fonts, and
// without an exclusion `updateSession` answered them 307 -> /login, so they
// were not reachable in the deployed app at all.
//
// It is scoped to the three exact filenames because a `fonts/` PREFIX exemption
// is an auth hole, not merely untidy. Next route groups do not appear in the
// URL, so `app/(app)/fonts/private/page.tsx` serves `/fonts/private` - a real
// authenticated route, matched by the prefix, silently never running
// updateSession. No file named `app/fonts/...` would exist to notice, so a
// guard watching that directory stays green while the route is anonymous.
//
// The .woff2 assets need nothing here: Next emits them under
// /_next/static/media, already covered by the `_next/static` exclusion.
//
// THE PRODUCT FILM (MKT-02B) is the third, and it is here for exactly the same
// reason the licences are. `public/film/...mp4` is a PUBLIC marketing asset on
// the anonymous homepage, and without an exclusion updateSession answered it
// 307 -> /login: the browser received an HTML login page where it expected
// video bytes and reported MEDIA_ERR_SRC_NOT_SUPPORTED. The film simply did not
// play for a logged-out visitor, which is every visitor it is aimed at. Caught
// by e2e/marketing-homepage-film.spec.ts, which is why that proof asserts
// frames actually decode rather than that a <video> element exists.
//
// IT IS THE EXACT FILE, NOT `.mp4`, and that is deliberate. Adding mp4 to the
// extension alternation above would have been one character cheaper and would
// exempt EVERY future .mp4 on every route from the session check. This
// application stores clinical media; a private treatment video added later
// under an authenticated path would be served to anyone, and nothing would
// announce it. The image extensions are a pre-existing decision with its own
// history; this lane does not widen that class.
//
// The trailing `$` on each alternative is load-bearing - it is what makes this
// an exact-path exclusion rather than a prefix one, so `/fonts/private`,
// `/fonts/LICENSE-Inter.txt/extra` and `/film/anything` all still run the
// middleware.
// A THIRD was added when the marketing surface moved to Instrument Sans: its
// notice needs serving on exactly the same terms, and adding it as another
// alternative rather than widening to a prefix is the whole point of the model.
//
// tests/source-guards/self-hosted-fonts-guards.test.ts parses this matcher and
// pins both directions for the licences; tests/app/marketing-homepage-film.test.ts
// does the same for the film. See FONTS.md.
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|fonts/LICENSE-Inter\\.txt$|fonts/LICENSE-Fraunces\\.txt$|fonts/LICENSE-InstrumentSans\\.txt$|film/hone-treatment-memory-v3-1\\.mp4$|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
