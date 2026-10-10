// Anki-compatible export (§43, §46): Anki's documented TEXT import format with file headers
// (https://docs.ankiweb.net/importing/text-files.html — #separator, #html, #notetype, #deck, #tags, #columns,
// #guid column, #tags column). NOT .apkg (not produced, never claimed).
//
//  * medlevo-basic.txt  notetype Basic : GUID · Front · Back · Source · Tags   (basic, mistake and occlusion cards)
//  * medlevo-cloze.txt  notetype Cloze : GUID · Text · Back Extra · Source · Tags  (one NOTE per cloze text — Anki makes
//                                         one card per {{cN::}} itself; the syntax is identical)
//  * media/             images referenced by <img src> (occlusion cards: a masked question image and an answer image
//                       rendered from the original PNG; file names carry the card id only, never the answer)
// Only basic cards and no media → a single .txt; otherwise a ZIP with the files and a README (how to import, and
// that media files must be copied into Anki's collection.media folder — Anki's text import does not copy media).
// Every note carries its citation twice: in the Source column (plain) and appended to the back (HTML), so it is never
// lost even when the Source column is not mapped to a field.
import JSZip from 'jszip';
import { CLOZE_PATTERN, parseRichText, type CardEvidenceSnapshot, type RichText } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson } from '../../db/db';
import { decodePng, encodePng, isPng, type RgbaImage } from '../processing/png';
import type { FlashcardRow, ImageSpec } from './store';

export interface AnkiExportOptions {
  sourceId?: string | null;
  deck?: string | null;
  includeSuspended?: boolean;
}

export interface AnkiExportResult {
  kind: 'tsv' | 'zip';
  filename: string;
  mime: string;
  body: Buffer;
  report: { basic_notes: number; cloze_notes: number; media_files: number; skipped: Array<{ card_id: string; reason_ar: string }> };
}

// ───────── HTML for fields ─────────
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** RichText → HTML: one <div dir> per paragraph; LTR runs isolated inside RTL paragraphs; marks kept. */
export function richToHtml(rt: RichText): string {
  return rt.paragraphs
    .map((p) => {
      const inner = p.runs
        .map((r) => {
          let h = escapeHtml(r.t);
          for (const m of r.marks ?? []) {
            const tag = m === 'em' ? 'em' : m;
            h = `<${tag}>${h}</${tag}>`;
          }
          if (r.dir && r.dir !== p.dir) h = `<span dir=${r.dir}>${h}</span>`;
          return h;
        })
        .join('');
      return `<div dir=${p.dir}>${inner}</div>`;
    })
    .join('');
}

/**
 * Cloze text → HTML WITHOUT run-level spans: a span inside «{{c1::…}}» would break Anki's cloze markup. With `keep`,
 * only those indexes stay cloze markers; the others become plain text (Anki would otherwise re-create a card the owner
 * deleted, suspended or did not select for this export).
 */
export function clozeHtml(rt: RichText, keep?: ReadonlySet<number>): string {
  return rt.paragraphs
    .map((p) => {
      let text = p.runs.map((r) => r.t).join('');
      if (keep) text = text.replace(CLOZE_PATTERN, (m: string, n: string, answer: string) => (keep.has(Number(n)) ? m : answer));
      return `<div dir=${p.dir}>${escapeHtml(text)}</div>`;
    })
    .join('');
}

/**
 * A TSV field: no tab, no newline, no raw double quote (Anki's reader treats quotes as CSV quoting). Text quotes are
 * already escaped as &quot; and the generated HTML uses unquoted attribute values (dir=rtl, src=medlevo-….png), which
 * HTML allows for single-token values.
 */
