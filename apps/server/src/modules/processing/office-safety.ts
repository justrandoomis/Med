// LibreOffice safety for OOXML packages (H2 item 8). A PPTX / DOCX / XLSX can hold relationships whose target is
// OUTSIDE the package — `TargetMode="External"` pictures, OLE objects, hyperlinks pointing at `file:///…` on the
// server's disk, `\\server\share\…` or `http(s)://…`. The converter's profile already sends HTTP(S) to a closed proxy
// (G8), but a `file:` link made LibreOffice EMBED a file of the server disk into the PDF it produced. Before any
// conversion, every relationship part of the package is rewritten WITHOUT such relationships (a picture becomes an
// empty frame, a hyperlink plain text). Only the copy handed to the converter changes — the stored upload never does.
import JSZip from 'jszip';

export interface RemovedRelationship {
  part: string;
  id: string;
  target: string;
}

const RELS_PART = /(^|\/)_rels\/[^/]*\.rels$/i;
/** a URI scheme («file:», «http:», «smb:»…), a UNC path («\\host\share») or a drive path («C:\…») */
const OUTSIDE_TARGET = /^(?:[a-z][a-z0-9+.-]*:|\\\\|\/\/)/i;
const RELATIONSHIP = /<(?:\w+:)?Relationship\b[^>]*?(?:\/>|>[\s\S]*?<\/(?:\w+:)?Relationship\s*>)/g;

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? (m[2] ?? m[3] ?? '') : null;
}

function decodeXmlAttr(v: string): string {
  return v
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#([0-9]+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

/** Whether a relationship points outside the package (and must never reach the converter). */
export function isExternalRelationship(tag: string): boolean {
  if ((attr(tag, 'TargetMode') ?? '').trim().toLowerCase() === 'external') return true;
  const target = decodeXmlAttr(attr(tag, 'Target') ?? '').trim();
  return OUTSIDE_TARGET.test(target);
}

/**
 * A copy of an OOXML package without any relationship that leaves the package. Throws when the package cannot be read
 * (the caller then refuses the conversion instead of handing LibreOffice an unchecked file).
 */
export async function sanitizeOoxmlForConversion(input: Uint8Array): Promise<{ data: Buffer; removed: RemovedRelationship[] }> {
  const zip = await JSZip.loadAsync(input, { checkCRC32: true });
  const removed: RemovedRelationship[] = [];
  for (const name of Object.keys(zip.files).sort()) {
    const entry = zip.files[name]!;
    if (entry.dir || !RELS_PART.test(name)) continue;
    const xml = await entry.async('string');
    let changed = false;
    const next = xml.replace(RELATIONSHIP, (tag) => {
      if (!isExternalRelationship(tag)) return tag;
      changed = true;
      removed.push({ part: name, id: attr(tag, 'Id') ?? '', target: decodeXmlAttr(attr(tag, 'Target') ?? '') });
      return '';
    });
    if (changed) zip.file(name, next);
  }
  if (removed.length === 0) return { data: Buffer.from(input), removed };
  return { data: Buffer.from(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })), removed };
}

/** A ZIP local-file header at the start: an OOXML package (whatever extension the converter is told). */
export function looksLikeZip(input: Uint8Array): boolean {
  return input.length >= 4 && input[0] === 0x50 && input[1] === 0x4b && input[2] === 0x03 && input[3] === 0x04;
}
