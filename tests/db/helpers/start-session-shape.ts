// Which start_session does this database run? Classified from the function's
// own source, never from filenames. No imports: the unit lane loads this file
// to pin the detector on both shapes without pulling in the DB harness.
//
//   "0181"  the coalesce lookup keys on studio, client, practitioner, modality
//           and the time window only, so a start for appointment B inside A's
//           window is handed A's chart (CLN-002).
//   "0241"  the coalesce lookup also keys on appointment identity: it prefers
//           the exact appointment, may take a NULL-linked chart, and excludes a
//           chart linked to a different appointment.
//
// The discriminator is the ONE coalesce lookup statement
// (`select s.id, s.appointment_id into v_session_id, v_existing_appt ...`), not
// a substring of the whole body: 0181 also contains `s.appointment_id is null`
// and `appointment_id = p_appointment_id` (in its NULL-promotion UPDATE), so
// matching those anywhere in the body would misread 0181 as 0241.
//
// Anything that is not exactly one lookup statement carrying exactly one of the
// two shapes THROWS. A third shape (a later migration redefining start_session)
// must fail loudly rather than be read as one of these.

export type StartSessionShape = "0181" | "0241";

/** Drop `--` comment text and collapse whitespace, so SQL formatting and
 *  prose cannot decide the shape. A predicate that only appears in a comment
 *  does not count. */
export function normalizeSql(sql: string): string {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const LOOKUP_RE =
  /select s\.id, s\.appointment_id into v_session_id, v_existing_appt from public\.sessions s where (.*?) limit 1 for update;/g;

export function classifyStartSessionSource(prosrc: string): StartSessionShape {
  const code = normalizeSql(prosrc);
  if (code.length === 0) throw new Error("start_session source is empty");
  const lookups = [...code.matchAll(LOOKUP_RE)];
  if (lookups.length !== 1) {
    throw new Error(`expected exactly one coalesce lookup statement, found ${lookups.length}`);
  }
  const where = lookups[0][1];
  // The conditions common to both shapes: if any is missing this is not a
  // start_session lookup this detector understands.
  for (const common of [
    "s.studio_id = v_studio_id",
    "s.client_id = p_client_id",
    "s.practitioner_id = v_practitioner",
    "s.modality = p_modality",
    "s.deleted_at is null",
    "s.started_at >= (now() - make_interval(mins => coalesce(p_coalesce_minutes, 90)))",
  ]) {
    if (!where.includes(common)) throw new Error(`coalesce lookup lacks the common condition: ${common}`);
  }
  const identity = where.includes("s.appointment_id = p_appointment_id");
  const nullEligible = where.includes("s.appointment_id is null");
  if (identity !== nullEligible) {
    throw new Error("coalesce lookup carries half of the appointment-identity predicate");
  }
  if (identity) {
    if (!where.includes("p_appointment_id is null or s.appointment_id = p_appointment_id or s.appointment_id is null")) {
      throw new Error("coalesce lookup identity predicate is not the 0241 shape");
    }
    return "0241";
  }
  if (!where.endsWith("order by s.started_at desc")) {
    throw new Error("coalesce lookup is not the 0181 shape");
  }
  return "0181";
}

/** Reconcile the two signals the DB gives: the function source and the
 *  recorded migrations. A contradiction is ambiguity, and ambiguity throws. */
export function resolveStartSessionShape(args: {
  prosrc: string;
  migrationsRecorded: readonly string[];
}): StartSessionShape {
  const fromSource = classifyStartSessionSource(args.prosrc);
  const recorded = args.migrationsRecorded.includes("0241");
  const fromHistory: StartSessionShape = recorded ? "0241" : "0181";
  if (fromSource !== fromHistory) {
    throw new Error(
      `start_session source reads as ${fromSource} but migration 0241 is ${recorded ? "recorded" : "not recorded"}`,
    );
  }
  return fromSource;
}
