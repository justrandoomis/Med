// LibreOffice safety for OOXML packages (H2 item 8). A PPTX / DOCX / XLSX can hold relationships whose target is
// OUTSIDE the package — `TargetMode="External"` pictures, OLE objects, hyperlinks pointing at `file:///…` on the
// server's disk, `\\server\share\…` or `http(s)://…`. The converter's profile already sends HTTP(S) to a closed proxy
// (G8), but a `file:` link made LibreOffice EMBED a file of the server disk into the PDF it produced. Before any
// conversion, every relationship part of the package is rewritten WITHOUT such relationships (a picture becomes an
// empty frame, a hyperlink plain text). Only the copy handed to the converter changes — the stored upload never does.
//
// H2 review: relationship parts are read with a quote-aware tag scanner (an attribute value may legally hold «>» or
// text that looks like another attribute), entity references are decoded, and any TargetMode other than «Internal»
// counts as external. Every relationship part is then written back in CANONICAL form (only Id / Type / Target of the
// relationships that stay), and the package is always re-zipped from what was read — so what LibreOffice reads is
// exactly what was checked (no DOCTYPE, no comments, no duplicate or hidden entries).
import JSZip from 'jszip';

export interface RemovedRelationship {
  part: string;
  id: string;
  target: string;
}

const RELS_PART = /(^|\/)_rels\/[^/]*\.rels$/i;
/** a URI scheme («file:», «http:», «smb:»…), a UNC path («\\host\share») or a drive path («C:\…») */
const OUTSIDE_TARGET = /^(?:[a-z][a-z0-9+.-]*:|\\\\|\/\/)/i;
const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

/** Decode the predefined XML entities and character references; null when an UNKNOWN entity remains (a DTD trick). */
function decodeXmlAttr(v: string): string | null {
  let unknown = false;
  const named: Record<string, string> = { quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' };
  const out = v.replace(/&(#x[0-9a-f]+|#[0-9]+|[A-Za-z_][\w.-]*);?/gi, (m: string, ref: string) => {
    const r = ref.toLowerCase();
    const decoded = !m.endsWith(';')
      ? null
      : r.startsWith('#x')
        ? safeCodePoint(parseInt(r.slice(2), 16))
        : r.startsWith('#')
          ? safeCodePoint(Number(r.slice(1)))
          : Object.hasOwn(named, ref)
            ? named[ref]!
            : null;
    if (decoded === null) unknown = true;
    return decoded ?? m;
  });
  return unknown ? null : out;
}

function safeCodePoint(n: number): string | null {
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : null;
}

function escapeXmlAttr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** The start tags of an XML text (quote-aware: «>» inside a quoted value does not end a tag), comments / PIs / CDATA skipped. */
function startTags(xml: string): string[] {
  const out: string[] = [];
  let i = 0;
  while ((i = xml.indexOf('<', i)) !== -1) {
    const skip = (open: string, close: string): boolean => {
      if (!xml.startsWith(open, i)) return false;
      const e = xml.indexOf(close, i + open.length);
      i = e < 0 ? xml.length : e + close.length;
      return true;
    };
    if (skip('<!--', '-->') || skip('<![CDATA[', ']]>') || skip('<?', '?>')) continue;
    let j = i + 1;
    let quote: string | null = null;
    let depth = 0; // «[ … ]» of a DOCTYPE internal subset
    for (; j < xml.length; j++) {
      const c = xml[j]!;
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '[') depth++;
      else if (c === ']') depth = Math.max(0, depth - 1);
      else if (c === '>' && depth === 0) break;
    }
    const tag = xml.slice(i, j + 1);
    if (!tag.startsWith('</') && !tag.startsWith('<!')) out.push(tag);
    i = j + 1;
  }
  return out;
}

/** Local name of an element / attribute name («r:Relationship» → «Relationship»). */
const localName = (n: string) => n.slice(n.indexOf(':') + 1);

