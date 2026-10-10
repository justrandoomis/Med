// Reading & writing bar (§23): back to the library, title + page identity, view (Original | Study Book |
// Split), search, zoom, view options, the ink tools, focus mode, panels and the honest save status.
// Phones get a condensed bar; the rest lives in one «المزيد» menu.
import { type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  Check,
  ChevronDown,
  Columns2,
  Ellipsis,
  Focus,
  LayoutPanelLeft,
  Minus,
  PanelLeft,
  PanelRight,
  Plus,
  RotateCcw,
  RotateCw,
  Search,
  Undo2,
} from 'lucide-react';
import { detectDir, type SourcePageView, type SyncState } from '@medlevo/shared';
import { Button, IconButton, Menu, MenuItem, MenuSeparator, SaveStatus, Tooltip, buttonClass, cx } from '../../../design';
import { InkToolbar } from '../ink';
import type { LayoutMode } from '../reader/BookCanvas';
import { GoToPage } from './GoToPage';

export interface TopBarProps {
  title: string;
  backTo: string;
  phone: boolean;
  pages: readonly SourcePageView[];
  pageIndex: number;
  onGoToPage: (i: number) => void;
  view: WorkspaceView;
  onView: (v: WorkspaceView) => void;
  splitReason: string | null;
  /** null → the Study Book can be opened (a version exists or one can be generated); else the reason */
  studyBookReason: string | null;
  searchOpen: boolean;
  onToggleSearch: () => void;
  zoomLabel: string;
  fit: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomTo: (z: number | 'fit') => void;
  onRotate: (dir: 1 | -1) => void;
  layout: LayoutMode;
  spreadReason: string | null;
  onLayout: (l: LayoutMode) => void;
  flipAnimation: boolean;
  onFlipAnimation: (v: boolean) => void;
  focusMode: boolean;
  onFocusMode: () => void;
  leftOpen: boolean;
  onToggleLeft: () => void;
  railOpen: boolean;
  onToggleRail: () => void;
  saveState: SyncState;
  saveDetail: string;
  back: { label: string; title: string } | null;
  onBack: () => void;
  inkAvailable: boolean;
  /** extra items for the overflow menu (e.g. «نزّل للعمل دون اتصال…» from features/offline) */
  extraMenuItems?: ReactNode;
}

const ZOOM_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

/** Original lecture · MedLevo Study Book · lecture + another source · lecture + its Study Book (§23, §24, §26). */
export type WorkspaceView = 'original' | 'study_book' | 'split' | 'split_book';

export const VIEW_LABELS_AR: Record<WorkspaceView, string> = {
  original: 'المحاضرة الأصلية',
  study_book: 'كتاب الدراسة',
  split: 'جنبًا إلى جنب',
  split_book: 'المحاضرة + كتاب الدراسة',
};

function Hint({ label, children }: { label: string; children: Parameters<typeof Tooltip>[0]['children'] }) {
  return (
    <Tooltip content={label} describe={false}>
      {children}
    </Tooltip>
  );
}

function check(on: boolean): ReactNode {
  return on ? <Check size={16} /> : <span className="wk-menu-blank" />;
}

