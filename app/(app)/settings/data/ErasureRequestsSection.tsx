import { Card } from "@/components/ui/card";
import { SectionLabel } from "@/components/ui/section-label";
import {
  ERASURE_DELETES_NOTHING,
  ERASURE_EXECUTION_UNAVAILABLE,
  ERASURE_REASON_MAX,
  describeErasureRequest,
  erasureClientLabel,
  type ErasureRequestRow,
} from "@/lib/erasure/requests";

// Owner-only Settings section for erasure REQUESTS (R5, DN-18). Prepared, not wired: nothing renders it yet. The page that does must render
// it ONLY for an owner (requirePractitionerWithStudio + role check); this component trusts its caller for that and holds no data of its own.
// The sentence above the queue and the disabled execution control are the contract: recording a request deletes nothing.

// A form action must return void. The server actions in erasure-actions.ts return a result (so the owner can be told why a step failed);
// whoever wires this section wraps each one, e.g. `async function onRequest(fd: FormData) { "use server"; await requestErasureAction(fd); }`
// and surfaces the result (a redirect with a status, or useActionState in a client wrapper).
type Action = (formData: FormData) => void | Promise<void>;
type ClientNames = Record<string, { preferred_name: string | null; name: string | null }>;

export function ErasureRequestsSection({
  requests,
  clients,
  onRequest,
  onAdvance,
  onWithdraw,
}: {
  requests: ErasureRequestRow[];
  clients: ClientNames;
  onRequest: Action;
  onAdvance: Action;
  onWithdraw: Action;
}) {
  const rows = requests.map(describeErasureRequest);
  return (
    <Card className="p-5" data-testid="erasure-requests">
      <SectionLabel>Erasure requests</SectionLabel>
      <p className="mt-2 text-sm font-medium" data-testid="erasure-deletes-nothing">{ERASURE_DELETES_NOTHING}</p>
      <p className="mt-1 text-sm text-muted-foreground">
        Use this to keep a record that a client asked for their data to be erased, and to track the decision. Only the studio owner sees it.
      </p>

      <form action={onRequest} className="mt-4 grid gap-2" data-testid="erasure-request-form">
        <label className="text-sm" htmlFor="erasure-client">Client ID</label>
        <input id="erasure-client" name="client_id" required className="rounded border px-2 py-1 text-sm" autoComplete="off" />
        <label className="text-sm" htmlFor="erasure-reason">Why is this being recorded?</label>
        <textarea id="erasure-reason" name="reason" required maxLength={ERASURE_REASON_MAX} rows={3} className="rounded border px-2 py-1 text-sm" />
        <button type="submit" className="w-fit rounded border px-3 py-1 text-sm">Record request</button>
      </form>

      <ul className="mt-4 grid gap-3" data-testid="erasure-queue">
        {rows.length === 0 ? <li className="text-sm text-muted-foreground">No erasure requests.</li> : null}
        {rows.map((r) => (
          <li key={r.id} className="rounded border p-3 text-sm" data-testid="erasure-row">
            <div className="font-medium">{erasureClientLabel(clients[r.clientId])}</div>
            <div data-testid="erasure-state">{r.stateLabel}</div>
            <div className="text-muted-foreground">{r.reason}</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {r.next ? (
                <form action={onAdvance}>
                  <input type="hidden" name="request_id" value={r.id} />
                  <input type="hidden" name="to" value={r.next.to} />
                  <button type="submit" className="rounded border px-3 py-1">{r.next.label}</button>
                </form>
              ) : null}
              {r.canWithdraw ? (
                <form action={onWithdraw}>
                  <input type="hidden" name="request_id" value={r.id} />
                  <button type="submit" className="rounded border px-3 py-1">Withdraw request</button>
                </form>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      <div className="mt-4">
        <button type="button" disabled aria-describedby="erasure-unavailable" className="rounded border px-3 py-1 text-sm opacity-60" data-testid="erasure-execute">
          Erase client data
        </button>
        <p id="erasure-unavailable" className="mt-1 text-sm text-muted-foreground">{ERASURE_EXECUTION_UNAVAILABLE}</p>
      </div>
    </Card>
  );
}
