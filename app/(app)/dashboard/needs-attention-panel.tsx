"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type {
  AttentionClient,
  AttentionItemKind,
  NeedsAttention,
} from "@/lib/dashboard/needs-attention-model";
import { cardHasReaction } from "@/lib/dashboard/attention-card";
import type { DashboardTodoItem } from "@/lib/dashboard/todo-model";
import { itemIdentity, studioIdentity, type DismissedRow } from "@/lib/dashboard/needs-attention-visibility";
import { formatMoney, parsePaymentCurrency } from "@/lib/billing/payment-jurisdiction";
import { dismissAttentionAction, restoreAttentionAction } from "./attention-actions";

// Needs Attention: ONE list, ONE card per client id. Presentational: `needs` is already grouped, ordered and filtered by the owner's
// own dismissals (lib/dashboard/needs-attention-model.ts and needs-attention-visibility.ts, both pure). The count is NOT here: it is
// shown once, in the section heading. Every action is a plain link to an existing page; opening one never marks anything reviewed or
// complete. The ONLY writes are the owner's Dismiss and Restore of a reminder (dismissAttentionAction / restoreAttentionAction):
// they hide or show a reminder and never touch a balance, a payment, a setup status, a message or any access.

export const NEEDS_ATTENTION_COMPACT_COUNT = 6;

// "a", "a and b", "a, b and c".
function joinChecks(checks: ReadonlyArray<string>): string {
  if (checks.length <= 1) return checks.join("");
  return `${checks.slice(0, -1).join(", ")} and ${checks[checks.length - 1]}`;
}

const ACTION_CLASS =
  "shrink-0 rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:border-neutral-900 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-neutral-100 dark:hover:bg-neutral-900";

const BADGE: Record<AttentionItemKind, string> = {
  intake_review: "Intake",
  intake_incomplete: "Intake form",
  charting: "Charting",
  aftercare: "Aftercare",
  probe_lot: "Probe lot",
  record_details: "Record details",
  treatment_memory: "Reaction / watch",
  unpaid: "Unpaid",
};

const BADGE_CLASS =
  "inline-flex shrink-0 items-center rounded-full border border-neutral-300 px-2 py-0.5 text-[11px] font-medium text-neutral-700 dark:border-neutral-700 dark:text-neutral-300";

// What the single "Show N more" control reveals: the client cards past the compact count, and it names
// what it hides: a reaction/watch card behind the cut is stated, never silent. The studio card is
// exempt from the cap and is always rendered, so it is never part of this count.
export function hiddenCardsLabel(hiddenClients: number, hiddenReaction: number): string {
  const clients = `${hiddenClients} more ${hiddenClients === 1 ? "client" : "clients"}`;
  return hiddenReaction > 0
    ? `Show ${clients}, including ${hiddenReaction} reaction/watch`
    : `Show ${clients}`;
}

type DismissApi = { enabled: boolean; busy: boolean; error: string | null; dismiss: (key: string, token: string) => void };

function DismissButton({ api, identity, what }: { api: DismissApi; identity: { itemKey: string; instanceToken: string } | null; what: string }) {
  if (!api.enabled || identity === null) return null;
  return (
    <button
      type="button"
      data-testid="attention-dismiss"
      aria-label={`Dismiss reminder: ${what}`}
      disabled={api.busy}
      onClick={() => api.dismiss(identity.itemKey, identity.instanceToken)}
      className={`${ACTION_CLASS} min-h-[36px] disabled:opacity-50`}
    >
      Dismiss
    </button>
  );
}

// The amount HONE CAN SEE (Privacy AO2 / Insurance U2, #1356): the quote minus the payments Hone records and can read. It is not claimed
// as the final balance until the money-form inventory (lib/dashboard/other-money-forms.ts) is complete. Unknown reads "Amount unavailable", never 0.
function unpaidLine(item: AttentionClient["items"][number]): string {
  if (item.balance?.kind !== "owed") return "Amount unavailable";
  const currency = parsePaymentCurrency(item.balance.currency.toLowerCase());
  return `Hone can see ${formatMoney(item.balance.outstandingCents, currency)} still owed`;
}

