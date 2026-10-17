// HON-46 — the print gate shared by the export page (server) and its audited
// Print button (client). Codex P1 4301153310: the browser's own print
// (Ctrl/Cmd+P, File > Print, Save as PDF) never runs the button's audit, so
// in PRINT media the record document is hidden unless the button has armed it
// after the print audit was recorded. An unarmed print produces only a notice
// that names no client and carries no record content.

export const EXPORT_DOCUMENT_ID = "clinical-records-document";
export const PRINT_ARMED_ATTRIBUTE = "data-print-armed";

export const PRINT_GATE_CSS = `
[data-print-unarmed-notice] { display: none; }
@media print {
  [data-export-document]:not([${PRINT_ARMED_ATTRIBUTE}]) { display: none !important; }
  [data-export-document]:not([${PRINT_ARMED_ATTRIBUTE}]) ~ [data-print-unarmed-notice] { display: block !important; }
}
`;

export const PRINT_UNARMED_NOTICE =
  "This document can only be printed with the Print button on the page, so that the print is recorded.";
