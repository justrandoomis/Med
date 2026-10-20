// H2 item 8 — LibreOffice safety: an uploaded OOXML document (PPTX for the fixed slide rendering, DOCX / any OOXML
// handed to the converter) can hold pictures that are only LINKS — `TargetMode="External"` relationships to
// `file:///…` on the SERVER's disk or to `http(s)://…`. The G8 proxy blocks the network, but a `file:` link made
// LibreOffice EMBED a file from the server disk into the PDF it produced (reproduced below with a picture placed on the
// server). External relationships are now stripped from every relationship part BEFORE conversion; the original
// upload is untouched. Fixtures are built in the test (the G8 PPTX with its link retargeted, a DOCX written with JSZip).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../src/config';
import { sanitizeOoxmlForConversion } from '../../src/modules/processing/office-safety';
import { closePdf, extractPage, openPdf } from '../../src/modules/processing/pdf';
import { encodePng } from '../../src/modules/processing/png';
import { convertToPdf, findExecutable, runCommand } from '../../src/modules/processing/tools';
import { startTrap, type Trap } from '../acceptance/g8-helpers';
import { paint, solid } from '../helpers/images';

const SOFFICE = findExecutable('soffice') ?? findExecutable('libreoffice');
const G8_PPTX = readFileSync(join(REPO_ROOT, 'fixtures', 'acceptance', 'g8_linked_image.pptx'));

let dir: string;
let secret: string;
let trap: Trap;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'medlevo-h2-links-'));
  // a picture that only exists on the SERVER disk (never uploaded)
  secret = join(dir, 'server-secret.png');
  writeFileSync(secret, encodePng(paint(solid(240, 120, [250, 250, 250]), 20, 20, 220, 100, [200, 20, 20])));
  trap = await startTrap();
});
afterAll(async () => {
  await trap?.close();
  rmSync(dir, { recursive: true, force: true });
});

async function pptxLinkingTo(target: string): Promise<Buffer> {
  const z = await JSZip.loadAsync(G8_PPTX);
  const rels = 'ppt/slides/_rels/slide1.xml.rels';
  const xml = await z.file(rels)!.async('string');
  z.file(rels, xml.replace('http://127.0.0.1:65001/g8-pptx-ssrf.png', target));
  return Buffer.from(await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

/**
 * A minimal DOCX whose only picture is a LINK (`r:link`) to `target`, plus a hyperlink to it. `relationships` replaces
 * the relationship elements of word/_rels/document.xml.rels (the picture must stay `rId5`).
 */
async function docxLinkingTo(target: string, relationships?: string): Promise<Buffer> {
  const z = new JSZip();
  z.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  z.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  z.file(
    'word/_rels/document.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships ?? `<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${target}" TargetMode="External"/><Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${target}" TargetMode="External"/>`}</Relationships>`,
  );
  const pic = `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="2286000" cy="1143000"/><wp:docPr id="1" name="Picture 1"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="linked.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:link="rId5"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2286000" cy="1143000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`;
  z.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body><w:p><w:r><w:t>H2 linked picture - TEST FIXTURE</w:t></w:r></w:p><w:p><w:r>${pic}</w:r></w:p><w:p><w:hyperlink r:id="rId6"><w:r><w:t>linked file</w:t></w:r></w:hyperlink></w:p></w:body></w:document>`,
  );
  return Buffer.from(await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

async function imagesInPdf(pdf: Buffer): Promise<number> {
  const doc = await openPdf(pdf);
  try {
    let n = 0;
    for (let p = 1; p <= doc.numPages; p++) n += (await extractPage(doc, p)).images.length;
    return n;
  } finally {
    await closePdf(doc);
  }
}

const convert = (input: Buffer, inputExt: 'pptx' | 'docx') => convertToPdf({ soffice: SOFFICE!, input, inputExt, tmpRoot: dir, timeoutMs: 170_000 });

describe('OOXML external relationships are stripped before LibreOffice converts (H2 item 8)', () => {
  it('the sanitizer removes every external / file: / http(s): relationship and keeps the package parts', async () => {
    const pptx = await pptxLinkingTo(`file://${secret}`);
    const { data, removed } = await sanitizeOoxmlForConversion(pptx);
    expect(removed).toEqual([{ part: 'ppt/slides/_rels/slide1.xml.rels', id: 'rId2', target: `file://${secret}` }]);
    const z = await JSZip.loadAsync(data);
    const rels = await z.file('ppt/slides/_rels/slide1.xml.rels')!.async('string');
    expect(rels).not.toMatch(/TargetMode="External"|Target="(?:file|https?):/);
    expect(rels).toContain('slideLayout7.xml'); // internal relationships stay
    expect(Object.keys(z.files).sort()).toEqual(Object.keys((await JSZip.loadAsync(pptx)).files).sort());
    const docx = await sanitizeOoxmlForConversion(await docxLinkingTo('http://127.0.0.1:1/x.png'));
    expect(docx.removed.map((r) => r.id)).toEqual(['rId5', 'rId6']);
    // not a zip → refused (never passed to the converter unchecked)
    await expect(sanitizeOoxmlForConversion(Buffer.from('PK\u0003\u0004 broken'))).rejects.toThrow();
  });

  it.skipIf(!SOFFICE)('without the hardened profile LibreOffice EMBEDS a file of the server disk; the sanitized copy cannot', async () => {
    // the defect this layer prevents, shown with LibreOffice's default profile (the G8 profile blocks it too — two layers)
    const plain = async (input: Buffer) => {
      const work = mkdtempSync(join(dir, 'plain-'));
      writeFileSync(join(work, 'in.pptx'), input);
      await runCommand(SOFFICE!, [`-env:UserInstallation=${pathToFileURL(join(work, 'profile')).href}`, '--headless', '--norestore', '--convert-to', 'pdf', '--outdir', work, join(work, 'in.pptx')], {
        timeoutMs: 170_000,
        cwd: work,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: work, LANG: 'C.UTF-8', TMPDIR: work },
      });
      return readFileSync(join(work, 'in.pdf'));
    };
    const linked = await pptxLinkingTo(`file://${secret}`);
    expect(await imagesInPdf(await plain(linked)), 'default profile: the server file is embedded').toBe(1);
    expect(await imagesInPdf(await plain((await sanitizeOoxmlForConversion(linked)).data)), 'sanitized: nothing to embed').toBe(0);
  }, 400_000);

  it.skipIf(!SOFFICE)('a PPTX picture linked to a file on the SERVER disk is not embedded in the rendering', async () => {
    const pdf = await convert(await pptxLinkingTo(`file://${secret}`), 'pptx');
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(await imagesInPdf(pdf), 'the server file was embedded into the PDF').toBe(0);
  }, 200_000);

  it.skipIf(!SOFFICE)('a DOCX picture linked to a server file: not embedded; file:///etc/hostname and http://127.0.0.1 are never read', async () => {
    expect(await imagesInPdf(await convert(await docxLinkingTo(`file://${secret}`), 'docx'))).toBe(0);
    const hostname = readFileSync('/etc/hostname', 'utf8').trim();
    for (const target of ['file:///etc/hostname', `http://127.0.0.1:${trap.port}/h2-docx.png`]) {
      trap.hits.length = 0;
      const pdf = await convert(await docxLinkingTo(target), 'docx');
      expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      if (hostname.length >= 4) expect(pdf.includes(Buffer.from(hostname))).toBe(false);
      expect(trap.hits).toEqual([]);
    }
    trap.hits.length = 0;
    await convert(await pptxLinkingTo(`http://127.0.0.1:${trap.port}/h2-pptx.png`), 'pptx');
    expect(trap.hits).toEqual([]);
  }, 400_000);
});

