// REHEARSAL - NEVER MERGE. Synthetic results for the six S1 read-back files (names, flags, md5 and counts only), built from the
// baseline and the census file, in the shape the hosted `db query --linked -o json` returns.
// usage: node gen-s1-results.mjs <out-dir> <baseline.json> <census.sql> <scenario>   scenario: ok | at0212 | closure_bad | body_bad
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const [out, basePath, censusPath, scenario = "ok"] = process.argv.slice(2);
const base = JSON.parse(readFileSync(basePath, "utf8")).s1;
const census = [...readFileSync(censusPath, "utf8").matchAll(/select '(\d{4})' as version, (\d+) as objects_checked/g)].map((m) => ({ version: m[1], objects_checked: Number(m[2]) }));
if (census.length !== 34) { console.error(`census parse: ${census.length}`); process.exit(1); }
const w = (stem, rows) => writeFileSync(`${out}/${stem}.json`, JSON.stringify(rows));
mkdirSync(out, { recursive: true });
const at0212 = scenario === "at0212";
w("s1-history", [at0212 ? { applied_count: 211, hosted_max: "0212", distinct_versions_ge_0213: 0, versions_ge_0213: 0, versions_0213_0246_once_each: 0, versions_above_0246: 0 } : { applied_count: 245, hosted_max: "0246", distinct_versions_ge_0213: 34, versions_ge_0213: 34, versions_0213_0246_once_each: 34, versions_above_0246: 0 }]);
w("census-0213-0246", census.map((r) => ({ ...r, present_now: at0212 ? 0 : r.objects_checked })));
const g10 = [["0214", "payment_charge_attempts", "payment_charge_attempts_currency_check"], ["0214", "appointment_settlements", "appointment_settlements_currency_check"], ["0218", "pending_invitations", "pending_invitations_role_check"], ["0220", "appointments", "appointments_cancelled_by_check"], ["0220", "appointment_audit", "appointment_audit_actor_type_check"], ["0220", "appointment_audit", "appointment_audit_actor_id_type_ck"], ["0221", "email_outbound_messages", "email_outbound_messages_purpose_ck"]];
w("s1-g10", g10.map(([migration, table_name, constraint_name]) => ({ at_hosted_0246: 1, migration, table_name, constraint_name, present: true, present_total: 7, hosted_definition: "CHECK (synthetic)", other_checks_on_key_column: 0 })));
const cl = base.closures.map((c) => ({ at_hosted_0246: 1, fn: c.fn, args: "p_x uuid", anon: c.anon, authenticated: c.authenticated, service_role: c.service_role }));
if (scenario === "closure_bad") cl.find((r) => r.fn === "studio_named_stripe_accounts").authenticated = true;
w("s1-closures", cl);
w("s1-table-privileges", base.table_privileges.map((t) => ({ at_hosted_0246: 1, table_name: t.table, role_name: t.role, privilege: t.privilege, held: t.held })));
const bm = Object.entries(base.body_md5).map(([fn, md5]) => ({ at_hosted_0246: 1, fn, args: "p_x uuid", body_md5: md5 }));
if (scenario === "body_bad") bm.find((r) => r.fn === "claim_email_provider_events").body_md5 = "00000000000000000000000000000000";
w("s1-body-md5", bm);
if (at0212) for (const s of ["s1-g10", "s1-closures", "s1-table-privileges", "s1-body-md5"]) writeFileSync(`${out}/${s}.error`, "ERROR: division by zero (SQLSTATE 22012)\n");