/** The attributes of a start tag in order (raw values), or null when the attribute list cannot be read exactly. */
function attributes(tag: string): Array<[string, string]> | null {
  const head = /^<[^\s/>]+/.exec(tag);
  if (!head) return null;
  const body = tag.slice(head[0].length).replace(/\/?>$/, '');
  const re = /\s+([^\s=/>"']+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
  const out: Array<[string, string]> = [];
  let at = 0;
  for (;;) {
    re.lastIndex = at;
    const m = re.exec(body);
    if (!m) break;
    out.push([m[1]!, m[2] ?? m[3] ?? '']);
    at = re.lastIndex;
  }
  return body.slice(at).trim() === '' ? out : null;
}

interface Relationship {
  id: string;
  type: string;
  target: string;
}

/**
 * Read one relationship start tag: the relationship to keep, or the reason it must go. A relationship is kept only when
 * its attribute list is read exactly, Id / Type / Target are present and decode cleanly, every TargetMode (whatever its
 * prefix or case) decodes to «Internal», and the target does not leave the package.
 */
function readRelationship(tag: string): { keep: Relationship } | { drop: { id: string; target: string } } {
  const attrs = attributes(tag);
  const raw = (name: string) => attrs?.find(([n]) => n === name)?.[1];
  // for the report only (an unreadable tag is dropped whatever it says)
  const loose = (name: string) => new RegExp(`\\s${name}\\s*=\\s*["']?([^"'\\s/>]*)`).exec(tag)?.[1] ?? '';
  const fallback = { id: raw('Id') ?? loose('Id'), target: raw('Target') ?? loose('Target') };
  if (!attrs) return { drop: fallback };
  let external = false;
  for (const [n, v] of attrs) {
    if (localName(n).toLowerCase() !== 'targetmode') continue;
    const mode = decodeXmlAttr(v);
    if (mode === null || mode.trim() !== 'Internal') external = true;
  }
  const id = raw('Id') !== undefined ? decodeXmlAttr(raw('Id')!) : null;
  const type = raw('Type') !== undefined ? decodeXmlAttr(raw('Type')!) : null;
  const targets = attrs.filter(([n]) => localName(n).toLowerCase() === 'target').map(([, v]) => decodeXmlAttr(v));
  const target = targets.length === 1 ? targets[0]! : null;
  if (external || id === null || type === null || target === null || !id || OUTSIDE_TARGET.test(target.trim())) {
    return { drop: { id: id ?? fallback.id, target: target ?? fallback.target } };
  }
  return { keep: { id, type, target } };
}

/** Whether a relationship tag points outside the package (and must never reach the converter). */
export function isExternalRelationship(tag: string): boolean {
  return 'drop' in readRelationship(tag);
}

/** A relationship part rewritten canonically: only the relationships that stay inside the package. */
function canonicalRels(xml: string, part: string, removed: RemovedRelationship[]): string {
  const kept: Relationship[] = [];
  for (const tag of startTags(xml)) {
    const name = /^<([^\s/>]+)/.exec(tag)?.[1] ?? '';
    if (localName(name) !== 'Relationship') continue;
    const r = readRelationship(tag);
    if ('keep' in r) kept.push(r.keep);
    else removed.push({ part, id: r.drop.id, target: r.drop.target });
  }
  const rels = kept.map((r) => `<Relationship Id="${escapeXmlAttr(r.id)}" Type="${escapeXmlAttr(r.type)}" Target="${escapeXmlAttr(r.target)}"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${RELS_NS}">${rels}</Relationships>`;
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
    zip.file(name, canonicalRels(await entry.async('string'), name, removed), { createFolders: false });
  }
  // always re-zipped from what was read: no bytes of the upload reach the converter unchecked
  return { data: Buffer.from(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })), removed };
}

/** A ZIP local-file header at the start: an OOXML package (whatever extension the converter is told). */
export function looksLikeZip(input: Uint8Array): boolean {
  return input.length >= 4 && input[0] === 0x50 && input[1] === 0x4b && input[2] === 0x03 && input[3] === 0x04;
}
