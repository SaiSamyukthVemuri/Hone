import type { SupabaseClient } from "@supabase/supabase-js";

import { addDays, localDateString, utcInstantFromLocal } from "@/lib/booking/tz";
import {
  resolvePeriodRange,
  type ReportingPeriod,
} from "@/lib/booking/reporting-period";
import { fetchAllRows } from "@/lib/export/paginate";
import { createClient } from "@/lib/supabase/server";
import type { Studio } from "@/lib/types/database";

import {
  known,
  unknownBecause,
  type Fact,
  type FinancialUnknownCause,
} from "./financial-fact";

import { inferStripeLivemode } from "@/lib/stripe/livemode";

import {
  summarizeCalendar,
  summarizeDeliveredMoney,
  unreadableCalendar,
  unreadableDeliveredMoney,
  type CalendarCensus,
  type ChargeRow,
  type CustomPricingRow,
  type DeliveredMoneyCensus,
  type DeliveryRow,
  type RefundRow,
  type ServiceRow,
  type SettlementRow,
} from "./financial-briefing-model";

// ===========================================================================
// FIN-01A — the read behind /financials
// ===========================================================================
//
// READ-ONLY. No INSERT, no UPDATE, no DELETE, no RPC, no Stripe call, no
// migration. It touches no email, SMS, Google or analytics path.
//
// WHAT THE OWNER GATE IS, STATED PLAINLY — and it is the same statement
// lib/dashboard/owner-capacity.ts makes, for the same reason. This is an
// APPLICATION-LAYER check on `practitioner.role`, performed BEFORE any read is
// issued and before a Supabase client is even constructed. It is NOT a database
// boundary. RLS on `appointments` is `is_studio_member`; so is the single
// SELECT policy on `payment_charge_attempts`, and so is
// `appointment_settlements_member_select` from migration 0187. Every
// practitioner of this studio can already SELECT those rows directly. This
// module decides who is SHOWN the aggregate, not who is permitted the
// underlying data.
//
// Making financial records owner-only IN THE DATABASE is a separate
// authorization project with its own blast radius — current operational payment
// workflows depend on the existing access model — and nothing here pretends to
// be one. Saying otherwise would describe a protection that does not exist.
//
// SCOPE — SLICE 2, "August-onward delivered-money truth". Present-tense
// observable facts only: what was delivered, what was collected by card, what
// a practitioner attested collecting outside Hone, and what nobody has
// recorded either way. NO forecast, NO scenario, NO client projection, and NO
// capacity utilisation — those are Slice 3 and are absent, not approximated.
//
// STILL READ-ONLY, AND STILL NO STRIPE CALL. `inferStripeLivemode` is imported
// from lib/stripe/livemode, a leaf module with no imports; the Stripe SDK is
// NOT in this closure and the mode is read from the process environment. See
// that file for why it was extracted rather than copied.
//
// SEVEN READS, ONE SNAPSHOT, ONE APPOINTMENTS READ. The calendar census and the
// money census are computed from the SAME appointment rows — the money one
// simply narrows them to its own window in memory — so the two panels can never
// disagree about which appointments exist. The reads are independent of each
// other and are issued concurrently rather than as a waterfall.

/** One request returns at most this many rows; `supabase/config.toml` sets it. */
const API_PAGE_SIZE = 1_000;

