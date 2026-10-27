// Writes the synthetic window results (bare JSON arrays, as the real CLI prints them) for the 14 gate files.
// Correct per the gate headers and per the baseline given as argv[3]; argv[2] = output dir; argv[4] (optional) = a mutation name.
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const [, , outDir, baselinePath, mutation, wrDir] = process.argv;
const HERE = path.resolve(wrDir);
const LIB = pathToFileURL(path.join(HERE, "compare-preflight-lib.mjs")).href;
let src = readFileSync(path.join(HERE, "compare-preflight.test.mjs"), "utf8");
src = src.replace('import { test } from "node:test";', "const test = () => {};")
  .replace('"./compare-preflight-lib.mjs"', JSON.stringify(LIB))
  .replace("const HERE = path.dirname(fileURLToPath(import.meta.url));", `const HERE = ${JSON.stringify(HERE)};`)
  + "\nexport { goodResults };\n";
const tmp = mkdtempSync(path.join(tmpdir(), "gen-results-"));
writeFileSync(path.join(tmp, "fx.mjs"), src);
const { goodResults } = await import(pathToFileURL(path.join(tmp, "fx.mjs")).href);
const cand = JSON.parse(readFileSync(baselinePath, "utf8"));
const f = goodResults();
const J = (rows) => JSON.stringify({ rows });
const ords = Object.keys(cand.g09.per_ordinal).map(Number);
const money = (e) => (e.money ? 1 : 0);
f["g09a-0214-reach-summary"] = J([{ at_hosted_0212: 1, studios: cand.g09.studios, reachable_by_setter: cand.g09.reachable_by_setter, refused_account: cand.g09.refused_account, refused_money_only: cand.g09.refused_money_only }]);
f["g09b-0214-reach-per-studio"] = J(ords.map((o) => { const e = cand.g09.per_ordinal[o]; return { at_hosted_0212: 1, studio_ordinal: o, r2a_reachable: e.r2a_reachable, needs_ack_prices: e.needs_ack_prices, charge_attempt_rows: money(e), settlement_rows: 0, manual_fee_rows: 0, appointment_payment_rows: 0, stripe_charge_rows: 0, pending_booking_payment_rows: 0, acct_provisioning_rows: 0, bound_account_rows: e.bound_live + e.bound_test, saved_card_rows: e.acct && !(e.bound_live + e.bound_test) ? 1 : 0, stripe_customer_rows: 0 }; }));
f["g09c-0214-bound-account-mode"] = J(ords.map((o) => { const e = cand.g09.per_ordinal[o]; return { at_hosted_0212: 1, studio_ordinal: o, present: true, bound_live: e.bound_live, bound_test: e.bound_test, bound_unknown_mode: 0, observed_country_column_present: false }; }));
const mut = (k, fn) => { const j = JSON.parse(f[k]); fn(j.rows); f[k] = J(j.rows); };
if (mutation === "wrong-count") mut("g09a-0214-reach-summary", (r) => { r[0].reachable_by_setter += 1; });
if (mutation === "g02-0213") mut("g02-history", (r) => { r[0].hosted_max = "0213"; });
const files = ["g02-history", "census-0213-0246", "g06-payment-drain", "g07-sms-claimed-number-duplicates", "g09a-0214-reach-summary", "g09b-0214-reach-per-studio", "g09c-0214-bound-account-mode", "g10-constraint-names", "g11-0244-legacy-laser-types", "g11b-0244-legacy-laser-classes", "g12-0243-intake-definers", "s1-open-transactions", "w03-table-sizes"];
for (const n of files) writeFileSync(path.join(outDir, `${n}.json`), JSON.stringify(JSON.parse(f[n]).rows, null, 2) + "\n");
writeFileSync(path.join(outDir, "g09d-0214-currency-history.json"), JSON.stringify([{ at_hosted_0212: 1, studio_ordinal: 1, synthetic: true }], null, 2) + "\n");
