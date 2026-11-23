// The receptionist desk is SHIPPED DARK (the default-off rule for a new identity-adjacent capability). Nothing
// under /desk is carved out of the practitioner gate unless this environment variable is exactly "true". Absent,
// empty or any other value is OFF. It is read at request time, never cached, never derived from the database.
//
// BEFORE THE FLAG IS TURNED ON (checklist): a receptionist on the books of TWO OR MORE studios with no valid studio
// selection is sent to /desk/choose (the receptionist chooser). It lists only that user's active receptionist studios,
// by position and the display name each studio gave them, because a receptionist cannot read a studio's name. Showing
// real studio names needs a database change and is not done here. THEREFORE: before the flag is enabled for any
// receptionist who is on the books of two or more studios, either the chooser must show real studio names (that
// database change) or that receptionist must not be enabled: two studios that gave the same display name are
// indistinguishable on that page. The selected-studio cookie is shared with the practitioner chooser, so a person who is
// a practitioner in two or more studios and a receptionist elsewhere sees the practitioner chooser again after picking
// a desk studio.
//
// OPERATIONS: the value is read from the process environment, which a hosted deployment fixes when it is built and
// started. Changing the variable there takes effect only after a redeploy, so an emergency OFF is a redeploy.
//
// Pure: no I/O, importable from the middleware.

export const DESK_FLAG_ENV = "HONE_RECEPTIONIST_DESK_ENABLED";

export function isDeskEnabled(): boolean {
  return process.env[DESK_FLAG_ENV] === "true";
}

/**
 * True for /desk and anything below it, and for nothing else. Matching is case sensitive (/DESK is not a desk path and
 * stays behind the practitioner gate). A path that carries an encoded slash or backslash (%2f, %5c, any case) or a ".."
 * segment is never a desk path, so a crafted path cannot be read as /desk by the exemption and as something else by
 * the router: it stays behind the gate.
 */
export function isDeskPath(pathname: string): boolean {
  if (/%2f|%5c/i.test(pathname)) return false;
  if (pathname.split("/").includes("..")) return false;
  return pathname === "/desk" || pathname.startsWith("/desk/");
}
