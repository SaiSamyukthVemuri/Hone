import csv, sys
rows = list(csv.DictReader(sys.stdin)); mode = sys.argv[1]
assert len(rows) == 17, f"expected 17 rows, got {len(rows)}"
assert all(r["at_hosted_0246"] == "1" for r in rows)
assert set(rows[0]) == {"at_hosted_0246", "src", "state", "rows_in_lookback"}, "unexpected columns (an id or amount?)"
got = {(r["src"], r["state"]): int(r["rows_in_lookback"]) for r in rows}
assert len(got) == 17
exp = {k: 0 for k in got}
if mode == "seeded":
    exp.update({("payment_charge_attempts", "pending_stripe"): 1, ("payment_charge_attempts", "pending_stripe_with_payment_intent"): 1,
                ("pending_booking_payment_sessions", "card_setup_not_finalized"): 1,
                ("stripe_events", "received_total_informational"): 4, ("stripe_events", "received_not_processed"): 3,
                ("stripe_events", "received_not_processed_claimed_retained"): 2, ("stripe_events", "received_not_processed_with_error"): 2,
                ("stripe_events", "received_not_processed_setup_intent"): 1, ("stripe_events", "received_not_processed_payment_intent_or_charge"): 1})
bad = {k: (got[k], exp[k]) for k in got if got[k] != exp[k]}
assert not bad, f"count mismatch (got, expected): {bad}"
print(f"{mode}: 17 rows, every count as expected")
