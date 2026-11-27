"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/admin";
import {
  disableFrontDeskForStudio, enableFrontDeskForStudio, grantAlreadyMade, grantFrontDeskSeats, revokeFrontDeskSeats, REASON_MAX, SEAT_SOURCES, setFrontDeskKeyPilot,
  type SeatSource,
} from "@/lib/rollouts/front-desk-admin";

// Platform-admin controls for the Front Desk: the per-studio switch and the receptionist seat grants (0390). EVERY action re-checks isAdmin (the
// layout is not the gate), takes the actor from the AUTHENTICATED SESSION and never from the form, and reads ONLY the named fields below. A reason is
// required, is stored on the grant only, and is never logged or echoed back. Nothing here creates a receptionist, an invitation or a client record.

export type FrontDeskActionResult = { ok: boolean; message: string };

// REFUSED = the database rejected it and rolled back. UNKNOWN = the answer did not come back and it may have committed. Never blurred.
const REFUSED = "That was refused. Nothing changed.";
const UNKNOWN = "The result is UNKNOWN: the change may or may not have been saved. Reload this page and check before trying again.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Actor = { userId: string; email: string };
async function authorize(): Promise<{ actor: Actor } | { refusal: FrontDeskActionResult }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !user.email || !isAdmin(user.email)) return { refusal: { ok: false, message: "Not authorized." } };
  return { actor: { userId: user.id, email: user.email } };
}

const studioIdOf = (fd: FormData): string | null => {
  const v = fd.get("studioId");
  return typeof v === "string" && UUID.test(v) ? v.toLowerCase() : null;
};
const reasonOf = (fd: FormData): string | null => {
  const v = fd.get("reason");
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length >= 1 && t.length <= REASON_MAX ? t : null;
};
const done = (path: string) => revalidatePath(path);

export async function setStudioFrontDeskAction(formData: FormData): Promise<FrontDeskActionResult> {
  const auth = await authorize();
  if ("refusal" in auth) return auth.refusal;
  const studioId = studioIdOf(formData);
  if (!studioId) return { ok: false, message: "Choose a studio from the list." };
  const on = formData.get("on");
  if (on !== "true" && on !== "false") return { ok: false, message: "Choose on or off." };
  if (on === "true") {
    // The key is only ever pilot (never all); turning a studio on first makes sure the key is in pilot mode, then lists the studio.
    const mode = await setFrontDeskKeyPilot(auth.actor);
    if (mode.kind === "refused") return { ok: false, message: REFUSED };
    if (mode.kind === "unknown") { done("/admin/front-desk"); return { ok: false, message: UNKNOWN }; }
    const out = await enableFrontDeskForStudio(studioId, auth.actor);
    if (out.kind === "refused") return { ok: false, message: REFUSED };
    if (out.kind === "unknown") { done("/admin/front-desk"); return { ok: false, message: UNKNOWN }; }
    if (out.value === "not_found") return { ok: false, message: "That studio was not found." };
    done("/admin/front-desk");
    return { ok: true, message: out.value === "exists" ? "Already on." : "Front desk switched on for this studio." };
  }
  const out = await disableFrontDeskForStudio(studioId, auth.actor);
  if (out.kind === "refused") return { ok: false, message: REFUSED };
  if (out.kind === "unknown") { done("/admin/front-desk"); return { ok: false, message: UNKNOWN }; }
  done("/admin/front-desk");
  return { ok: true, message: out.value === "absent" ? "It was not on." : "Front desk switched off for this studio." };
}

export async function grantSeatsAction(formData: FormData): Promise<FrontDeskActionResult> {
  const auth = await authorize();
  if ("refusal" in auth) return auth.refusal;
  const studioId = studioIdOf(formData);
  if (!studioId) return { ok: false, message: "Choose a studio from the list." };
  const seatsRaw = formData.get("seats");
  const seats = typeof seatsRaw === "string" && /^\d{1,2}$/.test(seatsRaw) ? Number(seatsRaw) : NaN;
  if (!Number.isInteger(seats) || seats < 1 || seats > 50) return { ok: false, message: "Seats must be a whole number from 1 to 50." };
  const source = formData.get("source");
  if (typeof source !== "string" || !(SEAT_SOURCES as readonly string[]).includes(source)) return { ok: false, message: "Choose where the seats come from." };
  const reason = reasonOf(formData);
  if (!reason) return { ok: false, message: `A reason of 1 to ${REASON_MAX} characters is required.` };
  let expiresAt: string | null = null;
  const exp = formData.get("expiresAt");
  if (typeof exp === "string" && exp.trim() !== "") {
    // A date (end of that UTC day) from the date input; never a free timestamp.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(exp)) return { ok: false, message: "Enter the expiry as a date." };
    const t = Date.parse(`${exp}T23:59:59Z`);
    if (!Number.isFinite(t) || t <= Date.now()) return { ok: false, message: "The expiry must be in the future." };
    expiresAt = new Date(t).toISOString();
  }
  // The same click arriving twice (a double submit, a retry) must not grant twice: the pilot needs exactly the seats asked for. The button is also
  // disabled while pending; this is the server's own check. It cannot close two truly simultaneous requests, which the sealed schema has no key to refuse.
  if (await grantAlreadyMade(studioId, { seats, source, reason, expiresAt })) {
    done("/admin/front-desk");
    return { ok: true, message: "Already granted." };
  }
  const out = await grantFrontDeskSeats({ studioId, seats, source: source as SeatSource, reason, expiresAt }, auth.actor);
  if (out.kind === "refused") return { ok: false, message: REFUSED };
  if (out.kind === "unknown") { done("/admin/front-desk"); return { ok: false, message: UNKNOWN }; }
  done("/admin/front-desk");
  return { ok: true, message: "Seats granted." };
}

export async function revokeSeatsAction(formData: FormData): Promise<FrontDeskActionResult> {
  const auth = await authorize();
  if ("refusal" in auth) return auth.refusal;
  const seatId = formData.get("seatId");
  if (typeof seatId !== "string" || !UUID.test(seatId)) return { ok: false, message: "Choose a grant from the list." };
  const reason = reasonOf(formData);
  if (!reason) return { ok: false, message: `A reason of 1 to ${REASON_MAX} characters is required.` };
  const out = await revokeFrontDeskSeats({ seatId: seatId.toLowerCase(), reason }, auth.actor);
  if (out.kind === "refused") return { ok: false, message: REFUSED };
  if (out.kind === "unknown") { done("/admin/front-desk"); return { ok: false, message: UNKNOWN }; }
  done("/admin/front-desk");
  if (out.status === "not_found") return { ok: false, message: "That grant was not found." };
  if (out.status === "already_revoked") return { ok: true, message: "Already revoked." };
  return {
    ok: true,
    message: out.seatsOverLimit > 0
      ? `Revoked. ${out.seatsOverLimit} receptionist${out.seatsOverLimit === 1 ? " is" : "s are"} now over the seat limit and cannot use the front desk. Nothing was deleted.`
      : "Revoked.",
  };
}
