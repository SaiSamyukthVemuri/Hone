// HON-46 / G-26 Option B — the ONE place the entry to the day packet is decided.
//
// The packet is opened by a POST form from the session page (action DAY_PACKET_OPEN_PATH), never by a link: the client
// id and the studio-local day go in the request BODY and the server answers with an opaque one-use ticket URL. This
// function returns exactly those two facts, and nothing else (no session id, no name, no time, no return path).
// It never builds a URL, so no caller can put either value in one.
//
// It returns null, and the caller renders NO control, when the viewer cannot print (owner-only, active), the client
// id is not a UUID, the session has no usable start, or the studio-local day is out of range or after the
// studio's today (checkPrintableDay: a future day holds no treatments and would only create audit rows).
// Pure: no I/O, no logging.
import { localDateString } from "@/lib/booking/tz";
import { canPrintClinicalPacket } from "@/lib/records/print/day-audit";
import { checkPrintableDay } from "@/lib/records/print/day-guard";
import { parseSelectedDay } from "@/lib/records/print/selected-day";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Where the form posts. Carries no identifier; the values are in the body. */
export const DAY_PACKET_OPEN_PATH = "/records/print/open";

export function dayPacketEntry(input: {
  viewer: { role: string; active: boolean };
  clientId: string;
  sessionStartedAt: string | null | undefined;
  timezone: string;
  now?: Date;
}): { clientId: string; day: string } | null {
  if (!canPrintClinicalPacket(input.viewer)) return null;
  if (!UUID.test(input.clientId)) return null;
  const started = input.sessionStartedAt ? new Date(input.sessionStartedAt) : null;
  if (started === null || Number.isNaN(started.getTime())) return null;
  let day: string;
  try {
    day = localDateString(started, input.timezone);
  } catch {
    return null; // an unresolvable timezone cannot say which day this was
  }
  const parsed = parseSelectedDay(day);
  if (!parsed.ok) return null;
  if (!checkPrintableDay(parsed.day, input.timezone, input.now ?? new Date()).ok) return null;
  return { clientId: input.clientId.toLowerCase(), day: parsed.day };
}