// H2 review: the first sanitizer matched relationships with a regex that stopped at the first «>» and read attributes
// with a first-match search — three spellings LibreOffice accepts kept a link to a SERVER file in the «sanitized» copy
// (reproduced: with LibreOffice's default profile the sanitized copy still embedded the server picture). Every
// relationship part is now read with a quote-aware scanner, entity references are decoded, any TargetMode other than
// «Internal» counts as external, and the parts are written back in canonical form (what LibreOffice reads is exactly
// what was checked).
describe('relationship spellings that must not survive the sanitizer (H2 review)', () => {
  const IMG = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
  const variants = (path: string): Record<string, string> => ({
    'a «>» inside an attribute value': `<Relationship Id="rId5" Type="${IMG}" Target="file://${path}" TargetMode="External" Note="a>b"/>`,
    'TargetMode written with a character reference, absolute path target': `<Relationship Id="rId5" Type="${IMG}" Target="${path}" TargetMode="&#69;xternal"/>`,
    'a decoy «TargetMode» inside another attribute value': `<Relationship Id="rId5" Note=" TargetMode='Internal'" Type="${IMG}" Target="${path}" TargetMode="External"/>`,
  });

  it('none of them keeps a relationship that leaves the package; internal relationships stay', async () => {
    for (const [what, rel] of Object.entries(variants('/srv/secret.png'))) {
      const internal = `<Relationship Id="rId7" Type="${IMG}" Target="media/image1.png"/>`;
      const { data, removed } = await sanitizeOoxmlForConversion(await docxLinkingTo('', rel + internal));
      expect(removed.map((r) => r.id), what).toEqual(['rId5']);
      const rels = await (await JSZip.loadAsync(data)).file('word/_rels/document.xml.rels')!.async('string');
      expect(rels, what).not.toMatch(/secret|TargetMode|External/i);
      expect(rels, what).toContain('Target="media/image1.png"');
    }
  });

  it('an unknown entity or an unreadable attribute list is never kept (fail closed)', async () => {
    const odd = [
      `<Relationship Id="rId5" Type="${IMG}" Target="file:///srv/x.png" TargetMode="&ext;"/>`,
      `<Relationship Id="rId5" Type="${IMG}" Target="&path;"/>`,
      `<Relationship Id="rId5" Type="${IMG}" Target=/srv/x.png TargetMode="External"/>`,
    ];
    for (const rel of odd) {
      const { removed } = await sanitizeOoxmlForConversion(await docxLinkingTo('', rel));
      expect(removed.map((r) => r.id), rel).toEqual(['rId5']);
    }
  });

  it.skipIf(!SOFFICE)('even with LibreOffice\'s default profile, the sanitized copies embed nothing from the server disk', async () => {
    const plain = async (input: Buffer) => {
      const work = mkdtempSync(join(dir, 'plain-'));
      writeFileSync(join(work, 'in.docx'), input);
      await runCommand(SOFFICE!, [`-env:UserInstallation=${pathToFileURL(join(work, 'profile')).href}`, '--headless', '--norestore', '--convert-to', 'pdf', '--outdir', work, join(work, 'in.docx')], {
        timeoutMs: 170_000,
        cwd: work,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: work, LANG: 'C.UTF-8', TMPDIR: work },
      });
      return readFileSync(join(work, 'in.pdf'));
    };
    for (const [what, rel] of Object.entries(variants(secret))) {
      const sanitized = (await sanitizeOoxmlForConversion(await docxLinkingTo('', rel))).data;
      expect(await imagesInPdf(await plain(sanitized)), what).toBe(0);
    }
  }, 600_000);
});