export type FinancialBriefing = {
  readonly timezone: string;
  readonly period: ReportingPeriod;
  /** Studio-local calendar dates. The browser's timezone never participates. */
  readonly startLocal: string;
  /** What a human reads ("to 31 May"). */
  readonly endLocalInclusive: string;
  /** What the query used. */
  readonly endLocalExclusive: string;
  readonly label: string;
  readonly calendar: CalendarCensus;
  /**
   * The single instant every "has it elapsed" decision on this screen resolved
   * against, as an ISO string. ON SCREEN, not in a tooltip: production moved
   * under this measurement while it was being taken — delivered August visits
   * went 63 to 64 and card-paid 34 to 35 inside twenty-six minutes — so two
   * reports run minutes apart legitimately disagree. Without the instant, an
   * owner comparing them concludes Hone is broken.
   */
  readonly evidenceInstant: string;
  /** The money window, which is the period INTERSECTED with the floor below. */
  readonly money: DeliveredMoneyWindow;
  /**
   * SUCCEEDED card payments carrying NO collection time — ALL TIME, not this
   * period, and deliberately not inside the money census.
   *
   * These rows have `status = 'succeeded'` and `charged_at IS NULL`. There is
   * no authoritative instant to window them by: `created_at` records when the
   * ATTEMPT ROW was written, not when money moved, so using it would invent a
   * collection time and file real money into a period on a guess.
   *
   * They sat beside the windowed figures in the first draft, which read as a
   * claim about the period. FIN-C9 still requires surfacing them — dropping
   * them denies money that was actually made — so they are kept, moved out of
   * the period entirely, and labelled all-time at the point of use.
   */
  readonly unattributedChargesAllTime: Fact<number>;
};

/**
 * The money figures and the window they actually cover.
 *
 * SEPARATE FROM THE PERIOD because it is not the same window. The calendar
 * covers everything the owner asked for; the money covers only the part of it
 * whose record-keeping can carry a money figure at all.
 */
export type DeliveredMoneyWindow =
  | {
      /** The whole requested period predates reliable record-keeping. */
      readonly covered: false;
      readonly opensLocal: string;
      readonly census: DeliveredMoneyCensus;
    }
  | {
      readonly covered: true;
      /** Studio-local start of the money window; >= the period start. */
      readonly startLocal: string;
      /** TRUE when the floor cut the period short, so the screen can say so. */
      readonly narrowed: boolean;
      readonly opensLocal: string;
      /**
       * TRUE when the window reaches back before this studio's first verified
       * card payment, so "collected" covers time Hone was not yet collecting.
       * FIN-C11: a window that predates the ledger is never reported flat.
       */
      readonly precedesLedger: boolean;
      readonly census: DeliveredMoneyCensus;
    };

/**
 * THE RULING-1 FLOOR. Studio-local date from which money figures are reported.
 *
 * WHY A DATE AND NOT A SETTING. The share of elapsed appointments ever marked
 * `completed` ran 0.0% -> 20.8% -> 82.6% -> 98.4% across 2026-05..2026-08 in
 * production. Below that floor the three defensible readings of "delivered"
 * disagree by twenty points of collection rate; at and above it they returned
 * 35, 35 and 35 on the same window — identical, not merely close. The floor is
 * what makes every figure in the money census well-defined.
 *
 * HONEST LIMITATION, RECORDED RATHER THAN HIDDEN: this is ONE date for every
 * studio, derived from the record-keeping of the one studio using this surface.
 * A studio that started closing appointments out earlier is under-served by it,
 * and one that started later is over-served. Deriving the floor per studio from
 * its own marking rate is a real mechanism with its own evidence burden, and it
 * is deliberately NOT invented here.
 */
export const MONEY_WINDOW_OPENS_LOCAL = "2026-08-01";

/**
 * The whole outcome of asking for this screen, INCLUDING the refusal.
 *
 * A refusal is a value rather than a thrown error or a null briefing because
 * the page must be able to render the owner-only message without ever holding
 * an aggregate — and because a test can then prove that a non-owner produced no
 * read at all, which is the actual security-relevant claim.
 */
export type FinancialsView =
  | { readonly access: "refused" }
  | { readonly access: "granted"; readonly briefing: FinancialBriefing };

