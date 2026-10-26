# Row 6: the S1 read-back (window-s1read.sh)

Run this ONLY after `s1-apply.sh` has finished (or after it stopped and you need to know what state the database is in:
the read-back is valid in every case). It is read-only, makes one login per gate file through the pinned runner and
`supabase-go`, and prints one verdict. It does not promote anything. You type nothing except the access token and the
database password (hidden). It is not part of the cutover until OPS and Insurance have approved it.

## 1. Download (one line, one paste)

The line copies nine files from the VPS, checks each one's sha256 BEFORE installing any, then installs them into
`~/hone-s1/window-reads-s1/`. The comparator, its lib and the baseline stay where the S0a download put them.

    ( set -u; S=$(mktemp -d) && D=sam@100.123.145.56:/home/sam/hone-handoffs/2026-10-18/machines/window-reads-s1 && scp -q "$D/window-s1read.sh" "$D/run-window-read-macos.sh" "$D/MANIFEST.sha256" "$D/s1-history.sql" "$D/census-0213-0246.sql" "$D/s1-g10.sql" "$D/s1-closures.sql" "$D/s1-table-privileges.sql" "$D/s1-body-md5.sql" "$S/" && for p in window-s1read.sh:dc930b6a0c74ab5a50998b6667ff3839085687e404d416e28828be9d3ca7136a run-window-read-macos.sh:471ecb9d18116f9b5c898400d9dae0aa898be5aa795b2788c44eacdefeb27357 MANIFEST.sha256:7862f780cf391cc942386a85f2b31597873cd2c727a7e5cc20a22f11a732b477 s1-history.sql:485c3a544994532a94ebe409006a76bea4085a5becc07a73838456855006eb5b census-0213-0246.sql:4817b78e8d0d7d1350c5337645f275bba4c799bdeadd4a93e776783f31aa5879 s1-g10.sql:d83973b8861c8b520144fa28c23059a0e337611a091ae80c3c7f8ba19757930f s1-closures.sql:cd8bb7f481a967846512a6840bf7615e7848eeb226c61c624d4c24c8b5b8be10 s1-table-privileges.sql:6f5c0fc5ca4f5cbec20b2670cb623a94fdf1d5f0ff40584232dee7701d07fb8e s1-body-md5.sql:6a9db27fe4c8e737e72383b020ac631a3f57c9fddcaf1255b05bf81245b1a0d9; do [ "$(shasum -a 256 "$S/${p%%:*}" | cut -d" " -f1)" = "${p#*:}" ] || { echo "STOP: sha256 mismatch for ${p%%:*}"; exit 1; }; done && [ -d "$HOME/hone-s1" ] && mkdir -p "$HOME/hone-s1/window-reads-s1" && for f in window-s1read.sh run-window-read-macos.sh MANIFEST.sha256 s1-history.sql census-0213-0246.sql s1-g10.sql s1-closures.sql s1-table-privileges.sql s1-body-md5.sql; do cp "$S/$f" "$HOME/hone-s1/window-reads-s1/$f" || exit 1; done && chmod 0755 "$HOME/hone-s1/window-reads-s1/window-s1read.sh" "$HOME/hone-s1/window-reads-s1/run-window-read-macos.sh" && echo "window-s1read.sh, runner, manifest and the six S1 gate files: sha256 OK, installed" ) || echo "STOP: download, sha256 check or install failed; run nothing"

It must end with `sha256 OK, installed`. Any `STOP:` line means nothing was installed: do not run the script.

| installed file | sha256 |
|---|---|
| `window-s1read.sh` | `dc930b6a0c74ab5a50998b6667ff3839085687e404d416e28828be9d3ca7136a` |
| `run-window-read-macos.sh` | `471ecb9d18116f9b5c898400d9dae0aa898be5aa795b2788c44eacdefeb27357` |
| `MANIFEST.sha256` | `7862f780cf391cc942386a85f2b31597873cd2c727a7e5cc20a22f11a732b477` |
| `s1-history.sql` | `485c3a544994532a94ebe409006a76bea4085a5becc07a73838456855006eb5b` |
| `census-0213-0246.sql` | `4817b78e8d0d7d1350c5337645f275bba4c799bdeadd4a93e776783f31aa5879` |
| `s1-g10.sql` | `d83973b8861c8b520144fa28c23059a0e337611a091ae80c3c7f8ba19757930f` |
| `s1-closures.sql` | `cd8bb7f481a967846512a6840bf7615e7848eeb226c61c624d4c24c8b5b8be10` |
| `s1-table-privileges.sql` | `6f5c0fc5ca4f5cbec20b2670cb623a94fdf1d5f0ff40584232dee7701d07fb8e` |
| `s1-body-md5.sql` | `6a9db27fe4c8e737e72383b020ac631a3f57c9fddcaf1255b05bf81245b1a0d9` |

## 2. Run

    bash ~/hone-s1/window-reads-s1/window-s1read.sh

It refuses before any hosted read unless this Mac, the tools, the nine files and the comparator match their pins and your
environment holds none of the variables the runner refuses. It prints the start time: record it and the end time (the gap
read must run within 24 h of S1).

It reads six files, one at a time, history first:

1. `s1-history.sql`: 245 rows, max 0246, 0213..0246 once each, nothing above. **If this is not exactly that, nothing else is read**
   and the script stops with "Do NOT promote".
2. `census-0213-0246.sql`: the object census (the same bytes as the S0a census, which has no chain guard on purpose).
3. `s1-g10.sql`: the seven constraints (the S0a G10 file with its guard changed from max 0212 to max 0246).
4. `s1-closures.sql`: EXECUTE for anon, authenticated and service_role on exactly the five functions in the baseline's s1.closures.
5. `s1-table-privileges.sql`: INSERT on audit_logs for authenticated (must be false) and service_role (must be true).
6. `s1-body-md5.sql`: md5 of the five replaced function bodies (only the hash leaves the database).

Files 3 to 6 carry their own chain guard: if the history max is not 0246 they fail with `division by zero` and the script stops.
It then assembles the `--readback` JSON from those results (refusing if the names read differ from the baseline's, if a flag is not
a boolean, or if a replaced function has two overloads) and runs `compare-preflight.mjs --stage s1`.

## 3. What the end means

- `OVERALL PASS` and the line `WINDOW S1 READ-BACK: OVERALL PASS` (exit 0): S1 reached its end state. Row 7 may start.
- Anything else: STOP. Do not promote. Do not run it again until OPS has read the verdict. The work directory
  (`~/hone-s1/s1readXXXXXX`) keeps the results, the assembled read-back and the verdict.
- A failed login writes `~/hone-s1/s1-read/FAILED-LOGIN` and every later run refuses until Sam decides. Do not retry, do not reset the
  password, do not unban.
- This script never creates a login role, resets a password or unbans an address; it only detects those paths and stops.
