import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { E2E_WEB_SERVER_ENV } from "./local-env";

// SCH-001. Reads what the lane's server tried to email, as recorded by the fake
// Resend transport. The file is append-only and outlives a run, so a reader
// takes a MARK (the file's length) before acting and reads only what was
// appended after it. Recipient and subject only; there is no body to read.

export type ResendLedgerRecord = {
  t: string;
  pid: number;
  mode: "success" | "reject" | "throw" | "failonce" | "hold";
  to: string;
  subject: string;
};

export type ResendLedgerMark = { offset: number };

function ledgerPath(): string {
  const file = E2E_WEB_SERVER_ENV.HONE_E2E_FAKE_RESEND_LEDGER;
  if (!file) {
    throw new Error(
      "HONE_E2E_FAKE_RESEND_LEDGER is not set in E2E_WEB_SERVER_ENV: the fake Resend ledger is not wired for this lane.",
    );
  }
  return file;
}

export function markResendLedger(): ResendLedgerMark {
  const file = ledgerPath();
  if (!existsSync(file)) return { offset: 0 };
  const fd = openSync(file, "r");
  try {
    return { offset: fstatSync(fd).size };
  } finally {
    closeSync(fd);
  }
}

/** Every complete record appended since `mark`. */
export function readResendLedger(mark: ResendLedgerMark): ResendLedgerRecord[] {
  const file = ledgerPath();
  if (!existsSync(file)) return [];
  const fd = openSync(file, "r");
  let text: string;
  try {
    const size = fstatSync(fd).size;
    const length = Math.max(0, size - mark.offset);
    const buf = Buffer.alloc(length);
    if (length > 0) readSync(fd, buf, 0, length, mark.offset);
    text = buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
  const complete = text.slice(0, text.lastIndexOf("\n") + 1);
  return complete
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ResendLedgerRecord);
}