function ClientCard({ card, api }: { card: AttentionClient; api: DismissApi }) {
  return (
    <li
      data-attention-client={card.clientId}
      data-attention-tier={card.tier}
      className="flex min-w-0 flex-col gap-2 px-4 py-3"
    >
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <Link
          href={`/clients/${card.clientId}`}
          className="min-w-0 max-w-full break-words font-medium text-neutral-900 [overflow-wrap:anywhere] hover:underline dark:text-neutral-100"
        >
          {card.clientName}
        </Link>
        <span className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
          {card.sharesNameWithAnotherClient && (
            <span data-testid="needs-attention-same-name">Same name as another client</span>
          )}
          <span>{card.tier === "preparation" ? "Before visit" : "Follow-up"}</span>
          {card.items.length > 1 && <span>{card.items.length} items</span>}
        </span>
      </div>
      <ul className="flex flex-col gap-2">
        {card.items.map((item) => (
          <li
            key={item.id}
            data-attention-issue={item.kind}
            className="flex flex-wrap items-start justify-between gap-2"
          >
            <div className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
              <span className="flex flex-wrap items-center gap-2">
                <span className={BADGE_CLASS}>{BADGE[item.kind]}</span>
                <span className="min-w-0 break-words text-sm text-neutral-700 dark:text-neutral-300">
                  {item.label}
                </span>
              </span>
              {item.kind === "unpaid" && (
                <span data-testid="attention-unpaid-amount" className="break-words text-sm font-medium text-neutral-900 dark:text-neutral-100">
                  {unpaidLine(item)}
                </span>
              )}
              {item.detail && (
                <span className="break-words text-xs text-neutral-500">{item.detail}</span>
              )}
            </div>
            <span className="flex flex-wrap items-center gap-2">
              <Link href={item.href} className={ACTION_CLASS}>
                {item.actionLabel}
              </Link>
              <DismissButton api={api} identity={itemIdentity(item)} what={`${card.clientName}, ${item.label}`} />
            </span>
          </li>
        ))}
      </ul>
    </li>
  );
}

function StudioCard({ items, api }: { items: ReadonlyArray<DashboardTodoItem>; api: DismissApi }) {
  return (
    <li data-attention-studio className="flex flex-col gap-2 px-4 py-3">
      <span className="font-medium text-neutral-900 dark:text-neutral-100">Studio</span>
      <ul className="flex flex-col gap-2">
        {items.map((item) => (
          <li
            key={item.id}
            data-todo-id={item.id}
            data-todo-kind={item.kind}
            className="flex flex-wrap items-start justify-between gap-2"
          >
            <div className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
              <span className="break-words text-sm text-neutral-700 dark:text-neutral-300">
                <span className="font-medium text-neutral-900 dark:text-neutral-100">
                  {item.subject.label}
                </span>
                {" · "}
                {item.reason}
              </span>
              {item.detail && (
                <span className="break-words text-xs text-neutral-500">{item.detail}</span>
              )}
            </div>
            <span className="flex flex-wrap items-center gap-2">
              <Link href={item.action.href} className={ACTION_CLASS}>
                {item.action.label}
              </Link>
              <DismissButton api={api} identity={studioIdentity(item)} what={`${item.subject.label}, ${item.reason}`} />
            </span>
          </li>
        ))}
      </ul>
    </li>
  );
}

