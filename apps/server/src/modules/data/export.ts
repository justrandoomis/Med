// Exports (§46): a source (its extracted text by page + the owner's writing on it), a study artifact (Study Book,
// summary, explanation — generated, labelled, with claim-level citations), notes, questions, and a full JSON export.
//   md   — Markdown, citations as text: «المصدر — ص 12 (الصفحة 14 في الملف) — الإصدار 1» + the evidence quote
//   html — print-ready RTL HTML with bidi-isolated terms; PDF = the browser's «print → save as PDF» (said plainly)
//   json — structured data + a `manifest` of ids, versions/revs and content hashes (files are referenced by sha256)
// Views come from the real routes (forwarded in-process as the owner), so the export shows exactly what the app
// shows: labels, verification states, availability. Nothing is invented; an internal location never becomes a link.
import { createHash } from 'node:crypto';
import {
  ANSWER_STATUS_LABELS_AR,
  EXPORT_FORMAT_FORMAT,
  pageDisplayLabel,
  type ClaimView,
  type ContentBlockView,
  type EvidenceView,
  type ExportFormat,
  type ExportKind,
  type ExportManifest,
  type NoteDTO,
  type PageRegionsResponse,
  type QuestionDetailResponse,
  type RichText,
  type SourceAnnotationsResponse,
  type SourceDetail,
  type SourcePagesResponse,
  type StudyArtifactView,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { describeAnchorAr } from '../annotations/repo';
import { SECRET_SETTING_KEY, SECRET_VALUE } from './backup';
import { DOCX_MIME, DocxCitations, buildDocx, bullet, heading, para, richTextBlocks, tableBlock, textSegs, type DocBlock } from './docx';
import type { Forward } from './offline';
import {
  citationLabel,
  escapeHtml,
  htmlDocument,
  inlineHtml,
  mdEscape,
  richTextPlain,
  richTextToHtml,
  richTextToMarkdown,
  textToHtml,
  type ClaimMarkerFn,
} from './render';

export interface ExportFile {
  fileName: string;
  contentType: string;
  /** text formats are strings; DOCX (track F5) is a binary zip */
  body: string | Buffer;
}

const sha = (v: unknown) => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');

export const GENERATED_LABEL_AR =
  'محتوى مولَّد بواسطة MedLevo من المصادر المحددة — ليس مصدرًا طبيًا مستقلًا. كل جملة طبية فيه مرتبطة بدليل من المصدر؛ وما لم يُتحقق منه بعدُ مُعلَّم بذلك.';

const ASIDE_AR: Partial<Record<ContentBlockView['kind'], string>> = {
  clinical_note: 'ملاحظة سريرية',
  exam_pearl: 'لؤلؤة امتحانية',
  mini_question: 'سؤال للتحقق من الفهم',
  memory_hook: 'وسيلة حفظ (مولّدة)',
  example: 'مثال تعليمي مولّد — ليس حالة حقيقية',
  warning: 'تنبيه',
  coverage_note: 'ملاحظة عن التغطية',
  original_quote: 'اقتباس حرفي من المصدر',
  term: 'مصطلح',
  figure: 'شكل',
  flowchart: 'مخطط',
};

const CLAIM_STATUS_AR: Record<string, string | null> = {
  linked: null,
  owner_reviewed: null,
  needs_review: 'لم يُتحقق منه بعد',
  pending: 'لم يُتحقق منه بعد',
  conflict: 'تعارض مع الدليل',
  rejected: 'مرفوض',
};

const RELATION_AR: Record<string, string> = {
  supports: '',
  partially_supports: ' (يدعم جزئيًا)',
  context: ' (سياق)',
  contradicts: ' (يناقض)',
};

function safeName(s: string): string {
  // eslint-disable-next-line no-control-regex -- a file name never carries control characters
  const base = s.normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return base || 'medlevo-export';
}

function fileFor(kind: string, title: string, format: ExportFormat, body: string | Buffer): ExportFile {
  const ext = format === 'md' ? 'md' : format === 'json' ? 'json' : format === 'docx' ? 'docx' : 'html';
  const contentType =
    format === 'md' ? 'text/markdown; charset=utf-8' : format === 'json' ? 'application/json; charset=utf-8' : format === 'docx' ? DOCX_MIME : 'text/html; charset=utf-8';
  return { fileName: `${safeName(`${kind} - ${title}`)}.${ext}`, contentType, body };
}

async function getJson<T>(forward: Forward, path: string, notFoundAr: string): Promise<T> {
  const r = await forward(path);
  if (r.status === 404) throw new AppError('NOT_FOUND', notFoundAr, 404);
  if (r.status !== 200) throw new AppError('INTERNAL', 'تعذّر تجهيز محتوى التصدير على الخادم. أعد المحاولة.', 500);
  return JSON.parse(r.body) as T;
}

function manifestOf(ctx: AppContext, kind: ExportKind, entities: ExportManifest['entities'], files: ExportManifest['files'], notes: string[]): ExportManifest {
  return { format: EXPORT_FORMAT_FORMAT, kind, exported_at: ctx.clock.now(), app_version: ctx.config.appVersion, entities, files, notes_ar: notes };
}

function fileRefs(ctx: AppContext, ids: Array<{ id: string | null; role: string }>): ExportManifest['files'] {
  const out: ExportManifest['files'] = [];
  const seen = new Set<string>();
  for (const { id, role } of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const f = ctx.db.get<{ id: string; sha256: string; size: number; mime: string }>('SELECT id, sha256, size, mime FROM stored_file WHERE id = ?', [id]);
    if (f) out.push({ file_id: f.id, sha256: f.sha256, size: f.size, mime: f.mime, role });
  }
  return out;
}

// ───────────────────────────── citations ─────────────────────────────
class Footnotes {
  private readonly order = new Map<string, number>();
  private readonly items: Array<{ n: number; ev: EvidenceView; relation: string }> = [];

  constructor(private readonly claims: Record<string, ClaimView>) {}

  marker: ClaimMarkerFn = (claimId) => {
    const claim = this.claims[claimId];
    if (!claim) return null;
    const nums: number[] = [];
    for (const c of claim.citations) {
      let n = this.order.get(c.evidence.id);
      if (n === undefined) {
        n = this.items.length + 1;
        this.order.set(c.evidence.id, n);
        this.items.push({ n, ev: c.evidence, relation: c.relation });
      }
      nums.push(n);
    }
    const status = CLAIM_STATUS_AR[claim.verification_status] ?? null;
    const md = `${nums.map((n) => `[^${n}]`).join('')}${status ? ` (${status})` : ''}`;
    const html = `${nums.map((n) => `<sup class="cite">[${n}]</sup>`).join('')}${status ? ` <span class="unverified">(${escapeHtml(status)})</span>` : ''}`;
    return md || html ? { md: md ? ` ${md}`.replace(/^ (\[)/, '$1') : '', html } : null;
  };

  markdown(): string {
    if (!this.items.length) return '';
    return [
      '## الأدلة المستشهد بها',
      '',
      ...this.items.map((i) => `[^${i.n}]: ${mdEscape(citationLabel(i.ev))}${RELATION_AR[i.relation] ?? ''}: «${mdEscape(i.ev.quote)}»`),
    ].join('\n');
  }

  html(): string {
    if (!this.items.length) return '';
    return `<h2>الأدلة المستشهد بها</h2>\n<ol class="citations">\n${this.items
      .map(
        (i) =>
          `<li value="${i.n}" dir="rtl" lang="ar">${inlineHtml(citationLabel(i.ev))}${escapeHtml(RELATION_AR[i.relation] ?? '')}<span class="quote">«${inlineHtml(i.ev.quote, /[؀-ۿ]/.test(i.ev.quote) ? 'rtl' : 'ltr')}»</span></li>`,
      )
      .join('\n')}\n</ol>`;
  }
}

function tableToMarkdown(t: NonNullable<ContentBlockView['table']>, marker: ClaimMarkerFn): string {
  const cell = (rt: RichText) => richTextToMarkdown(rt, marker).replace(/\n+/g, ' / ');
  const head = t.header.map(cell);
  const sep = head.map(() => '---');
  return [`| ${head.join(' | ')} |`, `| ${sep.join(' | ')} |`, ...t.rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');
}

function tableToHtml(t: NonNullable<ContentBlockView['table']>, marker: ClaimMarkerFn): string {
  const cell = (rt: RichText, tag: 'th' | 'td') => `<${tag}>${richTextToHtml(rt, marker)}</${tag}>`;
  return `<table><thead><tr>${t.header.map((h) => cell(h, 'th')).join('')}</tr></thead><tbody>${t.rows.map((r) => `<tr>${r.map((c) => cell(c, 'td')).join('')}</tr>`).join('')}</tbody></table>`;
}

// ───────────────────────────── artifact (Study Book / summary / explanation) ─────────────────────────────
export async function exportArtifact(ctx: AppContext, forward: Forward, artifactId: string, format: ExportFormat): Promise<ExportFile> {
  const { artifact: a } = await getJson<{ artifact: StudyArtifactView }>(forward, `/api/studybook/artifacts/${encodeURIComponent(artifactId)}`, 'المحتوى المطلوب تصديره غير موجود.');
  const title = a.title ?? 'محتوى مولَّد';
  const blocks = a.blocks.filter((b) => b.status !== 'rejected').sort((x, y) => x.ord - y.ord);
  const statusNote =
    a.status === 'stale'
      ? `تنبيه: هذا المحتوى قديم لأن المصدر تغيّر${a.stale_reason ? ` (${a.stale_reason})` : ''}.`
      : a.status === 'partial'
        ? 'تنبيه: هذا المحتوى ناقص — بعض الأقسام لم تكتمل.'
        : a.status === 'published'
          ? null
          : `حالة المحتوى: ${a.status}.`;
  const meta = [
    `النطاق: ${a.scope.describe_ar}`,
    `الإصدار ${a.version_no}${a.is_frozen ? ' (مثبّت)' : ''}`,
    `قواعد الشرح: ${a.rules_version}`,
    a.model ? `النموذج: ${a.model}` : null,
    `نُشر: ${new Date(a.published_at ?? a.created_at).toISOString()}`,
  ].filter((x): x is string => !!x);

  if (format === 'json') {
    const manifest = manifestOf(
      ctx,
      'artifact',
      [
        { type: 'artifact', id: a.id, version: a.version_no, sha256: sha(a) },
        ...Object.values(a.claims).flatMap((c) => c.citations.map((ci) => ({ type: 'evidence', id: ci.evidence.id, version: ci.evidence.version_no, sha256: sha(ci.evidence.quote) }))),
      ],
      [],
      [GENERATED_LABEL_AR, 'الأدلة مُعرّفة بمعرّفاتها وإصدار مصدرها ونص الاقتباس؛ لا روابط داخلية.'],
    );
    return fileFor('كتاب', title, format, JSON.stringify({ manifest, generated: true, generated_label_ar: GENERATED_LABEL_AR, artifact: a }, null, 2));
  }

  if (format === 'docx') {
    // (track F5) Word: the same content, RTL paragraphs, isolated LTR runs, citations as numbered text
    const cites = new DocxCitations(a.claims);
    const out: DocBlock[] = [heading(title, 1), para(GENERATED_LABEL_AR, 'generated'), para(meta.join(' · '), 'meta')];
    if (statusNote) out.push(para(statusNote, 'label'));
    for (const b of blocks) {
      const label = ASIDE_AR[b.kind];
      if (b.kind === 'comparison_table' && b.table) out.push(tableBlock(b.table, cites.marker));
      else if (label) out.push(para(label, 'aside', { b: true }), ...richTextBlocks(b.content, cites.marker, 'aside'));
      else out.push(...richTextBlocks(b.content, cites.marker));
    }
    if (a.abstain) out.push(para(`امتنع المولّد عن الإجابة: ${a.abstain.reason_ar}`, 'label'));
    if (a.coverage?.missing_ar?.length) out.push(heading('غير مغطّى في المصادر المسموحة', 2), ...a.coverage.missing_ar.map(bullet));
    out.push(...cites.blocks());
    return fileFor('كتاب', title, format, await buildDocx(title, out, { description: GENERATED_LABEL_AR }));
  }

  const notes = new Footnotes(a.claims);
  if (format === 'md') {
    const out: string[] = [`# ${mdEscape(title)}`, '', `> ${GENERATED_LABEL_AR}`, '>', `> ${meta.map(mdEscape).join(' · ')}`];
    if (statusNote) out.push('>', `> ${mdEscape(statusNote)}`);
    out.push('');
    for (const b of blocks) {
      const label = ASIDE_AR[b.kind];
      if (b.kind === 'comparison_table' && b.table) out.push(tableToMarkdown(b.table, notes.marker));
      else if (label) out.push(`> **${label}:**`, '>', ...richTextToMarkdown(b.content, notes.marker).split('\n').map((l) => `> ${l}`));
      else out.push(richTextToMarkdown(b.content, notes.marker));
      out.push('');
    }
    if (a.abstain) out.push(`> امتنع المولّد عن الإجابة: ${mdEscape(a.abstain.reason_ar)}`, '');
    if (a.coverage?.missing_ar?.length) out.push('**غير مغطّى في المصادر المسموحة:**', '', ...a.coverage.missing_ar.map((m) => `- ${mdEscape(m)}`), '');
    out.push(notes.markdown());
    return fileFor('كتاب', title, format, out.join('\n').trim() + '\n');
  }

  const body: string[] = [
    textToHtml(title, 'h2').replace(/^<h2/, '<h1').replace(/h2>$/, 'h1>'),
    `<p class="label generated">${escapeHtml(GENERATED_LABEL_AR)}</p>`,
    `<p class="meta">${meta.map((m) => inlineHtml(m)).join(' · ')}</p>`,
  ];
  if (statusNote) body.push(`<p class="label">${inlineHtml(statusNote)}</p>`);
  for (const b of blocks) {
    const label = ASIDE_AR[b.kind];
    if (b.kind === 'comparison_table' && b.table) body.push(tableToHtml(b.table, notes.marker));
    else if (label) body.push(`<div class="aside"><span class="aside-title">${escapeHtml(label)}</span>${richTextToHtml(b.content, notes.marker)}</div>`);
    else body.push(richTextToHtml(b.content, notes.marker));
  }
  if (a.abstain) body.push(`<p class="label">${inlineHtml(`امتنع المولّد عن الإجابة: ${a.abstain.reason_ar}`)}</p>`);
  if (a.coverage?.missing_ar?.length) body.push(`<h2>غير مغطّى في المصادر المسموحة</h2><ul>${a.coverage.missing_ar.map((m) => textToHtml(m, 'li')).join('')}</ul>`);
  body.push(notes.html());
  return fileFor('كتاب', title, format, htmlDocument(title, body.join('\n')));
}

// ───────────────────────────── notes ─────────────────────────────
function noteOriginLabel(n: NoteDTO): string | null {
  if (n.origin === 'ai_answer') return 'إجابة مولَّدة محفوظة كملاحظة — ليست مصدرًا مستقلًا';
  if (n.origin === 'handwriting_recognition') return 'نص مقروء آليًا من خط اليد — قد يحتوي أخطاء';
  return null;
}

interface NoteRow {
  id: string;
  node_id: string | null;
  title: string | null;
  body_json: string;
  anchor_json: string | null;
  origin: NoteDTO['origin'];
  ai_record_json: string | null;
  rev: number;
  conflict_of_id: string | null;
  device_id: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

function noteDto(r: NoteRow): NoteDTO {
  return {
    id: r.id,
    node_id: r.node_id,
    title: r.title,
    body: fromJson<RichText>(r.body_json) ?? { v: 1, paragraphs: [] },
    anchor: fromJson(r.anchor_json ?? 'null') ?? null,
    origin: r.origin,
    ai_record: fromJson(r.ai_record_json ?? 'null') ?? null,
    rev: r.rev,
    conflict_of_id: r.conflict_of_id,
    device_id: r.device_id,
    created_at: r.created_at,
    updated_at: r.updated_at,
    deleted_at: r.deleted_at,
  };
}

export function selectNotes(ctx: AppContext, filter: { sourceId?: string; nodeId?: string }): NoteDTO[] {
  const where = ['n.deleted_at IS NULL'];
  const params: unknown[] = [];
  if (filter.sourceId) {
    where.push('n.source_id = ?');
    params.push(filter.sourceId);
  }
  if (filter.nodeId) {
    where.push('n.node_id = ?');
    params.push(filter.nodeId);
  }
  return ctx.db.all<NoteRow>(`SELECT n.* FROM note n WHERE ${where.join(' AND ')} ORDER BY n.created_at, n.id LIMIT 5000`, params).map(noteDto);
}

function notesSection(ctx: AppContext, notes: NoteDTO[], format: 'md' | 'html'): string {
  const out: string[] = [];
  for (const n of notes) {
    const where = describeAnchorAr(ctx.db, n.anchor);
    const origin = noteOriginLabel(n);
    const head = [n.title ?? 'ملاحظة', where.text ? `${where.sourceTitle ? `${where.sourceTitle} — ` : ''}${where.text}` : null].filter((x): x is string => !!x);
    const flags = [origin, n.conflict_of_id ? 'نسخة محفوظة من تعارض بين جهازين' : null].filter((x): x is string => !!x);
    if (format === 'md') {
      out.push(`### ${mdEscape(head[0]!)}`, '');
      if (head[1]) out.push(`*${mdEscape(head[1])}*`, '');
      for (const f of flags) out.push(`> ${mdEscape(f)}`, '');
      out.push(richTextToMarkdown(n.body), '');
    } else {
      out.push(`<section class="note">${textToHtml(head[0]!, 'h3')}`);
      if (head[1]) out.push(`<p class="meta">${inlineHtml(head[1])}</p>`);
      for (const f of flags) out.push(`<p class="label${n.origin === 'ai_answer' ? ' generated' : ''}">${inlineHtml(f)}</p>`);
      out.push(richTextToHtml(n.body), '</section>');
    }
  }
  return out.join('\n');
}

/** (track F5) the notes as DOCX blocks: title, where it is anchored, origin labels (generated / recognized), body. */
function notesDocxBlocks(ctx: AppContext, notes: NoteDTO[]): DocBlock[] {
  const out: DocBlock[] = [];
  for (const n of notes) {
    const where = describeAnchorAr(ctx.db, n.anchor);
    out.push(heading(n.title ?? 'ملاحظة', 3));
    if (where.text) out.push(para(`${where.sourceTitle ? `${where.sourceTitle} — ` : ''}${where.text}`, 'meta'));
    const origin = noteOriginLabel(n);
    if (origin) out.push(para(origin, n.origin === 'ai_answer' ? 'generated' : 'label'));
    if (n.conflict_of_id) out.push(para('نسخة محفوظة من تعارض بين جهازين', 'label'));
    out.push(...richTextBlocks(n.body));
  }
  return out;
}

export async function exportNotesDocx(ctx: AppContext, filter: { sourceId?: string; nodeId?: string }): Promise<ExportFile> {
  const notes = selectNotes(ctx, filter);
  const scopeTitle = filter.sourceId
    ? ctx.db.get<{ title: string }>('SELECT title FROM source WHERE id = ?', [filter.sourceId])?.title ?? 'مصدر'
    : filter.nodeId
      ? ctx.db.get<{ title: string }>('SELECT title FROM library_node WHERE id = ?', [filter.nodeId])?.title ?? 'مجلد'
      : 'كل الملاحظات';
  const title = `ملاحظاتي — ${scopeTitle}`;
  const blocks = [heading(title, 1), ...(notes.length ? notesDocxBlocks(ctx, notes) : [para('لا توجد ملاحظات في هذا النطاق.')])];
  return fileFor('ملاحظات', scopeTitle, 'docx', await buildDocx(title, blocks));
}

export function exportNotes(ctx: AppContext, filter: { sourceId?: string; nodeId?: string }, format: ExportFormat): ExportFile {
  const notes = selectNotes(ctx, filter);
  const scopeTitle = filter.sourceId
    ? ctx.db.get<{ title: string }>('SELECT title FROM source WHERE id = ?', [filter.sourceId])?.title ?? 'مصدر'
    : filter.nodeId
      ? ctx.db.get<{ title: string }>('SELECT title FROM library_node WHERE id = ?', [filter.nodeId])?.title ?? 'مجلد'
      : 'كل الملاحظات';
  const title = `ملاحظاتي — ${scopeTitle}`;
  if (format === 'json') {
    const manifest = manifestOf(ctx, 'notes', notes.map((n) => ({ type: 'note', id: n.id, version: n.rev, sha256: sha(n) })), [], [
      'الملاحظات بصيغتها المنظمة (RichText) كما حُفظت؛ الإجابات المولّدة محفوظة بأصلها origin=ai_answer.',
    ]);
    return fileFor('ملاحظات', scopeTitle, format, JSON.stringify({ manifest, notes }, null, 2));
  }
  if (format === 'md') {
    const body = [`# ${mdEscape(title)}`, '', notes.length ? notesSection(ctx, notes, 'md') : 'لا توجد ملاحظات في هذا النطاق.'];
    return fileFor('ملاحظات', scopeTitle, format, body.join('\n') + '\n');
  }
  return fileFor('ملاحظات', scopeTitle, format, htmlDocument(title, `${textToHtml(title, 'h2').replace(/^<h2/, '<h1').replace(/h2>$/, 'h1>')}\n${notes.length ? notesSection(ctx, notes, 'html') : '<p>لا توجد ملاحظات في هذا النطاق.</p>'}`));
}

// ───────────────────────────── source ─────────────────────────────
export async function exportSource(ctx: AppContext, forward: Forward, sourceId: string, versionId: string | null, format: ExportFormat): Promise<ExportFile> {
  const S = encodeURIComponent(sourceId);
  const detail = await getJson<SourceDetail>(forward, `/api/sources/${S}`, 'المصدر غير موجود.');
  const vid = versionId ?? detail.active_version_id ?? detail.frozen_version_id ?? detail.current_version_id;
  if (!vid) throw new AppError('CONFLICT', 'لا يوجد إصدار لهذا المصدر بعد.', 409);
  const pagesRes = await getJson<SourcePagesResponse>(forward, `/api/sources/${S}/versions/${encodeURIComponent(vid)}/pages`, 'الإصدار غير موجود لهذا المصدر.');
  const version = pagesRes.version;
  const pages = [...pagesRes.pages].sort((a, b) => a.page_index - b.page_index);
  const regions: PageRegionsResponse[] = [];
  for (const p of pages) regions.push(await getJson<PageRegionsResponse>(forward, `/api/sources/pages/${encodeURIComponent(p.id)}/regions`, 'الصفحة غير موجودة.'));
  const ann = await getJson<SourceAnnotationsResponse>(forward, `/api/annotations/source/${S}?version_id=${encodeURIComponent(vid)}`, 'المصدر غير موجود.');
  const notes = selectNotes(ctx, { sourceId });
  const liveAnn = ann.annotations.filter((a) => !a.deleted_at);
  const highlights = liveAnn.filter((a) => a.kind === 'text_highlight');
  const inkCount = liveAnn.filter((a) => a.kind !== 'text_highlight' && a.kind !== 'bookmark').length;
  const title = detail.title;
  const meta = [`الإصدار ${version.version_no}`, `الصيغة: ${version.format}`, version.file_name ? `الملف: ${version.file_name}` : null, `بصمة المحتوى (sha256): ${version.content_hash}`].filter((x): x is string => !!x);

  if (format === 'json') {
    const files = fileRefs(ctx, [
      { id: version.file_id, role: 'version_file' },
      { id: version.original_file_id, role: 'original_upload' },
      { id: version.display_file_id, role: 'display_pdf' },
      ...pages.map((p) => ({ id: p.render_file_id, role: 'page_render' })),
    ]);
    const manifest = manifestOf(
      ctx,
      'source',
      [
        { type: 'source', id: detail.id, version: version.version_no, sha256: version.content_hash },
        ...pages.map((p) => ({ type: 'source_page', id: p.id, version: version.version_no, sha256: sha(regions.find((r) => r.page.id === p.id)?.regions ?? []) })),
        ...liveAnn.map((a) => ({ type: 'annotation', id: a.id, version: a.rev, sha256: sha(a) })),
        ...notes.map((n) => ({ type: 'note', id: n.id, version: n.rev, sha256: sha(n) })),
      ],
      files,
      ['الملفات الأصلية غير مضمّنة في هذا الملف؛ هي مُعرّفة ببصمة sha256 وموجودة في النسخة الاحتياطية.', 'النص المستخرج كما خزّنه الخادم (رقمي أو OCR) دون تعديل.'],
    );
    return fileFor('مصدر', title, format, JSON.stringify({ manifest, source: detail, version, pages: regions, annotations: liveAnn, note_pages: ann.note_pages, notes }, null, 2));
  }

  const pageText = (r: PageRegionsResponse) =>
    r.regions
      .filter((x) => x.text && x.kind !== 'header' && x.kind !== 'footer' && x.kind !== 'table_cell' && x.status !== 'rejected' && x.text_origin !== 'vision')
      .sort((a, b) => a.reading_order - b.reading_order);
  const ocrNote = (t: string) => (t === 'ocr' || t === 'mixed' ? 'نص مقروء آليًا (OCR) — قد يحتوي أخطاء' : t === 'no_text_found' || t === 'needs_ocr' || t === 'failed' ? 'لا يوجد نص مقروء لهذه الصفحة' : null);
  const hlOn = (pageId: string) => highlights.filter((h) => h.anchor.type === 'page' && h.anchor.page_id === pageId);

  if (format === 'docx') {
    const out: DocBlock[] = [heading(title, 1), para(meta.join(' · '), 'meta'), para('النص المستخرج من الملف الأصلي، صفحة صفحة، مع ما كتبته عليه.', 'label')];
    if (inkCount) out.push(para(`لا تُصدَّر الكتابة بالقلم (${inkCount} عنصر) في ملف Word؛ هي محفوظة في تصدير JSON وفي النسخة الاحتياطية.`, 'label'));
    for (const r of regions) {
      out.push(heading(pageDisplayLabel(r.page), 2));
      const note = ocrNote(r.page.text_status);
      if (note) out.push(para(note, 'meta'));
      for (const reg of pageText(r)) {
        for (const line of reg.text!.split(/\n+/).filter((l) => l.trim())) {
          out.push(reg.kind === 'heading' ? heading(line, 3) : reg.kind === 'list_item' ? bullet(line) : reg.kind === 'caption' ? para(line, 'caption') : para(line));
        }
      }
      for (const h of hlOn(r.page.id)) {
        const q = (h.data as { quote?: { exact?: string } }).quote?.exact;
        if (q) out.push({ kind: 'para', dir: 'rtl', style: 'quote', segs: [...textSegs('تمييزي: «', 'rtl'), ...textSegs(q), ...textSegs('»', 'rtl')] });
      }
    }
    if (notes.length) out.push(heading('ملاحظاتي على هذا المصدر', 2), ...notesDocxBlocks(ctx, notes));
    return fileFor('مصدر', title, format, await buildDocx(title, out));
  }

  if (format === 'md') {
    const out: string[] = [`# ${mdEscape(title)}`, '', `> النص المستخرج من الملف الأصلي، صفحة صفحة، مع ما كتبته عليه. ${meta.map(mdEscape).join(' · ')}`, ''];
    if (inkCount) out.push(`> لا تُصدَّر الكتابة بالقلم (${inkCount} عنصر) في Markdown؛ هي محفوظة في تصدير JSON وفي النسخة الاحتياطية.`, '');
    for (const r of regions) {
      out.push(`## ${mdEscape(pageDisplayLabel(r.page))}`, '');
      const note = ocrNote(r.page.text_status);
      if (note) out.push(`*${note}*`, '');
      for (const reg of pageText(r)) {
        const t = mdEscape(reg.text!);
        out.push(reg.kind === 'heading' ? `### ${t}` : reg.kind === 'list_item' ? `- ${t}` : reg.kind === 'caption' ? `*${t}*` : t, '');
      }
      for (const h of hlOn(r.page.id)) {
        const q = (h.data as { quote?: { exact?: string } }).quote?.exact;
        if (q) out.push(`> تمييزي: «${mdEscape(q)}»`, '');
      }
    }
    if (notes.length) out.push('## ملاحظاتي على هذا المصدر', '', notesSection(ctx, notes, 'md'));
    return fileFor('مصدر', title, format, out.join('\n') + '\n');
  }

  const body: string[] = [textToHtml(title, 'h2').replace(/^<h2/, '<h1').replace(/h2>$/, 'h1>'), `<p class="meta">${meta.map((m) => inlineHtml(m)).join(' · ')}</p>`, '<p class="label">النص المستخرج من الملف الأصلي، صفحة صفحة، مع ما كتبته عليه.</p>'];
  if (inkCount) body.push(`<p class="label">${escapeHtml(`لا تُطبع الكتابة بالقلم (${inkCount} عنصر) في هذا التصدير؛ هي محفوظة في تصدير JSON وفي النسخة الاحتياطية.`)}</p>`);
  for (const r of regions) {
    body.push(`<section class="page"><p class="page-label" dir="rtl" lang="ar">${inlineHtml(pageDisplayLabel(r.page))}</p>`);
    const note = ocrNote(r.page.text_status);
    if (note) body.push(`<p class="meta">${escapeHtml(note)}</p>`);
    for (const reg of pageText(r)) body.push(textToHtml(reg.text!, reg.kind === 'heading' ? 'h3' : 'p', reg.kind === 'caption' ? 'caption' : undefined));
    for (const h of hlOn(r.page.id)) {
      const q = (h.data as { quote?: { exact?: string } }).quote?.exact;
      if (q) body.push(`<blockquote dir="rtl" lang="ar">تمييزي: «${inlineHtml(q)}»</blockquote>`);
    }
    body.push('</section>');
  }
  if (notes.length) body.push('<h2>ملاحظاتي على هذا المصدر</h2>', notesSection(ctx, notes, 'html'));
  return fileFor('مصدر', title, format, htmlDocument(title, body.join('\n')));
}

// ───────────────────────────── questions ─────────────────────────────
export function selectQuestionIds(ctx: AppContext, filter: { sourceId?: string; lectureSourceId?: string; ids?: string[] }): string[] {
  if (filter.ids?.length) return [...new Set(filter.ids)].slice(0, 2000);
  if (filter.sourceId) {
    return ctx.db
      .all<{ id: string }>(
        `SELECT DISTINCT q.id FROM question q JOIN question_occurrence o ON o.question_id = q.id
         WHERE o.source_id = ? AND q.deleted_at IS NULL ORDER BY o.ord, o.printed_number, q.id LIMIT 2000`,
        [filter.sourceId],
      )
      .map((r) => r.id);
  }
  if (filter.lectureSourceId) {
    return ctx.db
      .all<{ id: string }>(
        `SELECT q.id FROM question q JOIN question_lecture_link l ON l.question_id = q.id
         WHERE l.lecture_source_id = ? AND l.status <> 'rejected' AND q.deleted_at IS NULL ORDER BY q.created_at, q.id LIMIT 2000`,
        [filter.lectureSourceId],
      )
      .map((r) => r.id);
  }
  return ctx.db.all<{ id: string }>('SELECT id FROM question WHERE deleted_at IS NULL ORDER BY created_at, id LIMIT 2000').map((r) => r.id);
}

function answerLine(d: QuestionDetailResponse): { label: string; correct: Set<string> } {
  const v = d.question.current;
  const correct = new Set(v.correct_option_ids ?? []);
  let label = ANSWER_STATUS_LABELS_AR[v.answer_status];
  if (v.answer_status === 'ai_derived') label = `${label} — مولَّد وليس مفتاحًا رسميًا`;
  if (v.answer_status === 'conflicting_key' && v.key_details?.conflict_ar) label = `${label}: ${v.key_details.conflict_ar}`;
  return { label, correct };
}

export async function exportQuestions(
  ctx: AppContext,
  forward: Forward,
  filter: { sourceId?: string; lectureSourceId?: string; ids?: string[] },
  format: ExportFormat,
  includeSolutions: boolean,
): Promise<ExportFile> {
  const ids = selectQuestionIds(ctx, filter);
  const details: QuestionDetailResponse[] = [];
  for (const id of ids) {
    const r = await forward(`/api/questions/${encodeURIComponent(id)}`);
    if (r.status === 200) details.push(JSON.parse(r.body) as QuestionDetailResponse);
  }
  const scopeTitle = filter.sourceId
    ? ctx.db.get<{ title: string }>('SELECT title FROM source WHERE id = ?', [filter.sourceId])?.title ?? 'مصدر'
    : filter.lectureSourceId
      ? `أسئلة مرتبطة بـ ${ctx.db.get<{ title: string }>('SELECT title FROM source WHERE id = ?', [filter.lectureSourceId])?.title ?? 'محاضرة'}`
      : 'كل الأسئلة';
  const title = `الأسئلة — ${scopeTitle}`;
  const solutionsNote = includeSolutions ? 'يتضمن هذا الملف الحلول ومفاتيح الإجابة ومن يقف خلف كل مفتاح.' : 'هذا الملف دون حلول ودون مفاتيح إجابة.';

  if (format === 'json') {
    const strip = (d: QuestionDetailResponse) => {
      if (includeSolutions) return d;
      const clean = (v: QuestionDetailResponse['question']['current']) => ({ ...v, correct_option_ids: null, key_details: null, explanation: null, distractor_explanations: null });
      // review items can quote the key (e.g. a key conflict «B vs C») — they go with the solutions
      return { ...d, question: { ...d.question, current: clean(d.question.current) }, versions: d.versions.map((v) => ({ ...v, ...clean(v) })), key_entries: [], review_items: [] };
    };
    const manifest = manifestOf(
      ctx,
      'questions',
      details.map((d) => ({ type: 'question', id: d.question.id, version: d.question.current.version_no, sha256: sha(d.question.current) })),
      [],
      [solutionsNote, 'كل سؤال يذكر أصله: من مصدر أسئلة (مع الصفحة ورقم السؤال)، أو مولَّد، أو أضفته بنفسك.'],
    );
    return fileFor('أسئلة', scopeTitle, format, JSON.stringify({ manifest, contains_solutions: includeSolutions, questions: details.map(strip) }, null, 2));
  }

  const optLabel = (o: { source_label: string | null; ord: number }) => o.source_label ?? String.fromCharCode(65 + o.ord);
  if (format === 'docx') {
    const out: DocBlock[] = [heading(title, 1), para(solutionsNote, 'label')];
    details.forEach((d, i) => {
      const q = d.question;
      const v = q.current;
      out.push(heading(`السؤال ${i + 1}`, 2), para(q.occurrences[0]?.origin_label_ar ?? q.origin_label_ar, 'meta'));
      if (q.origin_type === 'generated') out.push(para('سؤال مولَّد بواسطة MedLevo من المصادر المحددة — ليس من مصدر أسئلة.', 'generated'));
      out.push(...richTextBlocks(v.stem));
      const { label, correct } = answerLine(d);
      for (const o of [...v.options].sort((a, b) => a.ord - b.ord)) {
        const dir = o.text.paragraphs[0]?.dir ?? 'rtl';
        const isCorrect = includeSolutions && correct.has(o.id);
        out.push({
          kind: 'para',
          dir,
          segs: [
            { t: `${optLabel(o)}) `, dir: /[A-Za-z]/.test(optLabel(o)) ? 'ltr' : 'rtl', b: true },
            ...textSegs(richTextPlain(o.text).replace(/\n+/g, ' '), dir, isCorrect ? { b: true } : {}),
            ...(isCorrect ? textSegs(' (الإجابة)', 'rtl', { b: true }) : []),
          ],
        });
      }
      if (includeSolutions) {
        out.push(para(`الإجابة: ${label}`));
        if (v.explanation) out.push(para('الشرح', 'aside', { b: true }), ...richTextBlocks(v.explanation, undefined, 'aside'));
      }
    });
    return fileFor('أسئلة', scopeTitle, format, await buildDocx(title, out));
  }
  if (format === 'md') {
    const out: string[] = [`# ${mdEscape(title)}`, '', `> ${solutionsNote}`, ''];
    details.forEach((d, i) => {
      const q = d.question;
      const v = q.current;
      out.push(`## السؤال ${i + 1}`, '', `*${mdEscape(q.occurrences[0]?.origin_label_ar ?? q.origin_label_ar)}*`, '');
      if (q.origin_type === 'generated') out.push('> سؤال مولَّد بواسطة MedLevo من المصادر المحددة — ليس من مصدر أسئلة.', '');
      out.push(richTextToMarkdown(v.stem), '');
      const { label, correct } = answerLine(d);
      for (const o of [...v.options].sort((a, b) => a.ord - b.ord)) {
        const mark = includeSolutions && correct.has(o.id) ? ' ✓' : '';
        out.push(`- ${mdEscape(optLabel(o))}) ${richTextToMarkdown(o.text).replace(/\n+/g, ' ')}${mark}`);
      }
      out.push('');
      if (includeSolutions) {
        out.push(`**الإجابة:** ${mdEscape(label)}`, '');
        if (v.explanation) out.push(`**الشرح:** ${richTextToMarkdown(v.explanation)}`, '');
      }
    });
    return fileFor('أسئلة', scopeTitle, format, out.join('\n') + '\n');
  }
  const body: string[] = [textToHtml(title, 'h2').replace(/^<h2/, '<h1').replace(/h2>$/, 'h1>'), `<p class="label">${escapeHtml(solutionsNote)}</p>`];
  details.forEach((d, i) => {
    const q = d.question;
    const v = q.current;
    body.push(`<section class="question"><h2>${escapeHtml(`السؤال ${i + 1}`)}</h2><p class="meta">${inlineHtml(q.occurrences[0]?.origin_label_ar ?? q.origin_label_ar)}</p>`);
    if (q.origin_type === 'generated') body.push('<p class="label generated">سؤال مولَّد بواسطة MedLevo من المصادر المحددة — ليس من مصدر أسئلة.</p>');
    body.push(richTextToHtml(v.stem));
    const { label, correct } = answerLine(d);
    body.push(
      `<ol class="options">${[...v.options]
        .sort((a, b) => a.ord - b.ord)
        .map((o) => {
          const isCorrect = includeSolutions && correct.has(o.id);
          return `<li${isCorrect ? ' class="option-correct"' : ''} dir="${o.text.paragraphs[0]?.dir ?? 'rtl'}"><bdi>${escapeHtml(optLabel(o))})</bdi> ${richTextPlain(o.text) ? inlineHtml(richTextPlain(o.text), o.text.paragraphs[0]?.dir ?? 'rtl') : ''}${isCorrect ? ' <span>(الإجابة)</span>' : ''}</li>`;
        })
        .join('')}</ol>`,
    );
    if (includeSolutions) {
      body.push(`<p><b>الإجابة:</b> ${inlineHtml(label)}</p>`);
      if (v.explanation) body.push(`<div class="aside"><span class="aside-title">الشرح</span>${richTextToHtml(v.explanation)}</div>`);
    }
    body.push('</section>');
  });
  return fileFor('أسئلة', scopeTitle, format, htmlDocument(title, body.join('\n')));
}

// ───────────────────────────── full JSON export ─────────────────────────────
const FULL_TABLES: Array<{ table: string; type: string; where?: string; rev?: string; columns?: string }> = [
  { table: 'library_node', type: 'library_node' },
  { table: 'tag', type: 'tag' },
  { table: 'tag_link', type: 'tag_link' },
  { table: 'source', type: 'source' },
  { table: 'source_link', type: 'source_link' },
  { table: 'source_version', type: 'source_version', rev: 'version_no' },
  { table: 'source_page', type: 'source_page' },
  { table: 'note_page', type: 'note_page' },
  { table: 'annotation', type: 'annotation', rev: 'rev' },
  { table: 'note', type: 'note', rev: 'rev' },
  { table: 'question', type: 'question' },
  { table: 'question_version', type: 'question_version', rev: 'version_no' },
  { table: 'question_option', type: 'question_option' },
  { table: 'question_occurrence', type: 'question_occurrence' },
  { table: 'answer_key_entry', type: 'answer_key_entry' },
  { table: 'question_lecture_link', type: 'question_lecture_link' },
  { table: 'question_attempt', type: 'question_attempt' },
  { table: 'exam', type: 'exam' },
  { table: 'exam_attempt', type: 'exam_attempt' },
  { table: 'written_attempt', type: 'written_attempt' },
  { table: 'flashcard', type: 'flashcard', rev: 'rev' },
  { table: 'review_event', type: 'review_event' },
  { table: 'study_session', type: 'study_session', rev: 'rev' },
  { table: 'artifact', type: 'artifact', rev: 'version_no' },
  { table: 'content_block', type: 'content_block' },
  { table: 'claim', type: 'claim' },
  { table: 'citation', type: 'citation' },
  { table: 'evidence', type: 'evidence' },
  { table: 'medical_term', type: 'medical_term' },
  { table: 'owner_setting', type: 'owner_setting' },
  // Track F4: the owner's handwriting readings and corrections (the picture sent for reading is left out — it is
  // re-made from the strokes in `annotation`) and the in-app recordings' metadata (the audio itself is a stored_file)
  {
    table: 'ink_recognition',
    type: 'ink_recognition',
    columns:
      'id, purpose, status, annotation_ids_json, strokes_json, anchor_json, bbox_json, source_id, version_id, page_id, note_page_id, question_id, lang_requested, lang, text, lines_json, uncertain_count, corrected_text, corrected_at, engine, created_at, updated_at, deleted_at',
  },
  { table: 'audio_recording', type: 'audio_recording' },
];

/** Everything the owner created or studied, as JSON (files referenced by sha256; never secrets). */
export function exportAll(ctx: AppContext): ExportFile {
  const data: Record<string, unknown[]> = {};
  const entities: ExportManifest['entities'] = [];
  for (const t of FULL_TABLES) {
    let rows: Array<Record<string, unknown>>;
    try {
      rows = ctx.db.all<Record<string, unknown>>(`SELECT ${t.columns ?? '*'} FROM ${t.table}`);
    } catch {
      continue;
    }
    // same rule as the backup (backup.ts): a secret-looking key OR value never leaves the server
    if (t.table === 'owner_setting') rows = rows.filter((r) => !SECRET_SETTING_KEY.test(String(r.key)) && !SECRET_VALUE.test(String(r.value_json ?? '')));
    data[t.table] = rows;
    for (const r of rows) {
      const id = String(r.id ?? r.key ?? `${r.tag_id ?? ''}:${r.entity_type ?? ''}:${r.entity_id ?? ''}`);
      entities.push({ type: t.type, id, version: t.rev ? ((r[t.rev] as number | null) ?? null) : null, sha256: sha(r) });
    }
  }
  const files = ctx.db.all<{ id: string; sha256: string; size: number; mime: string }>('SELECT id, sha256, size, mime FROM stored_file ORDER BY id').map((f) => ({ file_id: f.id, sha256: f.sha256, size: f.size, mime: f.mime, role: 'stored_file' }));
  const manifest = manifestOf(ctx, 'all', entities, files, [
    'تصدير كامل لبياناتك المنظمة (ليس نسخة احتياطية): الملفات نفسها غير مضمّنة بل مُعرّفة ببصمة sha256. للاستعادة الكاملة استخدم النسخ الاحتياطي.',
    'لا يتضمن أي سر: لا كلمة مرور ولا رموز استرداد ولا جلسات ولا مفاتيح API.',
    'المحتوى المولَّد (artifact / content_block / claim) مُعلَّم بنوعه ونموذجه وحالة التحقق من كل ادعاء.',
  ]);
  return fileFor('تصدير كامل', 'MedLevo', 'json', JSON.stringify({ manifest, data }, null, 2));
}