export function tsvField(s: string): string {
  return s.replace(/\r\n|\r|\n/g, '<br>').replace(/\t/g, ' ').replace(/"/g, '&quot;');
}

/** An Anki tag: letters, digits, «_» and «-» only (no spaces, «::» hierarchy, quotes or markup from a title). */
function tag(s: string): string {
  return s.replace(/[^\p{L}\p{M}\p{N}_-]+/gu, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 60);
}

function snapshots(r: FlashcardRow, available: Set<string>): CardEvidenceSnapshot[] {
  const snaps = fromJson<Array<Omit<CardEvidenceSnapshot, 'available'>>>(r.evidence_snapshot_json, []) ?? [];
  return snaps.map((s) => ({ ...s, available: available.has(s.evidence_id) }));
}

/** The Source column (the file is #html:true, so the text is escaped like every other field). */
function citationPlain(snaps: CardEvidenceSnapshot[], fallback: string | null): string {
  if (snaps.length === 0) return escapeHtml(fallback ?? '');
  return escapeHtml(snaps.map((s) => `${s.source_title} — ${s.locator_label_ar}${s.available ? '' : ' (غير متاح الآن)'}`).join(' | '));
}

function citationHtml(snaps: CardEvidenceSnapshot[], fallback: string | null): string {
  if (snaps.length === 0) return fallback ? `<div class=medlevo-source dir=rtl>المصدر: ${escapeHtml(fallback)}</div>` : '';
  return snaps
    .map(
      (s) =>
        `<div class=medlevo-source dir=rtl>المصدر: ${escapeHtml(s.source_title)} — ${escapeHtml(s.locator_label_ar)}${s.available ? '' : ' (غير متاح الآن)'}: «${escapeHtml(s.quote.length > 400 ? `${s.quote.slice(0, 399)}…` : s.quote)}»</div>`,
    )
    .join('');
}

// ───────── occlusion images ─────────
const OTHER_MASK: [number, number, number] = [150, 150, 150];
const ACTIVE_MASK: [number, number, number] = [214, 110, 30];

function fillRect(img: RgbaImage, box: { x: number; y: number; w: number; h: number }, rgb: [number, number, number], outlineOnly = false): void {
  const x0 = Math.max(0, Math.floor(box.x * img.width));
  const y0 = Math.max(0, Math.floor(box.y * img.height));
  const x1 = Math.min(img.width, Math.ceil((box.x + box.w) * img.width));
  const y1 = Math.min(img.height, Math.ceil((box.y + box.h) * img.height));
  const t = Math.max(2, Math.round(Math.min(img.width, img.height) / 200));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (outlineOnly && x >= x0 + t && x < x1 - t && y >= y0 + t && y < y1 - t) continue;
      const i = (y * img.width + x) * 4;
      img.data[i] = rgb[0];
      img.data[i + 1] = rgb[1];
      img.data[i + 2] = rgb[2];
      img.data[i + 3] = 255;
    }
  }
}

function occlusionImages(png: Buffer, spec: ImageSpec): { q: Buffer; a: Buffer } {
  const base = decodePng(png);
  const q: RgbaImage = { width: base.width, height: base.height, data: new Uint8Array(base.data) };
  const a: RgbaImage = { width: base.width, height: base.height, data: new Uint8Array(base.data) };
  for (const m of spec.masks) {
    const active = m.id === spec.active_mask_id;
    fillRect(q, m.box, active ? ACTIVE_MASK : OTHER_MASK);
    if (active) fillRect(a, m.box, ACTIVE_MASK, true);
    else fillRect(a, m.box, OTHER_MASK);
  }
  return { q: encodePng(q), a: encodePng(a) };
}

// ───────── export ─────────
const BASIC_HEADER = (deck: string) =>
  ['#separator:tab', '#html:true', '#notetype:Basic', `#deck:${deck}`, '#tags:medlevo', '#columns:GUID\tFront\tBack\tSource\tTags', '#guid column:1', '#tags column:5'].join('\n');
const CLOZE_HEADER = (deck: string) =>
  ['#separator:tab', '#html:true', '#notetype:Cloze', `#deck:${deck}`, '#tags:medlevo', '#columns:GUID\tText\tBack Extra\tSource\tTags', '#guid column:1', '#tags column:5'].join('\n');

