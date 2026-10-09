// Minimal, non-validating XML parser for Office Open XML parts (PPTX slides, rels, presentation.xml).
// OOXML parts are machine-generated, well-formed XML without DTDs. This parser:
//   * never resolves external entities or DTDs (DOCTYPE is rejected → no XXE / billion-laughs)
//   * decodes the five predefined entities and numeric character references only
//   * caps nesting depth and node count (hostile documents fail fast instead of exhausting memory)
export interface XmlElement {
  name: string; // qualified name as written, e.g. 'p:sp'
  attrs: Record<string, string>;
  children: XmlNode[];
}
export type XmlNode = XmlElement | string;

export class XmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlError';
  }
}

const MAX_DEPTH = 256;
const MAX_NODES = 2_000_000;

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_m, e: string) => {
    if (e === 'amp') return '&';
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
    try {
      return String.fromCodePoint(code);
    } catch {
      return '';
    }
  });
}

const ATTR_RE = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

export function parseXml(xml: string): XmlElement {
  const root: XmlElement = { name: '#document', attrs: {}, children: [] };
  const stack: XmlElement[] = [root];
  let i = 0;
  let nodes = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) {
      const text = xml.slice(i);
      if (text.trim()) stack[stack.length - 1]!.children.push(decodeEntities(text));
      break;
    }
    if (lt > i) {
      const text = xml.slice(i, lt);
      // keep whitespace-only text only inside elements that can carry it (a:t / w:t); others are layout noise
      const parent = stack[stack.length - 1]!;
      if (text.trim() || /(^|:)t$/.test(parent.name)) parent.children.push(decodeEntities(text));
    }
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      if (end === -1) throw new XmlError('unterminated processing instruction');
      i = end + 2;
      continue;
    }
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end === -1) throw new XmlError('unterminated comment');
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      if (end === -1) throw new XmlError('unterminated CDATA');
      stack[stack.length - 1]!.children.push(xml.slice(lt + 9, end));
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<!', lt)) throw new XmlError('DTD / declarations are not allowed');
    const gt = xml.indexOf('>', lt + 1);
    if (gt === -1) throw new XmlError('unterminated tag');
    const raw = xml.slice(lt + 1, gt);
    i = gt + 1;
    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim();
      const top = stack.pop();
      if (!top || top.name !== name || stack.length === 0) throw new XmlError(`mismatched closing tag </${name}>`);
      continue;
    }
    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const nameMatch = /^([^\s/>]+)/.exec(body);
    if (!nameMatch) throw new XmlError('invalid tag');
    const el: XmlElement = { name: nameMatch[1]!, attrs: {}, children: [] };
    ATTR_RE.lastIndex = 0;
    const attrSrc = body.slice(nameMatch[1]!.length);
    let m: RegExpExecArray | null;
    while ((m = ATTR_RE.exec(attrSrc)) !== null) {
      el.attrs[m[1]!] = decodeEntities(m[3] ?? m[4] ?? '');
    }
    if (++nodes > MAX_NODES) throw new XmlError('document too large');
    stack[stack.length - 1]!.children.push(el);
    if (!selfClosing) {
      stack.push(el);
      if (stack.length > MAX_DEPTH) throw new XmlError('document nested too deeply');
    }
  }
  if (stack.length !== 1) throw new XmlError('unclosed elements');
  const first = root.children.find((c): c is XmlElement => typeof c !== 'string');
  if (!first) throw new XmlError('empty document');
  return first;
}

/** local name without namespace prefix */
export function localName(name: string): string {
  const k = name.indexOf(':');
  return k === -1 ? name : name.slice(k + 1);
}

export function childElements(el: XmlElement, local?: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (const c of el.children) if (typeof c !== 'string' && (local === undefined || localName(c.name) === local)) out.push(c);
  return out;
}

export function firstChild(el: XmlElement, local: string): XmlElement | undefined {
  for (const c of el.children) if (typeof c !== 'string' && localName(c.name) === local) return c;
  return undefined;
}

/** depth-first search for descendants with the given local name (not descending into matches) */
export function findAll(el: XmlElement, local: string, out: XmlElement[] = []): XmlElement[] {
  for (const c of el.children) {
    if (typeof c === 'string') continue;
    if (localName(c.name) === local) out.push(c);
    else findAll(c, local, out);
  }
  return out;
}

export function findFirst(el: XmlElement, local: string): XmlElement | undefined {
  for (const c of el.children) {
    if (typeof c === 'string') continue;
    if (localName(c.name) === local) return c;
    const deep = findFirst(c, local);
    if (deep) return deep;
  }
  return undefined;
}

/** attribute by local name (ignores prefix: 'r:id' matches 'id' only when asked as 'r:id' or exact) */
export function attr(el: XmlElement, name: string): string | undefined {
  if (name in el.attrs) return el.attrs[name];
  for (const [k, v] of Object.entries(el.attrs)) if (localName(k) === name) return v;
  return undefined;
}

export function textContent(el: XmlNode): string {
  if (typeof el === 'string') return el;
  return el.children.map(textContent).join('');
}
