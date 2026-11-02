// The receptionist desk is SHIPPED DARK (Privacy R3, the G4 default-off rule for a new
// identity-adjacent capability). Nothing under app/(desk)/** serves, the middleware does not
// carve /desk out of the practitioner gate, and the sign-in landing does not route anyone to
// /desk, unless this environment variable is exactly "true". Absent, empty or any other value is
// OFF. It is read at request time, never cached, never derived from the database.
//
// Even with the flag on, the desk answers nobody until migrations 0266 and 0274 are applied (the
// RPCs it calls do not exist before) and an active receptionist membership exists. Both are held
// until Sam approves each change.
//
// Pure: no I/O, importable from the middleware.

export const DESK_FLAG_ENV = "HONE_RECEPTIONIST_DESK_ENABLED";

export function isDeskEnabled(): boolean {
  return process.env[DESK_FLAG_ENV] === "true";
}

/** True for /desk and anything below it. */
export function isDeskPath(pathname: string): boolean {
  return pathname === "/desk" || pathname.startsWith("/desk/");
}
