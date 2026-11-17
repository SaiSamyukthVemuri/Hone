// "Open again": recovery from a used or expired print link. Pure orchestration; the secret, the stores, the clock and
// the minting are injected, so every refusal is unit-tested without Next or Redis.
//
// ONE plain refusal. A non-owner, an owner of ANOTHER studio, a forged or altered ticket, a ticket nobody remembers (older
// than 30 minutes, or never minted here) and a store that cannot answer all return the same { ok: false }, so a refusal
// tells a prober nothing about which check failed. The ticket's studio comes from the authenticated ticket itself and is
// compared with the signed-in owner's studio BEFORE the remembered context is read, so another studio's owner never
// causes a lookup. The fresh ticket is bound to the CURRENT owner (any owner of the same studio may reopen) and is
// itself single-use and five minutes; opening it writes its own "previewed" audit row in the packet view.
import { inspectTicket, mintTicket } from "@/lib/records/print/ticket";
import type { RecallTicket, RememberTicket } from "@/lib/records/print/ticket-store";

export type ReopenResult = { ok: true; path: string } | { ok: false };

export async function reopenTicket(args: {
  secret: string | undefined;
  /** The signed-in practitioner, already resolved on the server. */
  practitioner: { id: string; role: string; active: boolean };
  studioId: string;
  ticket: unknown;
  recall: RecallTicket;
  remember: RememberTicket;
  now?: Date;
}): Promise<ReopenResult> {
  const refused = { ok: false } as const;
  if (args.practitioner.role !== "owner" || args.practitioner.active !== true) return refused;
  const seen = inspectTicket({ secret: args.secret, ticket: args.ticket });
  if (!seen.ok || seen.studioId.toLowerCase() !== args.studioId.toLowerCase()) return refused;
  const ctx = await args.recall(seen.nonce).catch(() => null);
  if (!ctx || ctx.studioId.toLowerCase() !== args.studioId.toLowerCase()) return refused;
  const minted = mintTicket({
    secret: args.secret,
    binding: { studioId: args.studioId, ownerId: args.practitioner.id },
    subject: { clientId: ctx.clientId, day: ctx.day },
    now: args.now,
  });
  if (!minted.ok) return refused;
  const kept = await args.remember(minted.nonce, ctx).catch(() => false);
  if (!kept) return refused;
  return { ok: true, path: `/records/print/ticket/${minted.ticket}` };
}
