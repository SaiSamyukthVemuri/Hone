// PR #316 (Chloe record-keeping feedback): sterile-item / probe-lot expiry
// state. Pure + deterministic (today is passed in, never read from the clock
// here) so it can be unit-tested and shared by the Records page (row styling +
// summary banner) and the dashboard "Supplies expiring" attention card.
//
// Display-only over the EXISTING expiry_date column — no schema/RLS change.

// A sterile item counts as "expiring soon" when its expiry date is within this
// many days of today (inclusive). Expired = strictly before today.
export const SUPPLY_EXPIRING_WITHIN_DAYS = 30;

// PR #317: "today" is split out from "expiring" so the UI/print can show an
// action-oriented "Expires today" (parity with the disinfectant due_today
// tier). It still counts as "within 30 days" for the summary banner.
export type SupplyExpiryState = "expired" | "today" | "expiring" | "neutral";

// expiryDate / today are date-only "YYYY-MM-DD" strings (the column type is
// `date`). A null/blank expiry is always neutral (no expiry recorded).
export function supplyExpiryState(
  expiryDate: string | null | undefined,
  todayIso: string,
): SupplyExpiryState {
  if (!expiryDate) return "neutral";
  const exp = expiryDate.slice(0, 10);
  const today = todayIso.slice(0, 10);
  if (exp < today) return "expired"; // lexicographic works for YYYY-MM-DD
  if (exp === today) return "today";
  const dExp = Date.parse(`${exp}T00:00:00Z`);
  const dToday = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(dExp) || Number.isNaN(dToday)) return "neutral";
  const days = Math.round((dExp - dToday) / 86_400_000);
  return days <= SUPPLY_EXPIRING_WITHIN_DAYS ? "expiring" : "neutral";
}

// Short, action-oriented label for a state (null = no badge/marker). Used by the
// Records badges, the dashboard card, and (lowercased) the print marker — one
// source of truth so the surfaces never drift.
export function supplyExpiryLabel(state: SupplyExpiryState): string | null {
  switch (state) {
    case "expired":
      return "Expired";
    case "today":
      return "Expires today";
    case "expiring":
      return "Expires soon";
    default:
      return null;
  }
}

// Plain-text, print-safe suffix for a date line, e.g. " (expired)" /
// " (expires today)" / " (expires soon)"; "" when neutral. No color reliance.
export function supplyExpiryPrintMarker(
  expiryDate: string | null | undefined,
  todayIso: string,
): string {
  const label = supplyExpiryLabel(supplyExpiryState(expiryDate, todayIso));
  return label ? ` (${label.toLowerCase()})` : "";
}

// Counts for the Records summary banner + the dashboard card.
export function summarizeSupplyExpiry(
  items: ReadonlyArray<{ expiry_date: string | null }>,
  todayIso: string,
): { expired: number; expiring: number } {
  let expired = 0;
  let expiring = 0;
  for (const it of items) {
    const s = supplyExpiryState(it.expiry_date, todayIso);
    // "today" counts toward "expiring within 30 days" for the banner (it IS
    // within 30 days and not yet expired); the badge/print show it distinctly.
    if (s === "expired") expired += 1;
    else if (s === "today" || s === "expiring") expiring += 1;
  }
  return { expired, expiring };
}

// Inclusive upper-bound date ("YYYY-MM-DD") for a studio-scoped query that
// wants "expired OR expiring within N days": expiry_date <= today + N.
export function supplyExpiryHorizon(
  todayIso: string,
  withinDays: number = SUPPLY_EXPIRING_WITHIN_DAYS,
): string {
  const dToday = Date.parse(`${todayIso.slice(0, 10)}T00:00:00Z`);
  return new Date(dToday + withinDays * 86_400_000).toISOString().slice(0, 10);
}
