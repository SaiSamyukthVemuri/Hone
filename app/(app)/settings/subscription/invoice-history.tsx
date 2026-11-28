"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/ui/status-pill";
import type { InvoicePage, InvoiceRow } from "@/lib/subscriptions/billing-overview";
import { loadOlderInvoices } from "./actions";

const statuses = {
  paid: ["Paid", "success"], open: ["Open", "warning"],
  void: ["Void", "neutral"], uncollectible: ["Uncollectible", "neutral"],
} as const;
const linkStyle = "inline-flex min-h-11 items-center text-sm font-medium underline decoration-line-strong underline-offset-4 hover:decoration-current";

function invoiceAmount(row: InvoiceRow) {
  const currency = row.currency.toUpperCase();
  const money = new Intl.NumberFormat("en-US", { style: "currency", currency });
  const digits = money.resolvedOptions().maximumFractionDigits ?? 2;
  return (currency === "USD" ? "US" : "") + money.format(row.total / 10 ** digits);
}

export function InvoiceHistory({ initial, studioId, timezone }: {
  initial: InvoicePage; studioId: string; timezone: string;
}) {
  const [older, setOlder] = useState<InvoicePage>({ rows: [], next: initial.next });
  const existing = new Set(initial.rows.map(row => row.id));
  const rows = [...initial.rows, ...older.rows.filter(row => !existing.has(row.id))];
  const [error, setError] = useState(false);
  const [pending, startTransition] = useTransition();
  function more() {
    const cursor = older.next;
    if (!cursor || pending) return;
    setError(false);
    startTransition(async () => {
      const result = await loadOlderInvoices(studioId, cursor).catch(() => null);
      if (!result) { setError(true); return; }
      setOlder(previous => {
        if (previous.next !== cursor) return previous;
        const ids = new Set(previous.rows.map(row => row.id));
        return { next: result.next, rows: [...previous.rows, ...result.rows.filter(row => !ids.has(row.id))] };
      });
    });
  }
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, dateStyle: "medium" });
  return <div>
    {rows.length > 0 ? <div className="overflow-hidden rounded-xl border border-line">
      <table aria-label="Subscription invoices" className="w-full border-collapse text-left text-sm">
        <thead className="bg-surface-sunken text-xs text-fg-muted">
          <tr><th scope="col" className="px-2.5 py-3 font-medium sm:px-4">Date<span className="sm:hidden"> / total</span></th>
            <th scope="col" className="hidden px-4 py-3 text-right font-medium sm:table-cell">Total</th>
            <th scope="col" className="px-1 py-3 font-medium sm:px-4">Status</th>
            <th scope="col" className="px-2.5 py-3 text-right font-medium sm:px-4">Actions</th></tr>
        </thead>
        <tbody className="divide-y divide-line">{rows.map(row => {
          const [label, tone] = statuses[row.status];
          const date = formatter.format(row.date * 1000);
          const amount = invoiceAmount(row);
          return <tr key={row.id}>
            <td className="px-2.5 py-3 sm:px-4"><time dateTime={new Date(row.date * 1000).toISOString()}>{date}</time>
              <span className="mt-1 block text-xs text-fg-muted sm:hidden">{amount}</span></td>
            <td className="hidden px-4 py-3 text-right tabular-nums sm:table-cell">{amount}</td>
            <td className="px-1 py-3 sm:px-4"><StatusPill tone={tone}>{label}</StatusPill></td>
            <td className="px-2.5 py-1 text-right sm:px-4"><div className="flex flex-wrap justify-end gap-x-3">
              {row.hosted && (row.payable || !row.pdf) && <a className={linkStyle} href={row.hosted} aria-label={(row.payable ? "Pay invoice" : "View invoice") + " for " + date}>{row.payable ? "Pay invoice" : "View invoice"}</a>}
              {row.pdf && <a className={linkStyle} href={row.pdf} aria-label={"Download invoice PDF for " + date}>Download PDF</a>}
              {!row.hosted && !row.pdf && <span aria-label="No document available">—</span>}
            </div></td>
          </tr>;
        })}</tbody>
      </table>
    </div> : <p className="py-3 text-sm text-fg-muted">{older.next ? "No finalized invoices on this page." : "No invoices yet."}</p>}
    {older.next && <div className="mt-4 text-center">
      <Button size="sm" onClick={more} pending={pending} busyLabel="Loading invoices…">Load more</Button>
    </div>}
    {error && <p role="alert" className="mt-2 text-center text-sm">We couldn’t load older invoices. Try again.</p>}
  </div>;
}
