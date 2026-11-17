import { NextResponse } from "next/server";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { canPrintClinicalPacket } from "@/lib/records/print/day-audit";
import { checkPrintableDay } from "@/lib/records/print/day-guard";
import { parseSelectedDay } from "@/lib/records/print/selected-day";
import { mintTicket } from "@/lib/records/print/ticket";
import { rememberTicketContext } from "@/lib/records/print/ticket-store";
import { isSameOriginPost } from "@/lib/records/print/same-origin";

// The owner presses Print on a session page; the browser POSTs a form here. The client id and the day
// travel in the request BODY (never a URL), and the answer is a 303 to /records/print/ticket/<opaque ticket>, so no
// identifier is in the URL, the Location header, or the Referer of the next request.
//
// This POST's Referer, when the browser sends one, is the session page and goes only to this server. Only POST is exported: a GET
// is a 405 and cannot carry the values. The owner gate and the day check run HERE, so a non-owner or a bad day never
// receives a ticket. Nothing is logged, and a refusal names no reason (a refusal's text would otherwise tell a prober
// which of the checks failed).
//
// Minting reads and writes nothing in the database. The audit row is written when the ticket is opened (the packet
// view records the preview before any record is read), exactly as before.
export const dynamic = "force-dynamic";

const HEADERS = {
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

// The Location is RELATIVE on purpose: request.url's host is not reliable behind a proxy (under next start it can be the
// server's own listen host), and a relative Location is resolved by the browser against the host it actually used.
function back(_request: Request): NextResponse {
  return new NextResponse(null, { status: 303, headers: { ...HEADERS, Location: "/records" } });
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!isSameOriginPost(request.headers)) return back(request);
  // Identity and the owner gate come BEFORE the body is read: a stranger's, a non-owner's or an unauthenticated request
  // never has its form parsed, so its values are never held by this handler.
  let identity: Awaited<ReturnType<typeof requirePractitionerWithStudio>>;
  try {
    identity = await requirePractitionerWithStudio();
  } catch {
    return back(request); // not signed in, or no studio: the redirect helper throws; nothing is minted
  }
  const { practitioner, studio } = identity;
  if (!canPrintClinicalPacket(practitioner)) return back(request);
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return back(request);
  }
  const rawClient = form.get("clientId");
  const rawDay = form.get("day");

  const day = parseSelectedDay(typeof rawDay === "string" ? rawDay : undefined);
  if (!day.ok || !checkPrintableDay(day.day, studio.timezone).ok) return back(request);
  if (typeof rawClient !== "string") return back(request);

  const minted = mintTicket({
    secret: process.env.PRINT_TICKET_SECRET,
    binding: { studioId: studio.id, ownerId: practitioner.id },
    subject: { clientId: rawClient.toLowerCase(), day: day.day },
  });
  if (!minted.ok) return back(request);
  // Server-side only, 30 minutes: lets the same studio's owner reopen THIS link after it is used or expired
  // (ticket-reopen.ts). Not remembering never blocks the print: the ticket itself still works, only "Open again" refuses.
  await rememberTicketContext(minted.nonce, {
    studioId: studio.id,
    clientId: rawClient.toLowerCase(),
    day: day.day,
  }).catch(() => false);
  return new NextResponse(null, {
    status: 303,
    headers: { ...HEADERS, Location: `/records/print/ticket/${minted.ticket}` },
  });
}