export async function loadFinancialsView(
  practitioner: { readonly role: string },
  studio: Studio,
  period: ReportingPeriod,
  supabaseClient: SupabaseClient | undefined = undefined,
): Promise<FinancialsView> {
  // FIRST STATEMENT, and it must stay first. Everything below this line — the
  // client, the window, the read — is skipped for a non-owner, so a
  // practitioner who types the URL causes no studio-wide query and receives no
  // aggregate payload, not merely an aggregate they are not shown.
  if (practitioner.role !== "owner") return { access: "refused" };

  const tz = studio.timezone;
  // ONE CLOCK READ, used for BOTH the period window and the still-to-happen
  // split. `todayInTz(tz)` is exactly `localDateString(new Date(), tz)`, so
  // this is the same value it returned — but reading the clock twice would let
  // the window and the temporal split straddle midnight and disagree about
  // which day it is, for one instant a day, unreproducibly.
  const now = new Date();
  const todayLocal = localDateString(now, tz);
  const range = resolvePeriodRange(todayLocal, period);

  // TWO SEPARATE LOCAL-MIDNIGHT INSTANTS, never "start + N x 24h". A DST day is
  // 23 or 25 hours long, and the arithmetic form silently moves an evening
  // appointment into the wrong period twice a year.
  const startUtc = utcInstantFromLocal(range.startLocal, "00:00", tz).toISOString();
  const endUtc = utcInstantFromLocal(range.endLocalExclusive, "00:00", tz).toISOString();

  const moneyStartLocal =
    range.startLocal > MONEY_WINDOW_OPENS_LOCAL ? range.startLocal : MONEY_WINDOW_OPENS_LOCAL;
  // String comparison is exact for ISO `YYYY-MM-DD` and needs no Date, so the
  // floor cannot drift by a timezone the way a parsed instant could.
  const moneyCovered = moneyStartLocal < range.endLocalExclusive;
  const moneyStartUtc = moneyCovered
    ? utcInstantFromLocal(moneyStartLocal, "00:00", tz).toISOString()
    : endUtc;

  const supabase = supabaseClient ?? (await createClient());
  const [appointments, ledgers, unattributed] = await Promise.all([
    readAppointments(supabase, studio.id, startUtc, endUtc),
    moneyCovered
      ? readMoneyLedgers(supabase, studio.id, moneyStartUtc, endUtc)
      : Promise.resolve(null),
    // ISSUED UNCONDITIONALLY, and that is the point. This count is ALL-TIME, so
    // the money window's floor has no bearing on it. It used to ride inside the
    // ledger bundle, which meant a period below the floor suppressed an
    // all-time figure for a reason that had nothing to do with it — and then
    // reported the absence with a cause that said Hone could not answer this
    // yet, which is untrue in every other period. Reading it separately makes
    // the independence structural instead of a comment.
    readUnattributedChargeCount(supabase, studio.id),
  ]);

  // ONE ROW SET, TWO CENSUSES. The money census narrows the SAME rows to its own
  // window in memory rather than re-reading the table, so the two panels cannot
  // disagree about which appointments exist — and a row that arrived for one
  // cannot be missing from the other.
  const calendar = appointments.ok
    ? summarizeCalendar(appointments.rows, now)
    : unreadableCalendar(appointments.cause);

  // `ledgerOpensAt` IS A FACT, NOT A NULLABLE STRING.
  //
  // There are THREE truths here and the old shape could only carry two: a
  // successful read finding no card ledger, a successful read finding the
  // earliest instant, and a read that FAILED. Collapsing the third into `null`
  // let the failure branch below read "Hone could not look" as "the studio had
  // no prior payment", and the screen then stated the window predates the
  // owner's first payment on the strength of a read that never came back.
  const money = !moneyCovered
    ? {
        census: unreadableDeliveredMoney("records_incomplete"),
        ledgerOpensAt: unknownBecause<string | null>("records_incomplete"),
      }
    : !appointments.ok
      ? {
          census: unreadableDeliveredMoney(appointments.cause),
          ledgerOpensAt: unknownBecause<string | null>(appointments.cause),
        }
      : ledgers === null || !ledgers.ok
        ? {
            census: unreadableDeliveredMoney(ledgers?.cause ?? "unavailable"),
            ledgerOpensAt: unknownBecause<string | null>(ledgers?.cause ?? "unavailable"),
          }
        : {
            census: summarizeDeliveredMoney({
              services: ledgers.services,
              appointments: appointments.rows.filter((r) => r.starts_at >= moneyStartUtc),
              charges: ledgers.charges,
              refunds: ledgers.refunds,
              settlements: ledgers.settlements,
              customPricing: ledgers.customPricing,
              everPaidAppointmentIds: ledgers.everPaidAppointmentIds,
              todayLocal,
              snapshot: now,
              windowStartUtc: moneyStartUtc,
              windowEndUtc: endUtc,
            }),
            // KNOWN, and `null` inside it means the read succeeded and found
            // no card ledger — a different claim from the unknowns above.
            ledgerOpensAt: known<string | null>(ledgers.ledgerOpensAt),
          };

  return {
    access: "granted",
    briefing: {
      timezone: tz,
      period,
      startLocal: range.startLocal,
      endLocalInclusive: addDays(range.endLocalExclusive, -1),
      endLocalExclusive: range.endLocalExclusive,
      label: range.label,
      calendar,
      evidenceInstant: now.toISOString(),
      unattributedChargesAllTime: unattributed,
      money: moneyCovered
        ? {
            covered: true,
            startLocal: moneyStartLocal,
            narrowed: moneyStartLocal !== range.startLocal,
            opensLocal: MONEY_WINDOW_OPENS_LOCAL,
            // FIN-C11. A window reaching back before the first verified card
            // payment covers time Hone was not yet collecting, and a flat
            // figure over it reads as a quiet studio rather than as an absent
            // instrument. No ledger at all is the same statement, maximally.
            // ONLY A SUCCESSFUL READ MAY AUTHORIZE THIS. An unknown opening
            // instant yields `false` — the banner is simply not shown — rather
            // than the confident claim a failed read used to produce.
            precedesLedger:
              money.ledgerOpensAt.known &&
              (money.ledgerOpensAt.value === null ||
                moneyStartUtc < money.ledgerOpensAt.value),
            census: money.census,
          }
        : {
            covered: false,
            opensLocal: MONEY_WINDOW_OPENS_LOCAL,
            census: money.census,
          },
    },
  };
}

