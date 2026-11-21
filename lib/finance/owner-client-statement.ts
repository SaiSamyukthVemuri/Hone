import { type PaymentCurrency } from "@/lib/billing/payment-jurisdiction";
import { getStudioPaymentJurisdiction } from "@/lib/billing/payment-jurisdiction-server";
import { localDateString } from "@/lib/booking/tz";
import { loadClientStatementRead } from "@/lib/finance/client-statement-read";
import { buildStatementDocument, type StatementDocument } from "@/lib/finance/statement-document";
import { resolveStatementMonth, yearMonthOf, type YearMonth } from "@/lib/finance/statement-period";
import { parseClientView, type ClientView } from "@/lib/finance/statement-screen";

// ===========================================================================
// ONE client's statement document for the signed-in OWNER: the single path the screen, the print view and the CSV all go through, so the three
// can never disagree about who may see it, which client it is, or what the selection means. READ-ONLY.
// ===========================================================================
// THE OWNER GATE IS THE FIRST STATEMENT: a non-owner reaches no read at all. The client id is VERIFIED against the studio by the read module before
// anything else is read; another studio's id and an unknown id are the same `not_found`.

type Who = Parameters<typeof loadClientStatementRead>[0];
type Studio = Parameters<typeof loadClientStatementRead>[1];

export type OwnerClientStatement =
  | {
      ok: true;
      document: StatementDocument;
      currency: PaymentCurrency | null;
      offDocumentWithMoney: number;
      month: YearMonth;
      currentMonth: YearMonth;
      fellBack: boolean;
      view: ClientView;
    }
  | { ok: false; refusal: "not_owner" | "bad_request" | "not_found" | "unavailable"; reason: string };

export async function loadOwnerClientStatement(args: {
  practitioner: Who & { role: string };
  studio: Studio & { id: string; name: string; timezone: string };
  clientId: string;
  monthParam: string | string[] | undefined;
  viewParam: string | string[] | undefined;
  /** An export asks for exactly what it names: a month or view that is present but not valid is refused, not replaced by today's. */
  strict?: boolean;
  now: Date;
}): Promise<OwnerClientStatement> {
  const { practitioner, studio, clientId, monthParam, viewParam, now } = args;
  if (practitioner.role !== "owner") return { ok: false, refusal: "not_owner", reason: "not_owner" };

  const currentMonth = yearMonthOf(localDateString(now, studio.timezone));
  const { month, fellBack } = resolveStatementMonth(monthParam, currentMonth);
  const view = parseClientView(viewParam);
  if (args.strict) {
    const rawView = Array.isArray(viewParam) ? viewParam[0] : viewParam;
    if (fellBack || (rawView !== undefined && rawView !== "month" && rawView !== "history")) return { ok: false, refusal: "bad_request", reason: "bad_request" };
  }

  const jurisdiction = await getStudioPaymentJurisdiction(studio.id);
  const currency: PaymentCurrency | null = jurisdiction.ok ? jurisdiction.jurisdiction.currency : null;

  const read = await loadClientStatementRead(practitioner, studio, currency, clientId, now);
  if (read.access !== "granted") return { ok: false, refusal: "unavailable", reason: "read_failed" };
  if (!read.ok) return { ok: false, refusal: read.reason === "client_not_found" ? "not_found" : "unavailable", reason: read.reason };

  const built = buildStatementDocument({
    studioId: studio.id,
    identity: { studioName: studio.name, legalEntityName: null, address: null, contactEmail: null },
    client: read.client,
    scope: view === "history" ? { kind: "full_history" } : { kind: "month", month },
    currency: read.studioCurrency,
    preparedOn: localDateString(now, studio.timezone),
    visits: read.visits,
    feeItems: read.feeItems,
  });
  if (!built.ok) return { ok: false, refusal: "unavailable", reason: "build_failed" };
  return { ok: true, document: built.document, currency, offDocumentWithMoney: read.offDocumentWithMoney, month, currentMonth, fellBack, view };
}
