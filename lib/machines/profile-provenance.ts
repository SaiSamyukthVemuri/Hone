import type { EvidenceRef, MachineProfile } from "./profile-contract";

/**
 * WHERE A MACHINE PROFILE CAME FROM, in words a practitioner can read.
 *
 * DEFAULT-PROFILES item 6 (Sam, 28 Oct): the panel shows a profile's
 * provenance - the manufacturer source and the version - and the studio's
 * confirmation status. Everything here is derived from the profile itself;
 * nothing is stored, nothing is claimed beyond `verification`.
 *
 * CONFIRMATION IS NOT INFERRED FROM A MANUAL. A manual establishes what the
 * manufacturer documents for a model. Only `device-confirmed` says the studio's
 * own unit was checked against it, so every other state reads as not confirmed -
 * a profile never describes an installed unit on the strength of documentation
 * alone.
 */
export type ProfileProvenance = {
  /** "Dectro Senior 3G", the manufacturer's own model naming. */
  title: string;
  /** "Profile version 2". A change to a profile is a new version. */
  versionLabel: string;
  /** One line per manufacturer-kind source: kind, locator, date consulted. */
  sources: string[];
  /** Whether the studio's unit has been confirmed against that source. */
  confirmation: "confirmed" | "pending" | "not-applicable";
  confirmationLabel: string;
};

const MANUFACTURER_KINDS: ReadonlySet<EvidenceRef["kind"]> = new Set([
  "manufacturer-manual",
  "manufacturer-authored-manual-mirror",
  "manufacturer-brochure",
  "manufacturer-product-page",
  "manufacturer-comparison-matrix",
]);

const KIND_LABEL: Record<EvidenceRef["kind"], string> = {
  "manufacturer-manual": "Manufacturer manual",
  "manufacturer-authored-manual-mirror": "Manufacturer manual (mirror)",
  "manufacturer-brochure": "Manufacturer brochure",
  "manufacturer-product-page": "Manufacturer product page",
  "manufacturer-comparison-matrix": "Manufacturer comparison chart",
  "designer-first-hand-account": "Designer account",
  "practitioner-report": "Practitioner report",
  "studio-device-photo": "Studio photo of the unit",
};

export function profileProvenance(profile: MachineProfile): ProfileProvenance {
  const sources = profile.evidence
    .filter((e) => MANUFACTURER_KINDS.has(e.kind))
    .map((e) =>
      [KIND_LABEL[e.kind], e.locator, `consulted ${e.consultedOn}`]
        // The locator may carry a document hash for audit; the reader gets the
        // human part (edition and pages), not the digest.
        .filter((part): part is string => Boolean(part))
        .map((part) => part.replace(/;?\s*SHA256 [0-9a-f]{64}/i, ""))
        .join(", "),
    );
  const confirmed = profile.verification === "device-confirmed";
  const documented = profile.verification === "manufacturer-documented";
  return {
    title: `${profile.manufacturer} ${profile.model}${profile.variant ? ` (${profile.variant})` : ""}`,
    versionLabel: `Profile version ${profile.version}`,
    sources,
    confirmation: confirmed ? "confirmed" : documented ? "pending" : "not-applicable",
    confirmationLabel: confirmed
      ? "Confirmed against this studio's unit"
      : documented
        ? "Pending studio confirmation"
        : "Not manufacturer-verified",
  };
}
