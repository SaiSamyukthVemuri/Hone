// "Open again": recovery from a used or expired print link. Pure orchestration; the secret and the clock are injected, so
// every refusal is unit-tested without Next or any store.
//
// NOTHING IS STORED. The ticket already carries its studio, client and day (ticket.ts header), so there is no server-side
// context to read or to keep. A reopen needs all of:
//   1. the signed-in practitioner is an ACTIVE OWNER, and their studio equals the ticket's studio (checked first, before the
//      window, before any use of the client or day);
//   2. now is no later than the ticket's own expiry plus 25 minutes (30 minutes from minting; a ticket that was never opened
//      reopens too);
//   3. the ticket is authentic and could have been minted by this code.
// Every failure returns the same { ok: false }: a refusal tells a prober nothing about which check failed. The fresh ticket is
// bound to the CURRENT owner (any owner of the same studio may reopen), is itself single-use and lives five minutes; opening
// it writes its own "previewed" audit row in the packet view. The old ticket stays as it was: it is never consumed here.
import { REOPEN_GRACE_MS, inspectTicket, mintTicket } from "@/lib/records/print/ticket";

export type ReopenResult = { ok: true; path: string } | { ok: false };

export function reopenTicket(args: {
  secret: string | undefined;
  /** The signed-in practitioner, already resolved on the server. */
  practitioner: { id: string; role: string; active: boolean };
  studioId: string;
  ticket: unknown;
  now?: Date;
}): ReopenResult {
  const refused = { ok: false } as const;
  const now = args.now ?? new Date();
  if (args.practitioner.role !== "owner" || args.practitioner.active !== true) return refused;
  const seen = inspectTicket({ secret: args.secret, ticket: args.ticket, now });
  if (!seen.ok || seen.studioId.toLowerCase() !== args.studioId.toLowerCase()) return refused;
  if (now.getTime() > seen.expiresAtMs + REOPEN_GRACE_MS) return refused;
  const minted = mintTicket({
    secret: args.secret,
    binding: { studioId: args.studioId, ownerId: args.practitioner.id },
    subject: { clientId: seen.clientId, day: seen.day },
    now,
  });
  if (!minted.ok) return refused;
  return { ok: true, path: `/records/print/ticket/${minted.ticket}` };
}
