// G-26 Option B — open a print ticket for THIS signed-in owner, once. Pure orchestration: the secret, the clock and
// the single-use store are injected, so every refusal is unit-tested without Next, Redis or a database.
//
// The order matters: the ticket is authenticated and bound to this studio and owner BEFORE its use is recorded, so a
// stranger's or a foreign ticket can never consume (and so waste) the real owner's marker, and a forged string never
// reaches the store at all.
import { openTicket, type TicketBinding } from "@/lib/records/print/ticket";
import type { ConsumeTicket } from "@/lib/records/print/ticket-store";

export type TicketResolution =
  | { ok: true; clientId: string; day: string }
  | { ok: false; reason: "unavailable" | "malformed" | "invalid" | "expired" | "foreign" | "used" };

export async function resolveTicket(args: {
  secret: string | undefined;
  binding: TicketBinding;
  ticket: unknown;
  consume: ConsumeTicket;
  now?: Date;
}): Promise<TicketResolution> {
  const opened = openTicket({ secret: args.secret, binding: args.binding, ticket: args.ticket, now: args.now });
  if (!opened.ok) return opened;
  const use = await args.consume(opened.nonce).catch(() => "unavailable" as const);
  if (use === "unavailable") return { ok: false, reason: "unavailable" };
  if (use === "used") return { ok: false, reason: "used" };
  return { ok: true, clientId: opened.clientId, day: opened.day };
}