/**
 * ONE completeness rule for every read on this screen.
 *
 * `supabase/config.toml` sets `max_rows = 1000` and is tracked, so the Data API
 * truncates before any app-side limit is reached; comparing the returned length
 * against a LARGER app-side cap therefore proves nothing. The length is checked
 * against the exact count PostgREST reports in Content-Range, which the ceiling
 * does not bound. A MISSING count is treated exactly like a short read: no
 * count is not the same claim as a matching count.
 */
function complete<T>(
  data: unknown,
  error: unknown,
  count: number | null,
): { ok: true; rows: readonly T[] } | { ok: false; cause: "unavailable" | "not_enumerable" } {
  if (error) return { ok: false, cause: "unavailable" };
  const rows = (data ?? []) as T[];
  if (typeof count !== "number" || rows.length !== count) {
    return { ok: false, cause: "not_enumerable" };
  }
  return { ok: true, rows };
}

/**
 * The money reads.
 *
 * EVERY LEDGER READ IS MODE-SCOPED AND STATUS-SCOPED, and both are structural
 * rather than conventional. Migration 0105 permits one TEST and one LIVE
 * succeeded attempt for the same session, so an unfiltered sum counts a single
 * real-world payment twice. Willow's three test rows are also the studio's only
 * `late_cancellation_fee` and `no_show_fee` rows, so admitting them would invent
 * a fee-revenue line that has never existed in live mode. Separately, FAILED
 * rows carry a populated `amount_cents` — $600.00 of it in production — so the
 * status filter is not redundant with the mode filter.
 *
 * CHARGES AND REFUNDS ARE WINDOWED INDEPENDENTLY, on `charged_at` and
 * `refunded_at`. A refund can fall in a different period from the charge it
 * reverses; netting it against the charge's period would move money in time.
 *
 * SETTLEMENTS ARE READ LIVE-ONLY (`superseded_at IS NULL`). A superseded row is
 * a correction's predecessor, and summing it double-counts the correction.
 * They are read STUDIO-WIDE and narrowed in memory rather than by an
 * `.in(appointment_id, [...])` filter: that list is unbounded in the period
 * length, and an over-long generated URL is a live production failure mode on
 * this codebase rather than a hypothetical one. Studio-wide keeps the request
 * a constant size and lets the shared ceiling rule fail it closed instead.
 */
