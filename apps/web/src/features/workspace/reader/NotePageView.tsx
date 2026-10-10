// One note page of the Book Canvas (§26 «إضافة صفحات ملاحظات» + «قوالب ورق»): warm paper with the chosen
// template (blank / ruled / dotted / grid — token colours, dark-mode aware, drawn in page units so it follows zoom
// and rotation exactly), the ink layer anchored to the note page ('note_page' anchors, the same engine as source
// pages), and a folio naming it with a menu (rename, paper, move, a new page after it, move to the trash).
import { memo } from 'react';
import { ArrowDown, ArrowUp, FilePlus2, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { NOTE_PAGE_TEMPLATE_LABELS_AR, NOTE_PAGE_TEMPLATES, type AnnotationAnchor, type PageViewTransform } from '@medlevo/shared';
import { cx, IconButton, Menu, MenuItem, MenuSeparator } from '../../../design';
import { InkLayer } from '../ink';
import { paperStyle } from '../model/paper';
import type { ReaderSheet } from '../model/sequence';
import type { PageGeom } from './geometry';
import { useReaderPage } from './readerContext';

export interface NotePageViewProps {
  sheet: Extract<ReaderSheet, { kind: 'note' }>;
  geom: PageGeom;
  near: boolean;
  style?: React.CSSProperties;
  /** accessible name (defaults to the page title / «صفحة ملاحظات») */
  label?: string;
}

export const NotePageView = memo(function NotePageView({ sheet, geom, near, style, label }: NotePageViewProps) {
  const ctx = useReaderPage();
  const note = sheet.note;
  const paperName = NOTE_PAGE_TEMPLATE_LABELS_AR[note.template] ?? NOTE_PAGE_TEMPLATE_LABELS_AR.blank;
  const name = label ?? (note.title ? `${note.title} — صفحة ملاحظات (${paperName})` : `صفحة ملاحظات (${paperName})`);
  const anchor: AnnotationAnchor = { type: 'note_page', note_page_id: note.id, space: 'page_norm' };
  const view: PageViewTransform = { pageWidth: note.width, pageHeight: note.height, scale: geom.scale, rotation: geom.rotation };
  const ink = (ctx.notePageInk ?? ctx.inkEnabled) && near;
  const actions = ctx.notePageActions ?? null;
  const paper = paperStyle(note.template, geom.scale, { rtl: ctx.paperRtl ?? true, pageWidth: note.width });
  const divider = (note.kind ?? 'page') === 'divider';
  return (
    <div
      role="group"
      className="wk-page wk-page--note"
      style={style}
      data-seq={geom.index}
      data-note-page-id={note.id}
      aria-label={name}
      aria-roledescription="صفحة ملاحظات"
    >
      <div className={cx('wk-sheet', 'wk-sheet--note', divider && 'wk-sheet--divider')} data-template={note.template} data-color={note.color ?? undefined} style={{ width: geom.viewW, height: geom.viewH }}>
        <div className="wk-layers wk-paper" data-rot={geom.rotation} style={{ width: note.width * geom.scale, height: note.height * geom.scale, ...paper }} aria-hidden="true">
          {divider && note.title && (
            <p className="wk-paper__divider-title" dir="auto" style={{ fontSize: Math.max(12, 28 * geom.scale) }}>
              {note.title}
            </p>
          )}
        </div>
        {ink && (
          <div className={cx('wk-ink-slot', ctx.inkInteractive && 'wk-ink-slot--active')}>
            <InkLayer targetKey={`note_page:${note.id}`} anchor={anchor} view={view} interactive={ctx.inkInteractive} onStrokeActiveChange={ctx.onStrokeActiveChange} />
          </div>
        )}
      </div>
      <div className="wk-folio wk-folio--note">
        <span className="wk-folio__primary">
          {note.title ? <bdi>{note.title}</bdi> : divider ? 'فاصل قسم' : 'صفحة ملاحظات'}
        </span>
        <span className="wk-folio__secondary">{divider ? 'فاصل' : paperName}</span>
        {actions && <NotePageMenu id={note.id} template={note.template} actions={actions} title={note.title ?? null} />}
      </div>
    </div>
  );
});

function NotePageMenu({ id, template, title, actions }: { id: string; template: string; title: string | null; actions: NonNullable<ReturnType<typeof useReaderPage>['notePageActions']> }) {
  const label = title ? `خيارات صفحة الملاحظات «${title}»` : 'خيارات صفحة الملاحظات';
  return (
    <Menu label={label} align="end" trigger={<IconButton size="sm" className="wk-folio__menu" label={label} icon={<MoreHorizontal size={16} />} />}>
      <MenuItem icon={<Pencil size={16} />} onSelect={() => actions.rename(id)}>
        إعادة التسمية…
      </MenuItem>
      {NOTE_PAGE_TEMPLATES.map((t) => (
        <MenuItem key={t} hint={t === template ? 'الحالي' : undefined} onSelect={() => actions.setTemplate(id, t)}>
          ورق {NOTE_PAGE_TEMPLATE_LABELS_AR[t]}
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuItem icon={<ArrowUp size={16} />} disabled={!actions.canMove(id, -1)} disabledReason="هذه أول صفحة في مكانها." onSelect={() => actions.move(id, -1)}>
        انقلها إلى الأمام
      </MenuItem>
      <MenuItem icon={<ArrowDown size={16} />} disabled={!actions.canMove(id, 1)} disabledReason="هذه آخر صفحة في مكانها." onSelect={() => actions.move(id, 1)}>
        انقلها إلى الخلف
      </MenuItem>
      <MenuItem icon={<FilePlus2 size={16} />} onSelect={() => actions.insertAfter(id)}>
        صفحة ملاحظات جديدة بعدها
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon={<Trash2 size={16} />} destructive onSelect={() => actions.trash(id)}>
        نقل إلى المحذوفات
      </MenuItem>
    </Menu>
  );
}
