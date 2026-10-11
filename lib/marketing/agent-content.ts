import {
  CANONICAL_HOST,
  CONTACT_EMAIL,
  POSITIONING,
  PRICING_PLANS,
  PAYMENT_QUALIFIER,
} from "./content";

// These public descriptions are shared by the HTML trust pages and the
// negotiated Markdown versions. No client records, private routes, or
// unverified company details belong here.
export const ABOUT_PARAGRAPHS: ReadonlyArray<string> = [
  "Hone is electrolysis practice software built around treatment memory: carrying the relevant details of a previous treatment into the next visit. Its purpose is to help electrologists prepare for returning clients, document what was done, and keep the operational record connected to their calendar.",
  "Hone brings appointment booking, intake, consent, charting, client follow-up, payment workflows and private treatment records into one place. Treatment history can include the treated areas, recorded machine settings, probes, lot information, responses and notes. Details are retained as recorded; imported history is labelled rather than presented as newly charted work.",
  "Hone is operated from Ontario, Canada, by Sam Vemuri as an individual operating as Hone, pending incorporation. Studios are brought on through guided onboarding. The public walkthrough request is reviewed and answered by the operator; it is not an instant appointment booking or an automated subscription checkout.",
  "Practitioners remain responsible for clinical treatment decisions and the information they record. Hone does not use practitioner or client records to train AI models. Studio data is isolated, and the privacy policy and terms explain the current service boundaries. For a closer look at the product, request a walkthrough or contact Hone by email.",
];

export const CONTACT_PARAGRAPHS: ReadonlyArray<string> = [
  "For questions about Hone, electrolysis practice workflows, guided onboarding or a product walkthrough, email hello@hone.care. You can also use the Request a walkthrough page to describe your studio and what you would like to see. Sending a request does not reserve a calendar appointment; Hone will follow up to arrange the next step.",
  "Existing participating studios can use the same public contact address for account and product questions. Please describe the issue without placing sensitive client records, treatment photographs, access tokens or payment card information in an ordinary email. The appropriate next step may require a secure, studio-specific support exchange.",
  "For privacy questions, records requests or concerns about how Hone processes information, contact privacy@hone.care. A studio is responsible for its own client records and normally handles its clients' access and correction requests; Hone can help the studio fulfil its obligations as described in the privacy policy.",
  "Hone is operated from Ontario, Canada. No public walk-in office, street mailing address or telephone support line is advertised here. The verified public contact channels are the email addresses above and the walkthrough request form. The Privacy Policy and Terms of Service provide additional information about the operator and the service.",
];

export const HOME_MARKDOWN = [
  "# " + POSITIONING.heroH1,
  "",
  "> " + POSITIONING.category + " — " + POSITIONING.keepPhrase + ".",
  "",
  POSITIONING.heroSub,
  "",
  "## Treatment memory",
  "",
  "Hone records treated areas, the setup used, probe and lot, the client's recorded response, and notes for the next visit. Each treated area remains findable in its own history, including when one settings block covers multiple areas.",
  "",
  "- [Treatment memory](" + CANONICAL_HOST + "/features/treatment-memory): See how prior treatment context is surfaced.",
  "- [Charting and records](" + CANONICAL_HOST + "/features/charting-records): Review structured treatment documentation and record keeping.",
  "- [Booking and calendar](" + CANONICAL_HOST + "/features/booking-calendar): Review scheduling and client workflows.",
  "",
  "## Practice operations",
  "",
  "Hone connects booking, intake, consent, charting, client follow-up, payments and the client portal. " + PAYMENT_QUALIFIER + " Studios receive guided onboarding.",
  "",
  "## Published pricing",
  "",
  ...PRICING_PLANS.filter((plan) => plan.priceLabel !== null).map(
    (plan) => "- " + plan.name + ": " + plan.priceLabel + plan.cadence + " (" + plan.seats + ").",
  ),
  "",
  "See [pricing](" + CANONICAL_HOST + "/pricing) for eligibility, plan details and limitations. The public page does not take an automatic subscription payment.",
  "",
  "## Learn more",
  "",
  "- [About Hone](" + CANONICAL_HOST + "/about)",
  "- [Contact Hone](" + CANONICAL_HOST + "/contact)",
  "- [Privacy](" + CANONICAL_HOST + "/privacy)",
  "- [Terms](" + CANONICAL_HOST + "/terms)",
  "- [Request a walkthrough](" + CANONICAL_HOST + "/demo)",
  "",
  "For general questions, email " + CONTACT_EMAIL + ". No public agent API or permission to access practitioner or client records is offered by this page.",
  "",
].join("\n");

export const ABOUT_MARKDOWN = [
  "# About Hone",
  "",
  ...ABOUT_PARAGRAPHS.flatMap((paragraph) => [paragraph, ""]),
  "- [Treatment memory](" + CANONICAL_HOST + "/features/treatment-memory)",
  "- [Contact](" + CANONICAL_HOST + "/contact)",
  "- [Privacy](" + CANONICAL_HOST + "/privacy)",
  "- [Terms](" + CANONICAL_HOST + "/terms)",
  "",
].join("\n");

export const CONTACT_MARKDOWN = [
  "# Contact Hone",
  "",
  ...CONTACT_PARAGRAPHS.flatMap((paragraph) => [paragraph, ""]),
  "- [Email Hone](mailto:" + CONTACT_EMAIL + ")",
  "- [Privacy email](mailto:privacy@hone.care)",
  "- [Request a walkthrough](" + CANONICAL_HOST + "/demo)",
  "- [Privacy](" + CANONICAL_HOST + "/privacy)",
  "",
].join("\n");

export const NOT_FOUND_MARKDOWN = [
  "# 404 — Page not found",
  "",
  "The requested Hone page or resource does not exist at this URL.",
  "Start with the [Hone homepage](" + CANONICAL_HOST + "/), consult the [sitemap](" + CANONICAL_HOST + "/sitemap.xml), or read [llms.txt](" + CANONICAL_HOST + "/llms.txt) for a list of supported public pages.",
  "",
].join("\n");

export const PUBLIC_MARKDOWN: Readonly<Record<string, string>> = {
  "/": HOME_MARKDOWN,
  "/about": ABOUT_MARKDOWN,
  "/contact": CONTACT_MARKDOWN,
};