type MoneyLedgers =
  | {
      readonly ok: true;
      readonly services: readonly ServiceRow[];
      readonly charges: readonly ChargeRow[];
      readonly refunds: readonly RefundRow[];
      readonly settlements: readonly SettlementRow[];
      readonly customPricing: readonly CustomPricingRow[];
      readonly everPaidAppointmentIds: readonly string[];
      readonly ledgerOpensAt: string | null;
    }
  | { readonly ok: false; readonly cause: FinancialUnknownCause };

async function readMoneyLedgers(
  supabase: SupabaseClient,
  studioId: string,
  startUtc: string,
  endUtc: string,
): Promise<MoneyLedgers> {
  const livemode = inferStripeLivemode();
  const ledger = () =>
    supabase
      .from("payment_charge_attempts")
      // The refund columns ride along so a charge can be netted by ITS OWN
      // refund, whenever that refund happened. That is the service-period
      // numerator, and it must never be netted by a window instead.
      .select("appointment_id, amount_cents, refund_amount_cents, refund_status", {
        count: "exact",
      })
      .eq("studio_id", studioId)
      .eq("status", "succeeded")
      .eq("stripe_livemode", livemode);

  // PAGINATED, BECAUSE THIS READ IS THE ONE THAT CANNOT BE NARROWED.
  //
  // The defect this replaces: a single `.range(0, 999)` against a studio-wide
  // query. Past 1000 live settlement rows PostgREST returned one page while
  // `count: "exact"` reported the true total, `complete()` rejected the read,
  // and every money figure was withdrawn. Because the read is deliberately not
  // narrowed by the period — an `.in("appointment_id", [...])` list grows with
  // the period, and an over-long URL is a live failure mode here — no shorter
  // day, week or month could recover the screen. Financials disappeared
  // permanently once a studio crossed a lifetime threshold.
  //
  // `fetchAllRows` is the repository's existing page-safe read, written for the
  // same PostgREST ceiling in the studio export. It orders by the unique `id`
  // so a row cannot land on two pages or none, stops on a short page, asks once
  // more when a page comes back exactly full, fails the WHOLE read if any page
  // fails, and refuses rather than returning a capped set.
  //
  // THE EXACT COUNT IS CAPTURED FROM THE FIRST PAGE so `complete()` still
  // compares the FULL enumeration against what PostgREST says exists. A short
  // final page is not, on its own, evidence that the read was complete.
  // PAYMENT-RECORD EXISTENCE, ALL TIME — a SEPARATE authority from cash
  // movement, and the smallest read that can answer it.
  //
  // The charge reads above are windowed on `charged_at`, correctly: cash
  // movement is a statement about a period. But "No payment recorded" is an
  // EXISTENCE claim about a delivered visit, and the window is the wrong
  // instrument for it — an August 31 treatment charged on September 1 has no
  // row inside August, and reading that absence as "nobody paid" is false while
  // a succeeded payment sits in the ledger.
  //
  // The window is NOT widened to fix this. This read answers only "has this
  // visit ever acquired authoritative card-payment evidence", and it projects
  // ONE column so the answer cannot be mistaken for money.
  //
  // Mode- and status-scoped like every other ledger read: a TEST-mode row
  // cannot satisfy live evidence, and a FAILED attempt is not a payment. A
  // fully refunded payment still qualifies — it is not collected, but a payment
  // was unmistakably recorded. Studio-wide and page-safe, for the same reason
  // the settlements read is.
  let everPaidCount: number | null = null;
  const everPaidRead = fetchAllRows<{ appointment_id: string | null }>(
    async (from, to) => {
      const page = await supabase
        .from("payment_charge_attempts")
        .select("appointment_id", { count: "exact" })
        .eq("studio_id", studioId)
        .eq("status", "succeeded")
        .eq("stripe_livemode", livemode)
        .not("appointment_id", "is", null)
        .order("id")
        .range(from, to);
      if (everPaidCount === null && typeof page.count === "number") {
        everPaidCount = page.count;
      }
      return {
        data: (page.data ?? null) as Array<{ appointment_id: string | null }> | null,
        error: page.error as { message: string } | null,
      };
    },
    { pageSize: API_PAGE_SIZE },
  );

  // THE SAME CEILING, ON THE READ NEXT DOOR. Studio-wide for the identical
  // reason — an `.in("client_id", [...])` list grows with the period — and it
  // had the identical lifetime cliff: past 1000 rows the first page came back
  // while the exact count reported more, and the whole census went with it.
  // Enumerated page-safely by the same helper, on the same terms.
  let customPricingCount: number | null = null;
  const customPricingRead = fetchAllRows<CustomPricingRow>(
    async (from, to) => {
      const page = await supabase
        .from("client_pricing")
        .select("client_id, service_name, price_cents, notes, effective_from", {
          count: "exact",
        })
        .eq("studio_id", studioId)
        .order("id")
        .range(from, to);
      if (customPricingCount === null && typeof page.count === "number") {
        customPricingCount = page.count;
      }
      return {
        data: (page.data ?? null) as CustomPricingRow[] | null,
        error: page.error as { message: string } | null,
      };
    },
    { pageSize: API_PAGE_SIZE },
  );

  let settlementCount: number | null = null;
  const settlementsRead = fetchAllRows<SettlementRow>(async (from, to) => {
    const page = await supabase
      .from("appointment_settlements")
      // `quoted_amount_cents` is THE PRICE AT THE TIME. 0187 snapshots it
      // from the same authoritative resolver the card path uses, precisely
      // so this surface stops valuing past work at a mutable menu price —
      // its column comment names FIN-01A as the reason it exists.
      .select("appointment_id, method, amount_cents, quoted_amount_cents", {
        count: "exact",
      })
      .eq("studio_id", studioId)
      .is("superseded_at", null)
      .order("id")
      .range(from, to);
    if (settlementCount === null && typeof page.count === "number") {
      settlementCount = page.count;
    }
    return {
      data: (page.data ?? null) as SettlementRow[] | null,
      error: page.error as { message: string } | null,
    };
  }, { pageSize: API_PAGE_SIZE });

  const [services, charges, refunds, settlements, customPricing, opened, everPaid] =
    await Promise.all([
      supabase
        .from("services")
        // `name` and `modality` are what `isConsultationService` reads;
        // `price_cents` decides only whether there was anything to collect.
        .select("id, name, modality, price_cents", { count: "exact" })
        .eq("studio_id", studioId)
        .order("id")
        .range(0, API_PAGE_SIZE - 1),
      ledger().gte("charged_at", startUtc).lt("charged_at", endUtc).order("id").range(0, API_PAGE_SIZE - 1),
      supabase
        .from("payment_charge_attempts")
        // `charged_at` rides along ONLY so a refund reversing a charge from
        // another period can be COUNTED and published, rather than silently
        // reducing this period's figure with no explanation.
        .select("refund_amount_cents, charged_at", { count: "exact" })
        .eq("studio_id", studioId)
        .eq("status", "succeeded")
        .eq("stripe_livemode", livemode)
        .eq("refund_status", "succeeded")
        .gte("refunded_at", startUtc)
        .lt("refunded_at", endUtc)
        .order("id")
        .range(0, API_PAGE_SIZE - 1),
      settlementsRead,
      // THE PRICE A PARTICULAR CLIENT PAYS, for visits no settlement froze.
      //
      // Read STUDIO-WIDE and narrowed in memory, for the same reason the
      // settlements read is: an `.in(client_id, [...])` list grows with the
      // period and an over-long generated URL is a live production failure
      // mode on this codebase, not a hypothetical. Studio-wide keeps the
      // request a constant size and lets the shared ceiling rule fail it
      // closed instead.
      //
      // `notes` is projected because the shared resolver's input type requires
      // it. It is never read here and never rendered: it is free text a
      // practitioner wrote about ONE client, and it has no business on a
      // studio aggregate.
      customPricingRead,
      // HEAD-ONLY COUNT. These rows are succeeded and carry NO collection time,
      // so they belong to no period and cannot be windowed. FIN-C9 surfaces
      // them rather than dropping money that was actually made.
      supabase
        .from("payment_charge_attempts")
        .select("charged_at")
        .eq("studio_id", studioId)
        .eq("status", "succeeded")
        .eq("stripe_livemode", livemode)
        .not("charged_at", "is", null)
        .order("charged_at", { ascending: true })
        .limit(1),
      everPaidRead,
    ]);

  const s = complete<ServiceRow>(services.data, services.error, services.count);
  const c = complete<ChargeRow>(charges.data, charges.error, charges.count);
  const r = complete<RefundRow>(refunds.data, refunds.error, refunds.count);
  // `settlementCount` rather than a per-page count: the claim is about the
  // whole enumeration, which is the only thing that can be complete.
  const t = complete<SettlementRow>(settlements.data, settlements.error, settlementCount);
  const ep = complete<{ appointment_id: string | null }>(
    everPaid.data,
    everPaid.error,
    everPaidCount,
  );
  const cp = complete<CustomPricingRow>(
    customPricing.data,
    customPricing.error,
    customPricingCount,
  );

  // FAIL CLOSED, AND FAIL WHOLE. A money census assembled from the reads that
  // happened to succeed is the exact shape of a confident understatement, so
  // one bad read withdraws every figure with the cause that caused it.
  for (const part of [s, c, r, t, cp, ep]) {
    if (!part.ok) return { ok: false, cause: part.cause };
  }
  if (opened.error) return { ok: false, cause: "unavailable" };

  const openedRows = (opened.data ?? []) as ReadonlyArray<{ charged_at: string | null }>;

  return {
    ok: true,
    services: s.ok ? s.rows : [],
    charges: c.ok ? c.rows : [],
    refunds: r.ok ? r.rows : [],
    settlements: t.ok ? t.rows : [],
    customPricing: cp.ok ? cp.rows : [],
    everPaidAppointmentIds: ep.ok
      ? ep.rows.flatMap((row) => (row.appointment_id === null ? [] : [row.appointment_id]))
      : [],
    ledgerOpensAt: openedRows[0]?.charged_at ?? null,
  };
}

