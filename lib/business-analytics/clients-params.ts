import { CLIENT_CHIPS, CLIENT_SORTS, DEFAULT_CLIENT_CHIP, DEFAULT_CLIENT_SORT, MAX_CLIENTS_PAGE, type ClientChip, type ClientSort } from "./clients-table";
import type { RawParams } from "./overview-params";

// ===========================================================================
// The Clients tab's query parameters: sort, chip, page. PURE.
// ===========================================================================
//
// Every one is untrusted input parsed to a closed vocabulary or a bounded whole number. They carry NO personal data (a client's name is never in the
// address: there is deliberately no search parameter, because an address reaches browser history, referrer headers and request logs). A page
// (strict = false) falls back to the default for a bad value and says so; a route that must say what it was asked for (strict = true) refuses it. A
// repeated key is a bad value.

export type ClientsParams = { sort: ClientSort; chip: ClientChip; page: number };
export type ClientsParamsResult = { ok: true; params: ClientsParams; notices: string[] } | { ok: false; error: "bad_request" };

const one = (raw: RawParams, key: string): { present: boolean; value: string | undefined; repeated: boolean } => {
  const v = raw[key];
  if (v === undefined) return { present: false, value: undefined, repeated: false };
  if (typeof v === "string") return { present: true, value: v, repeated: false };
  return { present: true, value: v[0], repeated: v.length !== 1 };
};

export function parseClientsParams(raw: RawParams, opts: { strict: boolean }): ClientsParamsResult {
  const notices: string[] = [];
  let bad = false;
  const fallback = (what: string) => {
    bad = true;
    notices.push(`The ${what} in the address was not recognised, so the default is shown.`);
  };
  const pick = <T extends string>(key: string, allowed: readonly T[], dflt: T, what: string): T => {
    const s = one(raw, key);
    if (!s.present) return dflt;
    if (s.repeated || s.value === undefined || !(allowed as readonly string[]).includes(s.value)) {
      fallback(what);
      return dflt;
    }
    return s.value as T;
  };
  const sort = pick<ClientSort>("sort", CLIENT_SORTS, DEFAULT_CLIENT_SORT, "sort order");
  const chip = pick<ClientChip>("chip", CLIENT_CHIPS, DEFAULT_CLIENT_CHIP, "filter");
  let page = 1;
  const p = one(raw, "page");
  if (p.present) {
    if (p.repeated || p.value === undefined || !/^[1-9][0-9]{0,4}$/.test(p.value) || Number(p.value) > MAX_CLIENTS_PAGE) fallback("page");
    else page = Number(p.value);
  }
  if (bad && opts.strict) return { ok: false, error: "bad_request" };
  return { ok: true, params: { sort, chip, page }, notices };
}

/** The query for a link on the Clients tab: the Overview's query (period, team member) plus sort, chip and page, defaults left out. Carries no personal data. */
export function clientsQuery(base: string, params: ClientsParams, patch: Partial<ClientsParams> = {}): string {
  const p = { ...params, ...patch };
  const q = new URLSearchParams(base.startsWith("?") ? base.slice(1) : base);
  q.delete("sort");
  q.delete("chip");
  q.delete("page");
  if (p.sort !== DEFAULT_CLIENT_SORT) q.set("sort", p.sort);
  if (p.chip !== DEFAULT_CLIENT_CHIP) q.set("chip", p.chip);
  if (p.page > 1) q.set("page", String(p.page));
  const s = q.toString();
  return s ? `?${s}` : "";
}
