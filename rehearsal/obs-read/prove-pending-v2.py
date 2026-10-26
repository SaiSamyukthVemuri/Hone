import csv, sys
rows = list(csv.DictReader(sys.stdin)); mode = sys.argv[1]
assert len(rows) == 19, f"expected 19 rows, got {len(rows)}"
assert all(r["at_hosted_0246"] == "1" for r in rows)
assert set(rows[0]) == {"at_hosted_0246", "src", "state", "rows_in_lookback"}, "unexpected columns (an id or amount?)"
got = {(r["src"], r["state"]): int(r["rows_in_lookback"]) for r in rows}
assert len(got) == 19
KEYS = {
    ("payment_charge_attempts", "pending_stripe"), ("payment_charge_attempts", "pending_stripe_with_payment_intent"),
    ("payment_charge_attempts", "refund_pending_stripe"), ("payment_charge_attempts", "provider_refund_pending_or_requires_action"),
    ("manual_fee_charge_attempts", "pending_stripe"),
    ("stripe_charge_attempts", "pending_processing_or_authentication_required"),
    ("stripe_refund_attempts", "pending_processing_or_requires_action"),
    ("stripe_refunds", "pending_or_requires_action"),
    ("appointment_payments", "authentication_required_reconciliation_required_or_double_charged"),
    ("pending_booking_payment_sessions", "card_setup_not_finalized"),
    ("stripe_account_provisioning_attempts", "pending_or_processing"),
    ("stripe_customer_provisioning_attempts", "pending_or_processing"),
    ("client_payment_methods", "saved_in_lookback_informational"),
    ("stripe_events", "received_total_informational"), ("stripe_events", "received_not_processed"),
    ("stripe_events", "received_not_processed_attempted"), ("stripe_events", "received_not_processed_with_error"),
    ("stripe_events", "received_not_processed_setup_intent"), ("stripe_events", "received_not_processed_payment_intent_or_charge"),
}
assert set(got) == KEYS, f"row keys differ: extra {set(got) - KEYS}, missing {KEYS - set(got)}"
exp = {k: 0 for k in got}
if mode == "seeded":
    exp.update({
        ("payment_charge_attempts", "pending_stripe"): 2, ("payment_charge_attempts", "pending_stripe_with_payment_intent"): 2,
        ("payment_charge_attempts", "refund_pending_stripe"): 2, ("payment_charge_attempts", "provider_refund_pending_or_requires_action"): 2,
        ("manual_fee_charge_attempts", "pending_stripe"): 1,
        ("stripe_charge_attempts", "pending_processing_or_authentication_required"): 1,
        ("stripe_refund_attempts", "pending_processing_or_requires_action"): 1,
        ("stripe_refunds", "pending_or_requires_action"): 1,
        ("appointment_payments", "authentication_required_reconciliation_required_or_double_charged"): 1,
        ("pending_booking_payment_sessions", "card_setup_not_finalized"): 1,
        ("stripe_account_provisioning_attempts", "pending_or_processing"): 1,
        ("stripe_customer_provisioning_attempts", "pending_or_processing"): 1,
        ("client_payment_methods", "saved_in_lookback_informational"): 1,
        ("stripe_events", "received_total_informational"): 5, ("stripe_events", "received_not_processed"): 4,
        ("stripe_events", "received_not_processed_attempted"): 3, ("stripe_events", "received_not_processed_with_error"): 3,
        ("stripe_events", "received_not_processed_setup_intent"): 1, ("stripe_events", "received_not_processed_payment_intent_or_charge"): 2,
    })
bad = {k: (got[k], exp[k]) for k in got if got[k] != exp[k]}
assert not bad, f"count mismatch (got, expected): {bad}"
print(f"{mode}: 19 rows, every count as expected")
