import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

// Shared pieces for the integrated multi-staff proof (photos/MULTISTAFF-PROOF-PLAN.md). Plan-stage helper: nothing here
// has been run against a candidate. Sentinels follow privacy/RBAC-FORBIDDEN-DATA-MARKERS.md (alphanumeric, one per field,
// class code in the name) and section 8 of that file (Sam's decisions of 1 Nov). Synthetic values only.

export type Role =
  | "anonymous" | "A-receptionist" | "A-prac1" | "A-prac2" | "A-owner"
  | "B-owner" | "B-prac" | "B-receptionist" | "removed-prac" | "removed-receptionist";

export type Cell = {
  surface: string;           // route, handler, server action, RPC or table
  kind: "route" | "api" | "action" | "rpc" | "table";
  role: Role;
  observed: "allow" | "refused-in-place" | "redirect" | "401" | "403" | "404" | "empty" | "42501" | "other";
  status: number | null;
  sentinelHits: string[];    // names of forbidden sentinels found in ANY captured channel
  controlOwnerHasSentinels: boolean | null; // owner positive control for the same surface (null = not applicable)
  expected: "allow" | "deny" | "UNSPECIFIED";
  evidence?: string;
};

export const SENTINELS = {
  // class codes follow the Privacy marker document; one alphanumeric sentinel per forbidden field
  LEGAL: ["RBACZZLEGAL01", "RBACZZLEGAL02"],
  STORED: ["RBACZZSTORED01"],        // stored name of a client who HAS a preferred name
  DOB: ["RBACZZDOB01"], ADDR: ["RBACZZADDR01"], PRON: ["RBACZZPRON01"],
  CLIN: ["RBACZZCLIN01"], ALLERGY: ["RBACZZALLERGY01"], INTAKE: ["RBACZZINTAKE01"], CONSENT: ["RBACZZCONSENT01"],
  PHOTO: ["RBACZZPHOTO01"], IDPHOTO: ["RBACZZIDPHOTO01"],
  NOTE: ["RBACZZNOTE01", "RBACZZREASON01"],
  FIN_TEXT: ["RBACZZCHG01", "RBACZZUNPUB01"],
  CARD: ["RBACZZCARD01"], ADMIN: ["RBACZZADMIN01"], TOKEN: ["RBACZZTOKEN01"], XSTUDIO: ["RBACZZXSTUDIO01"],
} as const;

// Numeric sentinels (cents) from section 8.3: the value in every display form must be absent for the denied role.
export const NUMERIC_CENTS = { unpublishedServicePrice: 876543, clientPricingOverride: 765432, pricePaid: 654321, charge: 543210, settlement: 432109, fee: 321098 } as const;
export const PUBLISHED_SERVICE = { name: "RBACZZPUBSVC", cents: 987654 } as const; // name+price PRESENT for a practitioner on the booking surface only

export function centsForms(cents: number): string[] {
  const d = (cents / 100).toFixed(2);                      // 9876.54
  const [whole, frac] = d.split(".");
  const grouped = Number(whole).toLocaleString("en-US");   // 9,876
  return [String(cents), d, `${grouped}.${frac}`, `$${grouped}.${frac}`, `$${d}`];
}

export function allForbiddenValues(): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  for (const [cls, vals] of Object.entries(SENTINELS)) for (const v of vals) out.push({ name: `${cls}:${v}`, value: v });
  for (const [k, c] of Object.entries(NUMERIC_CENTS)) for (const f of centsForms(c)) out.push({ name: `NUM:${k}:${f}`, value: f });
  return out;
}

// Scan every channel the browser can receive. Pass the raw bodies (HTML, RSC, action response, API JSON, headers, URL).
export function scanChannels(channels: Record<string, string>, forbidden = allForbiddenValues()): string[] {
  const hits: string[] = [];
  for (const [chan, body] of Object.entries(channels)) {
    const forms = [body, safe(() => decodeURIComponent(body)), body.replace(/\\u00([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))];
    for (const f of forbidden) if (forms.some((t) => t.includes(f.value))) hits.push(`${chan}:${f.name}`);
  }
  return hits;
}
function safe(fn: () => string): string { try { return fn(); } catch { return ""; } }

// The denial matrix: collected by every scenario, written once at the end.
export class DenialMatrix {
  cells: Cell[] = [];
  add(c: Cell) { this.cells.push(c); }
  // a refusal is only trustworthy when the same call by the permitted role contained the sentinels (non-vacuous)
  vacuous() { return this.cells.filter((c) => c.expected === "deny" && c.controlOwnerHasSentinels === false); }
  violations() { return this.cells.filter((c) => (c.expected === "deny" && (c.observed === "allow" || c.sentinelHits.length > 0)) || (c.expected === "allow" && c.observed !== "allow")); }
  write(dir: string, name = "denial-matrix.json") {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, name), JSON.stringify({ cells: this.cells, violations: this.violations(), vacuous: this.vacuous(), unspecified: this.cells.filter((c) => c.expected === "UNSPECIFIED").length }, null, 1));
  }
}

// Concurrency barrier: N callers start their request at the same instant (separate browser contexts / request contexts).
export async function raceAll<T>(calls: Array<() => Promise<T>>): Promise<T[]> {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const started = calls.map((c) => gate.then(c));
  release();
  return Promise.all(started);
}