function DismissedView({ rows, isOwner, restore, busy }: { rows: ReadonlyArray<DismissedRow>; isOwner: boolean; restore: (key: string) => void; busy: boolean }) {
  const [open, setOpen] = useState(false);
  if (rows.length === 0) return null;
  return (
    <div data-testid="attention-dismissed" className="flex flex-col gap-2">
      <button
        type="button"
        data-testid="attention-dismissed-toggle"
        aria-expanded={open}
        aria-controls="attention-dismissed-list"
        onClick={() => setOpen((v) => !v)}
        className={`self-start ${ACTION_CLASS}`}
      >
        {open ? "Hide dismissed" : `Dismissed (${rows.length})`}
      </button>
      {open && (
        <ul id="attention-dismissed-list" className="flex flex-col divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          <li className="px-4 py-2 text-xs text-neutral-500">
            Dismissing only hides a reminder for you. It does not change anything that is owed, paid or set up.
          </li>
          {rows.map((r) => (
            <li key={r.itemKey} data-dismissed-key={r.itemKey} className="flex flex-wrap items-start justify-between gap-2 px-4 py-3">
              <div className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
                <span className="break-words text-sm font-medium text-neutral-900 [overflow-wrap:anywhere] dark:text-neutral-100">{r.who}</span>
                <span className="break-words text-sm text-neutral-700 dark:text-neutral-300">{r.label}</span>
              </div>
              <span className="flex flex-wrap items-center gap-2">
                <Link href={r.href} className={ACTION_CLASS}>
                  {r.actionLabel}
                </Link>
                {isOwner && (
                  <button type="button" data-testid="attention-restore" disabled={busy} onClick={() => restore(r.itemKey)} className={`${ACTION_CLASS} min-h-[36px] disabled:opacity-50`}>
                    Restore
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function NeedsAttentionPanel({
  needs,
  dismissed = [],
  isOwner = false,
  dismissalsEnabled = false,
  dismissalsUnavailable = false,
  unpaid = null,
  unpaidAll = false,
  unpaidHrefs = { all: "?unpaid=all", recent: "?" },
}: {
  needs: NeedsAttention;
  dismissed?: ReadonlyArray<DismissedRow>;
  isOwner?: boolean;
  // The server-side gate (lib/dashboard/dismissals-gate). Fails closed: absent means no Dismiss, no Dismissed view, no note.
  dismissalsEnabled?: boolean;
  dismissalsUnavailable?: boolean;
  // Owner only. How far back unpaid appointments were looked for (null = every finished appointment) and how many were not returned.
  unpaid?: { windowDays: number | null; notReturned: number; unlisted: number } | null;
  unpaidAll?: boolean;
  // Same-page links that keep the day and period in the query.
  unpaidHrefs?: { all: string; recent: string };
}) {
  const [expanded, setExpanded] = useState(false);
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [actionError, setActionError] = useState<string | null>(null);
  // Dismiss exists for the owner only, and only when this owner's dismissals could be read (otherwise we cannot tell what is hidden).
  // Hiding the button is cosmetic: the server action and the database command both refuse a non-owner.
  const run = (fn: () => Promise<{ ok: boolean }>) => {
    setActionError(null);
    startTransition(async () => {
      const r = await fn();
      if (r.ok) router.refresh();
      else setActionError("Could not update that reminder. Nothing was changed. Try again.");
    });
  };
  const api: DismissApi = {
    enabled: isOwner && dismissalsEnabled && !dismissalsUnavailable,
    busy: pending,
    error: actionError,
    dismiss: (key, token) => run(() => dismissAttentionAction(key, token)),
  };
  const restore = (key: string) => run(() => restoreAttentionAction(key));
  const dismissedView = isOwner && dismissalsEnabled ? <DismissedView rows={dismissed} isOwner={!dismissalsUnavailable} restore={restore} busy={pending} /> : null;
  // Says what the unpaid check covers, and offers the bounded "All outstanding" view. Owners only: nobody else has the check.
  const unpaidNote =
    isOwner && unpaid ? (
      <p data-testid="needs-attention-unpaid-window" className="text-xs text-neutral-500">
        {unpaid.windowDays === null
          ? "Unpaid appointments: all finished appointments with a balance."
          : `Unpaid appointments: finished in the last ${unpaid.windowDays} days.`}{" "}
        Amounts are what Hone can see from recorded payments.{" "}
        {unpaid.unlisted > 0 && (
          <span data-testid="needs-attention-unpaid-unlisted">
            {unpaid.unlisted === 1 ? "1 finished visit has" : `${unpaid.unlisted} finished visits have`} no price or payment detail Hone can verify, so {unpaid.unlisted === 1 ? "it is" : "they are"} not listed.{" "}
          </span>
        )}
        {unpaid.notReturned > 0 && <span data-testid="needs-attention-unpaid-capped">Some older or additional ones are not shown, so this may not be everything. </span>}
        <Link href={unpaidAll ? unpaidHrefs.recent : unpaidHrefs.all} data-testid="needs-attention-unpaid-toggle" className="underline">
          {unpaidAll ? "Show last 90 days only" : "Show all outstanding"}
        </Link>
      </p>
    ) : null;
  const errorNote = actionError ? (
    <p role="alert" data-testid="attention-action-error" className="text-sm text-neutral-700 dark:text-neutral-300">
      {actionError}
    </p>
  ) : null;
  const dismissalsNote = isOwner && dismissalsEnabled && dismissalsUnavailable ? (
    <p data-testid="attention-dismissals-unavailable" className="text-xs text-neutral-500">
      Could not read your dismissed reminders just now, so every reminder is shown and Dismiss is off. Reload to try again.
    </p>
  ) : null;

  // Insurance N3: say what the details check covers, so a clean list is not read
  // as "every session ever is complete".
  const windowNote =
    needs.detailsWindow !== null ? (
      <p data-testid="needs-attention-window" className="text-xs text-neutral-500">
        Checks the studio&apos;s most recent {needs.detailsWindow} charted
        sessions for missing client or operator details.
      </p>
    ) : null;

  const unavailableNote =
    needs.unavailableChecks.length > 0 ? (
      <p
        role="status"
        data-testid="needs-attention-unavailable"
        className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200"
      >
        Could not check {joinChecks(needs.unavailableChecks)} just now, so
        this list may be incomplete. Reload to try again.
      </p>
    ) : null;

  // Roles R4 (RO-1): a viewer without clin.view_records is told so; an empty list is never presented as "all caught up".
  const restrictedNote = needs.notAvailableToRole ? (
    <p role="status" data-testid="needs-attention-not-available" className="text-sm text-neutral-600 dark:text-neutral-400">
      Records follow-up is not available to your role.
    </p>
  ) : null;

  if (needs.clients.length === 0 && needs.studioItems.length === 0) {
    const tail = (
      <>
        {errorNote}
        {unpaidNote}
        {dismissedView}
        {dismissalsNote}
      </>
    );
    if (restrictedNote) {
      return (
        <div className="flex flex-col gap-2">
          {unavailableNote}
          {restrictedNote}
          {tail}
        </div>
      );
    }
    // Something was capped away: this is not an all-clear.
    if (needs.notReturnedCount > 0) {
      return (
        <div className="flex flex-col gap-2">
          {unavailableNote}
          <p data-testid="needs-attention-capped" className="text-sm text-neutral-600 dark:text-neutral-400">
            Older items beyond this list are not included, so this may not be
            everything.
          </p>
          {windowNote}
          {tail}
        </div>
      );
    }
    if (unavailableNote) {
      return (
        <div className="flex flex-col gap-2">
          {unavailableNote}
          {windowNote}
          {tail}
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-2">
        <p className="rounded-lg border border-dashed border-neutral-300 px-4 py-6 text-sm text-neutral-500 dark:border-neutral-700">
          Nothing needs attention right now. Finished work drops off this list
          automatically.
        </p>
        {windowNote}
        {tail}
      </div>
    );
  }

  // ONE list: client cards, then (when present) one studio card. The compact
  // count applies to the cards, and the single control after the last card
  // reveals every card past it.
  // The cap applies to CLIENT cards only; the studio card is always rendered.
  const studioPresent = needs.studioItems.length > 0;
  const shownClients = expanded
    ? needs.clients
    : needs.clients.slice(0, NEEDS_ATTENTION_COMPACT_COUNT);
  // The toggle depends on the TOTAL, never on the current expansion, so "Show less" stays mounted
  // (and keeps keyboard focus) after expanding. The hidden-card label is computed from the
  // collapsed slice, so it reads the same whichever state the panel is in.
  const collapsedHidden = needs.clients.slice(NEEDS_ATTENTION_COMPACT_COUNT);
  const hiddenClients = collapsedHidden.length;
  const hiddenReaction = collapsedHidden.filter(cardHasReaction).length;
  const hasOverflow = hiddenClients > 0;

  return (
    <div className="flex flex-col gap-3">
      {unavailableNote}
      {restrictedNote}
      <ul
        id="needs-attention-list"
        className="flex flex-col divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800"
      >
        {shownClients.map((card) => (
          <ClientCard key={card.clientId} card={card} api={api} />
        ))}
        {studioPresent && <StudioCard items={needs.studioItems} api={api} />}
      </ul>
      {hasOverflow && (
        <button
          type="button"
          data-testid="needs-attention-toggle"
          aria-expanded={expanded}
          aria-controls="needs-attention-list"
          onClick={() => setExpanded((v) => !v)}
          className={`self-start ${ACTION_CLASS}`}
        >
          {expanded ? "Show less" : hiddenCardsLabel(hiddenClients, hiddenReaction)}
        </button>
      )}
      {needs.notReturnedCount > 0 && (
        <p className="text-xs text-neutral-500">
          Older items beyond this list are not included.
        </p>
      )}
      {windowNote}
      {errorNote}
      {unpaidNote}
      {dismissedView}
      {dismissalsNote}
    </div>
  );
}
