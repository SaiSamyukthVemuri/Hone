# Blank pulse count: reader census and exactly what changes

Applies to the migration in `pulse-count-null.sql` (provisional, unnumbered). It drops NOT NULL and the default 1 on `electrolysis_entries.pulse_count`, stops `write_electrolysis_entry` from turning a missing count into 1, and stops `copy_session_setup` doing the same. It is global (every studio), not behind the rollout: the owner's rule that an untouched default must never become a recorded observation is not specific to the new machines.

## What changes for a studio with the rollout Off (b)
Existing rows are untouched (they keep their stored 1). For new rows:
- Every application write path that creates or updates an entry sends a count of at least 1 (`clampPulseCount` / `clampedPulseCount` return the default 1 for a blank), so a fresh Thermolysis block saved with the form untouched still stores an explicit 1. Pinned by `tests/lib/sessions/pulse-count-null-readers.test.ts`. The two commands that send `null` create no entry (`p_with_entry` false).
- The one path whose stored value does change: whole-session copy (`copy_session_setup`). It copies the reviewed draft's count; a draft whose pulse count the practitioner blanked used to be stored as 1 and is now stored as blank.
- Direct database writers that omit the count (none in the application) now store blank instead of 1.

## Cannot clear a saved count (c)
The update path keeps `coalesce(p_pulse_count, e.pulse_count)`, so sending no count leaves the stored value alone. A saved count therefore cannot be cleared back to blank; a blank only exists for a count never entered. The edit forms show the default for a blank row, so re-saving such a row stores the default: that is a touched count.

## Reader census (every consumer of the column)
| Reader | NULL behaviour | Evidence |
|---|---|---|
| Saved-entry row (`components/entry-row.tsx`) | count and delay shown only when the count is present | source contract test |
| Clinical summary and point-of-care memory (`lib/sessions/point-of-care-memory.ts`) | read through the nullable number reader; blank shows nothing | source contract test |
| Copy from last visit (`lib/sessions/treatment-setup-snapshot.ts`) | blank copies as blank, delay blank | unit test |
| Whole-session copy (`whole-session-copy-normalize.ts`, `whole-session-copy-actions.ts`) | a blank count normalises to null and is passed as null | read; stored blank per (b) |
| Appointment prep memory and last-treatment loader | select the column and hand it to the readers above | read |
| Export (`app/(app)/settings/data/actions.ts`, resource registry) | the column is exported as is; a blank exports as an empty cell | read |
| Reading-history trigger | numeric fields are generic; a NULL is a recorded blank | DB test (history trigger accepts NULL) |
| Edit forms (`log-electrolysis-entry-form`, `block-setup-form`) | fall back to the default count for a blank row | source contract test |
| Client page and block views | go through the rows above | read |
| Generated database type (`lib/types/database.ts`) | now `number | null`; the whole project typechecks | `tsc --noEmit` clean |
