// The single-use marker of a print ticket (see ticket.ts).
//
// A ticket opens ONCE. The first open sets a marker with set-if-absent; a second open finds it and is refused. The
// marker is keyed by a hash of the ticket's random nonce and holds the value "1": no client id, no day, no studio, no
// owner, no ticket. It expires after the ticket's own lifetime (plus a margin), so the store never accumulates.
//
// It uses the Upstash Redis that already backs public rate limiting (production-required since PR #262): no migration,
// no new service. Unlike the rate limiter it FAILS CLOSED: when the store cannot answer, the ticket is refused, because
// "could not check whether it was used" must not read as "unused" for a clinical record. Outside production, with no
// Redis configured, an in-process set stands in so local runs and tests work; production without Redis refuses.

import { Redis } from "@upstash/redis";
import { TICKET_TTL_MS, ticketUseKey } from "@/lib/records/print/ticket";

export type TicketUse = "fresh" | "used" | "unavailable";
export type ConsumeTicket = (nonce: string) => Promise<TicketUse>;

const MARKER_TTL_SECONDS = Math.ceil(TICKET_TTL_MS / 1000) + 60;

const local = new Map<string, number>();

/** In-process stand-in. NEVER used in production (see consumeTicketNonce). */
export function consumeInProcess(nonce: string, now: number = Date.now()): TicketUse {
  const key = ticketUseKey(nonce);
  for (const [k, expires] of local) if (expires <= now) local.delete(k);
  if (local.has(key)) return "used";
  local.set(key, now + MARKER_TTL_SECONDS * 1000);
  return "fresh";
}

export function resetInProcessTicketStore(): void {
  local.clear();
}

export const consumeTicketNonce: ConsumeTicket = async (nonce) => {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    return process.env.NODE_ENV === "production" ? "unavailable" : consumeInProcess(nonce);
  }
  try {
    const redis = new Redis({ url, token });
    const set = await redis.set(ticketUseKey(nonce), "1", { nx: true, ex: MARKER_TTL_SECONDS });
    return set === "OK" ? "fresh" : "used";
  } catch {
    return "unavailable"; // never logs: the error text of a transport failure is not ours to forward
  }
};