/**
 * The ALL-TIME count of succeeded card payments carrying NO collection time.
 *
 * ITS OWN READ, DELIBERATELY. These rows have `charged_at IS NULL`, so they
 * belong to no period and can be windowed by nothing: `created_at` records when
 * the ATTEMPT ROW was written, not when money moved, and windowing by it would
 * file real money into a period on a guess. Being period-independent, it must
 * not be suppressed by the money window's floor either — which is what happened
 * while it travelled inside the ledger bundle.
 *
 * A HEAD count: no rows are transferred, so there is no row ceiling to clear
 * and no completeness comparison to make. The count IS the answer.
 *
 * THE ONLY ABSENT PATH IS A FAILED READ, and `unavailable` is the true thing to
 * say about it — "a read Hone depends on did not come back". It is never
 * `not_yet_supported`: Hone supports this figure, and a sentence claiming a
 * later release would tell the owner something false about their own studio.
 */
async function readUnattributedChargeCount(
  supabase: SupabaseClient,
  studioId: string,
): Promise<Fact<number>> {
  // Spelled exactly as every other ledger read spells it, so the source guard
  // that requires BOTH filters on EVERY payment_charge_attempts read stays an
  // exact-string check rather than a pattern a new spelling could slip past.
  const livemode = inferStripeLivemode();
  const { error, count } = await supabase
    .from("payment_charge_attempts")
    .select("id", { count: "exact", head: true })
    .eq("studio_id", studioId)
    .eq("status", "succeeded")
    .eq("stripe_livemode", livemode)
    .is("charged_at", null);

  if (error || typeof count !== "number") return unknownBecause<number>("unavailable");
  return known(count);
}

