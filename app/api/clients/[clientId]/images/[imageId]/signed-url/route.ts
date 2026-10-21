import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import {
  IMAGE_NOT_AVAILABLE,
  signTreatmentImageUrl,
} from "@/app/(app)/clients/[id]/images/sign-treatment-image";

// FETT photos (HON-43): re-mint ONE expired treatment-photo URL for a photo
// cell (Photos grid, profile ID photo, visit chart).
//
// WHY A ROUTE AND NOT THE SERVER ACTION (Codex P1 4307807754). Next's App
// Router runs server actions one at a time per page (app-router-instance.js:
// every non-navigation action waits for the pending one). A re-mint action
// that never settled therefore held its own retry AND every later action on
// the page, saves included. A plain fetch is independent: the cell aborts it
// on timeout, and nothing else queues behind it.
//
// AUTHORIZATION: this endpoint returns signed URLs, so it is never weaker than
// the action. The session middleware already refuses it before this runs: no
// user -> 307 /login; no active practitioner (a receptionist, an uninvited
// account) -> 307 /no-access. It adds NO middleware exemption. The checks
// below repeat both as defence in depth, then call the SAME signer the action
// uses, with the clientId from the path as an extra bound.
//
// RESPONSES: never cached (no-store), no CORS headers (a cross-site page can
// send the GET but never read the answer). Every refusal of a specific image
// is the same 404 body, so "exists in another studio/client" is
// indistinguishable from "does not exist". Nothing here logs.

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_STORE = { "Cache-Control": "no-store, private" } as const;

function json(status: number, body: Record<string, string>) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ clientId: string; imageId: string }> },
) {
  const { clientId, imageId } = await params;
  const variant = request.nextUrl.searchParams.get("variant");
  if (variant !== "thumb" && variant !== "original") {
    return json(400, { error: "bad_request" });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return json(401, { error: "unauthenticated" });

  let studioId: string;
  try {
    ({
      studio: { id: studioId },
    } = await getCurrentPractitionerWithStudio());
  } catch {
    return json(403, { error: "forbidden" });
  }

  if (!UUID.test(clientId) || !UUID.test(imageId)) {
    return json(404, { error: IMAGE_NOT_AVAILABLE });
  }
  const result = await signTreatmentImageUrl(
    studioId,
    { imageId, clientId, variant },
    "/api/clients/[clientId]/images/[imageId]/signed-url",
  );
  if (!result.ok) return json(404, { error: IMAGE_NOT_AVAILABLE });
  return json(200, { url: result.url });
}