export async function exportAnki(ctx: AppContext, o: AnkiExportOptions): Promise<AnkiExportResult> {
  const deck = (o.deck ?? '').replace(/[\r\n\t#]+/g, ' ').trim().slice(0, 100) || 'MedLevo';
  const params: unknown[] = [];
  let where = 'f.deleted_at IS NULL';
  if (!o.includeSuspended) where += ' AND f.suspended = 0';
  if (o.sourceId) {
    where += ' AND f.source_id = ?';
    params.push(o.sourceId);
  }
  const rows = ctx.db.all<FlashcardRow & { source_title: string | null }>(
    `SELECT f.*, s.title AS source_title FROM flashcard f LEFT JOIN source s ON s.id = f.source_id WHERE ${where} ORDER BY f.created_at, f.id`,
    params,
  );
  const evIds = [...new Set(rows.flatMap((r) => (fromJson<Array<{ evidence_id: string }>>(r.evidence_snapshot_json, []) ?? []).map((s) => s.evidence_id)))];
  const available = new Set<string>();
  for (let i = 0; i < evIds.length; i += 400) {
    const part = evIds.slice(i, i + 400);
    for (const e of ctx.db.all<{ id: string }>(
      `SELECT e.id FROM evidence e JOIN source s ON s.id = e.source_id WHERE s.deleted_at IS NULL AND e.id IN (${part.map(() => '?').join(',')})`,
      part,
    ))
      available.add(e.id);
  }

  const basic: string[] = [];
  const cloze: string[] = [];
  const media = new Map<string, Buffer>();
  const skipped: AnkiExportResult['report']['skipped'] = [];
  const seenNotes = new Set<string>();
  // cloze indexes exported per note (deleted / suspended / filtered-out siblings stay plain text in the note)
  const clozeKeep = new Map<string, Set<number> | null>();
  for (const r of rows) {
    if (r.kind !== 'cloze') continue;
    const noteId = r.note_id ?? r.id;
    const set = clozeKeep.has(noteId) ? clozeKeep.get(noteId)! : new Set<number>();
    clozeKeep.set(noteId, set === null || r.cloze_index === null ? null : set.add(r.cloze_index));
  }
  for (const r of rows) {
    const snaps = snapshots(r, available);
    const fallback = r.source_title;
    const tags = ['medlevo', `medlevo::${r.kind}`, ...(r.source_title ? [`medlevo::source::${tag(r.source_title)}`] : [])].join(' ');
    const front = parseRichText(fromJson(r.front_json));
    const back = parseRichText(fromJson(r.back_json));
    if (r.kind === 'cloze') {
      const noteId = r.note_id ?? r.id;
      if (seenNotes.has(noteId)) continue; // one Anki note per cloze text
      seenNotes.add(noteId);
      cloze.push([noteId, clozeHtml(front, clozeKeep.get(noteId) ?? undefined), richToHtml(back) + citationHtml(snaps, fallback), citationPlain(snaps, fallback), tags].map(tsvField).join('\t'));
      continue;
    }
    if (r.kind === 'image_occlusion') {
      const spec = fromJson<ImageSpec>(r.image_json);
      const fileId = spec ? ctx.db.get<{ file_id: string | null }>('SELECT file_id FROM image_asset WHERE id = ?', [spec.image_asset_id])?.file_id : null;
      if (!spec || !fileId || !ctx.files.stat(fileId)) {
        skipped.push({ card_id: r.id, reason_ar: 'صورة البطاقة لم تعد متاحة على الخادم.' });
        continue;
      }
      const bytes = await ctx.files.read(fileId);
      if (!isPng(bytes)) {
        skipped.push({ card_id: r.id, reason_ar: 'الصورة ليست PNG؛ لا يستطيع هذا الإصدار رسم مناطق الإخفاء عليها للتصدير.' });
        continue;
      }
      let imgs: { q: Buffer; a: Buffer };
      try {
        imgs = occlusionImages(bytes, spec);
      } catch {
        skipped.push({ card_id: r.id, reason_ar: 'تعذّرت قراءة الصورة (صيغة PNG غير مدعومة مثل المتداخلة) لرسم مناطق الإخفاء.' });
        continue;
      }
      const qName = `medlevo-${r.id}-q.png`;
      const aName = `medlevo-${r.id}-a.png`;
      media.set(qName, imgs.q);
      media.set(aName, imgs.a);
      basic.push(
        [
          r.id,
          `<img src=${qName}>${richToHtml(front)}`,
          `<img src=${aName}>${richToHtml(back)}${citationHtml(snaps, fallback)}`,
          citationPlain(snaps, fallback),
          tags,
        ]
          .map(tsvField)
          .join('\t'),
      );
      continue;
    }
    basic.push([r.id, richToHtml(front), richToHtml(back) + citationHtml(snaps, fallback), citationPlain(snaps, fallback), tags].map(tsvField).join('\t'));
  }

  const basicFile = `${BASIC_HEADER(deck)}\n${basic.join('\n')}${basic.length ? '\n' : ''}`;
  const report = { basic_notes: basic.length, cloze_notes: cloze.length, media_files: media.size, skipped };
  if (cloze.length === 0 && media.size === 0) {
    return { kind: 'tsv', filename: 'medlevo-basic.txt', mime: 'text/plain; charset=utf-8', body: Buffer.from(basicFile, 'utf8'), report };
  }
  const zip = new JSZip();
  if (basic.length) zip.file('medlevo-basic.txt', basicFile);
  if (cloze.length) zip.file('medlevo-cloze.txt', `${CLOZE_HEADER(deck)}\n${cloze.join('\n')}\n`);
  for (const [name, buf] of media) zip.file(`media/${name}`, buf);
  zip.file('README.txt', readme(report));
  const body = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { kind: 'zip', filename: 'medlevo-anki-export.zip', mime: 'application/zip', body, report };
}

function readme(r: AnkiExportResult['report']): string {
  const lines = [
    'MedLevo — تصدير بطاقات بصيغة استيراد النصوص في Anki (Anki text import)',
    '',
    'هذا الملف ليس حزمة .apkg. يحتوي ملفات نصية بصيغة الاستيراد المعلنة في Anki مع رؤوس الملفات (#separator، #html، #notetype، #deck، #tags، #columns).',
    `• medlevo-basic.txt — ملاحظات من نوع Basic (${r.basic_notes}).`,
    `• medlevo-cloze.txt — ملاحظات من نوع Cloze (${r.cloze_notes})؛ ينشئ Anki بطاقة لكل فراغ.`,
    `• media/ — ${r.media_files} صورة تشير إليها البطاقات.`,
    '',
    'طريقة الاستيراد: في Anki اختر File ← Import ثم الملف النصي. إن كانت أسماء أنواع الملاحظات في Anki لديك بلغة أخرى فاختر Basic أو Cloze يدويًا في نافذة الاستيراد.',
    'الصور: انسخ محتوى مجلد media إلى مجلد collection.media في ملف Anki الخاص بك قبل المراجعة؛ استيراد النصوص في Anki لا ينسخ الصور تلقائيًا.',
    'عمود Source يحمل المصدر والصفحة، والمصدر مضاف أيضًا إلى ظهر كل بطاقة حتى لا يضيع إن لم تربط العمود بحقل.',
  ];
  if (r.skipped.length) {
    lines.push('', 'بطاقات لم تُصدَّر:');
    for (const s of r.skipped) lines.push(`• ${s.card_id}: ${s.reason_ar}`);
  }
  lines.push(
    '',
    'English: Anki text-import files (not .apkg). Import each .txt with File > Import; pick the Basic / Cloze note type if your Anki uses localized names. Copy the files in media/ into your collection.media folder (text import does not copy media).',
  );
  return `${lines.join('\n')}\n`;
}
