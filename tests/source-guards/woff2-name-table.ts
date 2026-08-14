import { readFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";

// Minimal WOFF2 reader for the `name` table.
//
// Why this exists: the .woff2 files are what actually reaches a browser. The
// LICENSE-*.txt files next to them stay in the repository - Next emits only the
// fonts into .next/static/media. OFL 1.1 clause 2 anticipates exactly that and
// accepts the notice "in the appropriate machine-readable metadata fields
// within text or binary files", so what makes the SERVED copy carry its notice
// is the font's own name table, not a sibling file. This lets the guard assert
// that property instead of assuming it.
//
// Spec: https://www.w3.org/TR/WOFF2/ - the header and table directory are
// uncompressed; the table data that follows is one Brotli stream holding each
// table back-to-back in directory order.

const KNOWN_TABLE_TAGS = [
  "cmap","head","hhea","hmtx","maxp","name","OS/2","post","cvt ","fpgm","glyf",
  "loca","prep","CFF ","VORG","EBDT","EBLC","gasp","hdmx","kern","LTSH","PCLT",
  "VDMX","vhea","vmtx","BASE","GDEF","GPOS","GSUB","EBSC","JSTF","MATH","CBDT",
  "CBLC","COLR","CPAL","SVG ","sbix","acnt","avar","bdat","bloc","bsln","cvar",
  "fdsc","feat","fmtx","fvar","gvar","hsty","just","lcar","mort","morx","opbd",
  "prop","trak","Zapf","Silf","Glat","Gloc","Feat","Sill",
];

/** OpenType name IDs worth asserting on. */
export const NAME_ID = {
  copyright: 0,
  family: 1,
  licenseDescription: 13,
  licenseInfoUrl: 14,
} as const;

function readUIntBase128(buf: Buffer, cursor: { at: number }): number {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    const byte = buf[cursor.at++];
    value = (value << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) return value >>> 0;
  }
  throw new Error("malformed UIntBase128 in WOFF2 table directory");
}

/** name-table entries of a .woff2, keyed by OpenType name ID. */
export function readWoff2NameTable(file: string): Record<number, string> {
  const buf = readFileSync(file);
  if (buf.toString("ascii", 0, 4) !== "wOF2") {
    throw new Error(`not a WOFF2 file: ${file}`);
  }
  const numTables = buf.readUInt16BE(12);
  const totalCompressedSize = buf.readUInt32BE(20);
  const cursor = { at: 48 };

  const directory: Array<{ tag: string; length: number }> = [];
  for (let i = 0; i < numTables; i++) {
    const flags = buf[cursor.at++];
    const known = flags & 0x3f;
    let tag: string;
    if (known === 63) {
      tag = buf.toString("ascii", cursor.at, cursor.at + 4);
      cursor.at += 4;
    } else {
      tag = KNOWN_TABLE_TAGS[known];
    }
    const transformVersion = (flags >> 6) & 0x03;
    const origLength = readUIntBase128(buf, cursor);
    // glyf/loca invert the convention: 0 means transformed for them, and
    // "not 3" means transformed for everything else.
    const transformed =
      tag === "glyf" || tag === "loca"
        ? transformVersion === 0
        : transformVersion !== 0;
    const transformLength = transformed ? readUIntBase128(buf, cursor) : null;
    directory.push({ tag, length: transformLength ?? origLength });
  }

  const data = brotliDecompressSync(
    buf.subarray(cursor.at, cursor.at + totalCompressedSize),
  );

  let offset = 0;
  let nameData: Buffer | null = null;
  for (const table of directory) {
    if (table.tag === "name") {
      nameData = data.subarray(offset, offset + table.length);
      break;
    }
    offset += table.length;
  }
  if (!nameData) return {};

  const count = nameData.readUInt16BE(2);
  const stringOffset = nameData.readUInt16BE(4);
  const names: Record<number, string> = {};
  for (let i = 0; i < count; i++) {
    const record = 6 + i * 12;
    const platformID = nameData.readUInt16BE(record);
    const nameID = nameData.readUInt16BE(record + 6);
    const length = nameData.readUInt16BE(record + 8);
    const stringStart = stringOffset + nameData.readUInt16BE(record + 10);
    const raw = nameData.subarray(stringStart, stringStart + length);
    // Platform 1 is Macintosh (Latin-1); 0 and 3 store UTF-16BE.
    const text =
      platformID === 1
        ? raw.toString("latin1")
        : Buffer.from(raw).swap16().toString("utf16le");
    if (text && names[nameID] === undefined) names[nameID] = text;
  }
  return names;
}
