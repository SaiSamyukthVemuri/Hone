import csv, io, sys
rows = list(csv.DictReader(sys.stdin))
mode = sys.argv[1]
assert len(rows) == 26, f"expected 26 rows, got {len(rows)}"
assert all(r["at_hosted_0212"] == "1" and r["studios_total"] == "7" for r in rows)
assert sorted({r["studio_ordinal"] for r in rows}) == ["1", "7"]
assert len({r["src"] for r in rows}) == 13
assert not any(k for k in rows[0] if "id" == k or k.endswith("_id")), "an identifier column was returned"
got = {(r["studio_ordinal"], r["src"]): tuple(int(r[k]) for k in ("live_named_rows", "live_rows_without_account", "live_rows_on_an_unbound_account", "live_rows_on_a_bound_account")) for r in rows}
exp = {k: (0, 0, 0, 0) for k in got}
if mode == "dirty":
    exp.update({("1", "provisioning_attempts"): (2, 1, 0, 1), ("1", "payment_charge_attempts"): (1, 0, 0, 1), ("1", "studio_payment_settings"): (1, 0, 0, 1),
                ("7", "provisioning_attempts"): (1, 0, 1, 0), ("7", "payment_charge_attempts"): (1, 0, 0, 1), ("7", "client_stripe_customers"): (1, 0, 1, 0), ("7", "studio_payment_settings"): (1, 0, 0, 1)})
else:
    exp.update({("1", "provisioning_attempts"): (1, 0, 0, 1), ("1", "payment_charge_attempts"): (1, 0, 0, 1), ("1", "studio_payment_settings"): (1, 0, 0, 1),
                ("7", "payment_charge_attempts"): (1, 0, 0, 1), ("7", "studio_payment_settings"): (1, 0, 0, 1)})
bad = {k: (got[k], exp[k]) for k in got if got[k] != exp[k]}
assert not bad, f"count mismatch (got, expected): {bad}"
print(f"{mode}: 26 rows, every count as expected")
