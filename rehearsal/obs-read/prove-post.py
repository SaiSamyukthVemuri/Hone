import csv, sys
rows = list(csv.DictReader(sys.stdin)); mode = sys.argv[1]
assert len(rows) == 2 and [r["studio_ordinal"] for r in rows] == ["1", "7"], rows
assert all(r["at_hosted_0246"] == "1" and r["studios_total"] == "7" for r in rows)
assert not any(k.endswith("_id") or k in ("id", "country", "currency") for k in rows[0]), "an identifier or value column was returned"
cols = ("bound_live_rows", "observed", "observed_country_ca", "observed_currency_cad", "conflict_recorded", "jurisdiction_row_exists")
got = {r["studio_ordinal"]: tuple(int(r[c]) for c in cols) for r in rows}
exp = {"observed-ca-and-unobserved": {"1": (1, 1, 1, 1, 0, 1), "7": (1, 0, 0, 0, 0, 0)},
       "non-ca-and-conflict": {"1": (1, 1, 0, 0, 0, 1), "7": (1, 1, 1, 1, 1, 0)}}[mode]
assert got == exp, f"got {got}, expected {exp}"
print(f"{mode}: counts as expected {got}")
