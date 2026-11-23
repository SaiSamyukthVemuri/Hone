// The receptionist desk is SHIPPED DARK (the default-off rule for a new identity-adjacent capability). Nothing
// under /desk is carved out of the practitioner gate unless this environment variable is exactly "true". Absent,
// empty or any other value is OFF. It is read at request time, never cached, never derived from the database.
//
// Pure: no I/O, importable from the middleware.

export const DESK_FLAG_ENV = "HONE_RECEPTIONIST_DESK_ENABLED";

export function isDeskEnabled(): boolean {
  return process.env[DESK_FLAG_ENV] === "true";
}

/** True for /desk and anything below it, and for nothing else (/deskx and /desks are not desk paths). */
export function isDeskPath(pathname: string): boolean {
  return pathname === "/desk" || pathname.startsWith("/desk/");
}