export function TopBar(p: TopBarProps) {
  const splitBookReason = p.splitReason ?? p.studyBookReason;
  const viewMenu = (
    <Menu
      label="طريقة العرض"
      trigger={
        <Button size="sm" variant="plain" iconEnd={<ChevronDown size={16} />} className="wk-viewswitch">
          {VIEW_LABELS_AR[p.view]}
        </Button>
      }
    >
      <MenuItem icon={check(p.view === 'original')} onSelect={() => p.onView('original')}>
        {VIEW_LABELS_AR.original}
      </MenuItem>
      <MenuItem icon={check(p.view === 'study_book')} onSelect={() => p.onView('study_book')} disabled={!!p.studyBookReason && p.view !== 'study_book'} disabledReason={p.studyBookReason ?? undefined}>
        {VIEW_LABELS_AR.study_book}
      </MenuItem>
      <MenuItem icon={check(p.view === 'split_book')} onSelect={() => p.onView('split_book')} disabled={!!splitBookReason && p.view !== 'split_book'} disabledReason={splitBookReason ?? undefined}>
        {VIEW_LABELS_AR.split_book}
      </MenuItem>
      <MenuItem icon={check(p.view === 'split')} onSelect={() => p.onView('split')} disabled={!!p.splitReason && p.view !== 'split'} disabledReason={p.splitReason ?? undefined}>
        جنبًا إلى جنب مع مصدر آخر
      </MenuItem>
    </Menu>
  );

  const layoutItems = (
    <>
      <MenuItem icon={check(p.layout === 'continuous')} onSelect={() => p.onLayout('continuous')}>
        تمرير متصل
      </MenuItem>
      <MenuItem icon={check(p.layout === 'single')} onSelect={() => p.onLayout('single')}>
        صفحة واحدة
      </MenuItem>
      <MenuItem icon={check(p.layout === 'double')} onSelect={() => p.onLayout('double')} disabled={!!p.spreadReason} disabledReason={p.spreadReason ?? undefined}>
        صفحتان متقابلتان
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon={<RotateCw size={16} />} onSelect={() => p.onRotate(1)}>
        تدوير مع عقارب الساعة
      </MenuItem>
      <MenuItem icon={<RotateCcw size={16} />} onSelect={() => p.onRotate(-1)}>
        تدوير عكس عقارب الساعة
      </MenuItem>
      <MenuItem icon={check(p.flipAnimation)} onSelect={() => p.onFlipAnimation(!p.flipAnimation)} hint={p.flipAnimation ? 'مفعّل' : 'فوري'}>
        حركة تقليب الصفحات
      </MenuItem>
    </>
  );

  const backButton = p.back && (
    <Button size="sm" variant="secondary" icon={<Undo2 size={16} />} onClick={p.onBack} title={p.back.title} className="wk-backjump">
      {p.back.label}
    </Button>
  );

  if (p.phone) {
    return (
      <header className="wk-topbar wk-topbar--phone">
        <div className="wk-topbar__row">
          <Link to={p.backTo} className={buttonClass({ variant: 'plain', size: 'sm', className: 'wk-back' })} aria-label="العودة إلى المكتبة">
            <ArrowRight size={20} aria-hidden="true" />
          </Link>
          <div className="wk-topbar__title">
            <h1 className="wk-title" dir={detectDir(p.title)}>
              {p.title}
            </h1>
            <GoToPage pages={p.pages} pageIndex={p.pageIndex} onGo={p.onGoToPage} compact />
          </div>
          <SaveStatus state={p.saveState} detail={p.saveDetail} compact />
          <Hint label="البحث في المصدر">
            <IconButton label="البحث في المصدر" icon={<Search size={20} />} pressed={p.searchOpen} onClick={p.onToggleSearch} />
          </Hint>
          <Hint label="لوحة الدراسة">
            <IconButton label="لوحة الدراسة" icon={<PanelRight size={20} />} pressed={p.railOpen} onClick={p.onToggleRail} />
          </Hint>
          <Menu
            label="خيارات القراءة"
            align="end"
            trigger={<IconButton label="خيارات القراءة" icon={<Ellipsis size={20} />} />}
          >
            <MenuItem icon={<LayoutPanelLeft size={16} />} onSelect={p.onToggleLeft}>
              الصفحات والفهرس والعلامات
            </MenuItem>
            <MenuItem icon={<Plus size={16} />} onSelect={p.onZoomIn}>
              تكبير
            </MenuItem>
            <MenuItem icon={<Minus size={16} />} onSelect={p.onZoomOut} hint={p.zoomLabel}>
              تصغير
            </MenuItem>
            <MenuItem icon={check(p.fit)} onSelect={() => p.onZoomTo('fit')}>
              ملاءمة العرض
            </MenuItem>
            <MenuSeparator />
            {layoutItems}
            <MenuSeparator />
            <MenuItem icon={check(p.view === 'original')} onSelect={() => p.onView('original')}>
              {VIEW_LABELS_AR.original}
            </MenuItem>
            <MenuItem icon={check(p.view === 'study_book')} onSelect={() => p.onView('study_book')} disabled={!!p.studyBookReason && p.view !== 'study_book'} disabledReason={p.studyBookReason ?? undefined}>
              {VIEW_LABELS_AR.study_book}
            </MenuItem>
            <MenuItem icon={<Columns2 size={16} />} onSelect={() => undefined} disabled disabledReason={p.splitReason ?? 'العرض جنبًا إلى جنب يحتاج شاشة أعرض.'}>
              جنبًا إلى جنب
            </MenuItem>
            <MenuItem icon={<Focus size={16} />} onSelect={p.onFocusMode}>
              {p.focusMode ? 'إنهاء وضع التركيز' : 'وضع التركيز'}
            </MenuItem>
            {p.extraMenuItems && <MenuSeparator />}
            {p.extraMenuItems}
          </Menu>
        </div>
        {backButton && <div className="wk-topbar__row wk-topbar__row--sub">{backButton}</div>}
        {p.inkAvailable && (
          <div className="wk-topbar__ink" role="group" aria-label="أدوات الكتابة">
            <InkToolbar />
          </div>
        )}
      </header>
    );
  }

  return (
    <header className="wk-topbar">
      <div className="wk-topbar__row">
        <div className="wk-topbar__start">
          <Hint label="العودة إلى المكتبة">
            <Link to={p.backTo} className={buttonClass({ variant: 'plain', size: 'sm', className: 'wk-back' })} aria-label="العودة إلى المكتبة">
              <ArrowRight size={20} aria-hidden="true" />
            </Link>
          </Hint>
          <div className="wk-topbar__title">
            <h1 className="wk-title" dir={detectDir(p.title)}>
              {p.title}
            </h1>
            <GoToPage pages={p.pages} pageIndex={p.pageIndex} onGo={p.onGoToPage} />
          </div>
          {backButton}
        </div>

        <div className="wk-topbar__center">
          {viewMenu}
          {p.inkAvailable && (
            <div className="wk-topbar__ink" role="group" aria-label="أدوات الكتابة">
              <InkToolbar />
            </div>
          )}
        </div>

        <div className="wk-topbar__end">
          <Hint label="البحث في المصدر (Ctrl F)">
            <IconButton label="البحث في المصدر" icon={<Search size={18} />} size="sm" pressed={p.searchOpen} onClick={p.onToggleSearch} />
          </Hint>
          <div className="wk-zoom" role="group" aria-label="التكبير">
            <Hint label="تصغير (-)">
              <IconButton label="تصغير" icon={<Minus size={18} />} size="sm" onClick={p.onZoomOut} />
            </Hint>
            <Menu
              label="مستوى التكبير"
              trigger={
                <button type="button" className={cx('wk-zoom__value', p.fit && 'wk-zoom__value--fit')} aria-label={`التكبير ${p.zoomLabel}${p.fit ? '، ملاءمة العرض' : ''}`}>
                  <bdi dir="ltr">{p.zoomLabel}</bdi>
                </button>
              }
            >
              <MenuItem icon={check(p.fit)} onSelect={() => p.onZoomTo('fit')}>
                ملاءمة العرض
              </MenuItem>
              {ZOOM_PRESETS.map((z) => (
                <MenuItem key={z} icon={<span className="wk-menu-blank" />} onSelect={() => p.onZoomTo(z)}>
                  <bdi dir="ltr">{`${Math.round(z * 100)}%`}</bdi>
                </MenuItem>
              ))}
            </Menu>
            <Hint label="تكبير (+)">
              <IconButton label="تكبير" icon={<Plus size={18} />} size="sm" onClick={p.onZoomIn} />
            </Hint>
          </div>
          <Menu label="خيارات العرض" align="end" trigger={<IconButton label="خيارات العرض" icon={<Ellipsis size={18} />} size="sm" />}>
            {layoutItems}
            {p.extraMenuItems && <MenuSeparator />}
            {p.extraMenuItems}
          </Menu>
          <Hint label={p.focusMode ? 'إنهاء وضع التركيز (F)' : 'وضع التركيز (F)'}>
            <IconButton label={p.focusMode ? 'إنهاء وضع التركيز' : 'وضع التركيز'} icon={<Focus size={18} />} size="sm" pressed={p.focusMode} onClick={p.onFocusMode} />
          </Hint>
          <Hint label="الصفحات والفهرس والعلامات ([)">
            <IconButton label="الصفحات والفهرس والعلامات" icon={<PanelLeft size={18} />} size="sm" pressed={p.leftOpen} onClick={p.onToggleLeft} />
          </Hint>
          <Hint label="لوحة الدراسة (])">
            <IconButton label="لوحة الدراسة" icon={<PanelRight size={18} />} size="sm" pressed={p.railOpen} onClick={p.onToggleRail} />
          </Hint>
          <SaveStatus state={p.saveState} detail={p.saveDetail} live />
        </div>
      </div>
    </header>
  );
}
