import type { NewClientReadiness } from "@/lib/booking/new-client-readiness";
import { OWNER_CHOICE_KEYS } from "@/lib/dashboard/setup-card-model";
import type { OnboardingBookingReadiness } from "./steps";

// PURE. Reduces the canonical new-client readiness to the wizard's verdict. It restates no requirement: which facts matter is
// decided in lib/booking/new-client-readiness.ts, and which blockers are an owner's own admission choice is decided once, in
// lib/dashboard/setup-card-model.ts, which the setup card uses too, so the wizard and the card cannot disagree.
export function onboardingBookingReadiness(r: NewClientReadiness): OnboardingBookingReadiness {
  if (r.status === "ready") return { state: "ready" };
  if (r.status === "unknown") return { state: "unknown" };
  const structural = r.blockers.filter((b) => !OWNER_CHOICE_KEYS.has(b.key));
  if (structural.length > 0) {
    const first = structural[0];
    return { state: "blocked", next: { label: first.label, href: first.href } };
  }
  // Nothing proven missing. An authority that could not answer means nobody has evidence either way: never green.
  if (r.unavailable.length > 0) return { state: "unknown" };
  // Only the owner's own admission choice (closed, or waitlist instead of booking) stands between this studio and ready.
  // That is not unfinished setup, and the wizard must not trap the studio on it.
  return { state: "ready" };
}
