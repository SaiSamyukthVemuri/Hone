// HON-46 — the ONE place the entry link to the day packet is built.
//
// The packet page (app/(app)/records/print/day/page.tsx) is "entered only by a deliberate click" and refuses
// without ONE client and ONE studio-local day. The entry from a client's session is therefore built here, from
// exactly those two facts, and nothing else rides in the URL: no session id, no name, no time, no return path
// (the client id and the day already travel in the query string by design; see the page's URL PRIVACY note).
//
// It returns null, and the caller renders NO link, when the viewer cannot print (owner-only, active), the client
// id is not a UUID, the session has no usable start, or the studio-local day is out of range or after the
// studio's today (checkPrintableDay: a future day holds no treatments and would only create audit rows).
// Pure: no I/O, no logging.
import { localDateString } from "@/lib/booking/tz";
import { canPrintClinicalPacket } from "@/lib/records/print/day-audit";
import { checkPrintableDay } from "@/lib/records/print/day-guard";
import { parseSelectedDay } from "@/lib/records/print/selected-day";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DAY_PACKET_PATH = "/records/print/day";

export function dayPacketEntryHref(input: {
  viewer: { role: string; active: boolean };
  clientId: string;
  sessionStartedAt: string | null | undefined;
  timezone: string;
  now?: Date;
}): string | null {
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
  const params = new URLSearchParams({ clientId: input.clientId.toLowerCase(), day: parsed.day });
  return `${DAY_PACKET_PATH}?${params.toString()}`;
}