/**
 * THE ONE APPOINTMENTS READ, feeding BOTH censuses.
 *
 * THREE WAYS THIS COULD OTHERWISE LIE WITH TOTAL CONFIDENCE, all closed by the
 * shared `complete` rule above:
 *
 *   * A FAILED READ. supabase-js RESOLVES with `{ data: null, error }` rather
 *     than rejecting, so a discarded error becomes an empty row set — and an
 *     empty row set on this screen reads as a studio that saw nobody.
 *
 *   * THE ROW CEILING. `supabase/config.toml` sets `max_rows = 1000` and is
 *     tracked, so the Data API truncates a response before any app-side limit
 *     is reached; comparing the returned length against a LARGER app-side cap
 *     therefore proves nothing.
 *
 *   * A COUNT THAT NEVER ARRIVED. No count is not the same as a matching count.
 *
 * Unlike the capacity loader this one RETURNS the failure instead of throwing:
 * /financials has to be able to render "Can't show this right now" as a
 * first-class state, and an exception would render the app error boundary
 * instead — which tells the owner nothing about which figure is missing.
 *
 * THE PROJECTION WIDENED IN SLICE 2 and the reason is on each column.
 * `status` and `starts_at` answer the calendar. `id` joins a visit to its
 * payments. `service_id` reaches the price that decides treatment from free
 * consultation. `ends_at` is what "delivered" is defined on — NOT `starts_at`,
 * because a visit that has begun has not yet finished. `duration_minutes` is
 * time with the client, the divisor Ruling 2 fixes. `blocked_ends_at` is chair
 * time INCLUDING buffer, and it is read rather than reconstructed from
 * `studios.buffer_minutes`: that column is a single current value, while
 * production carries per-appointment buffer snapshots of BOTH 15 and 20
 * minutes, so recomputing from the studio setting is wrong on every row that
 * was booked under the other one.
 */
async function readAppointments(
  supabase: SupabaseClient,
  studioId: string,
  startUtc: string,
  endUtc: string,
): Promise<
  | { ok: true; rows: readonly DeliveryRow[] }
  | { ok: false; cause: FinancialUnknownCause }
> {
  const { data, error, count } = await supabase
    .from("appointments")
    .select(
      // `client_id` joins a visit to the price ITS CLIENT pays. It is grouped
      // in memory and discarded; nothing derived from it reaches the census,
      // and the source guard forbids it reaching a component.
      "id, client_id, service_id, status, starts_at, ends_at, duration_minutes, blocked_ends_at",
      { count: "exact" },
    )
    .eq("studio_id", studioId)
    // Windowed on starts_at: the calendar's value belongs to when the work was
    // scheduled. created_at is when the row was written, which straddles local
    // midnight and would place a late booking in the wrong period.
    .gte("starts_at", startUtc)
    .lt("starts_at", endUtc)
    .order("id")
    .range(0, API_PAGE_SIZE - 1);

  const rows = complete<DeliveryRow>(data, error, count);
  return rows.ok ? { ok: true, rows: rows.rows } : { ok: false, cause: rows.cause };
}
