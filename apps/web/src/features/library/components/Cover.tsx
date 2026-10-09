// Notebook cover: book-cloth colour token + weave (linen / grid / dots), a binding spine on the
// inline-start edge (right in Arabic books) and a paper title label. Purely presentational.
import type { ReactNode } from 'react';
import {
  Activity,
  Baby,
  Bone,
  BookOpen,
  Brain,
  Eye,
  FlaskConical,
  Folder,
  HeartPulse,
  Microscope,
  Pill,
  ScanLine,
  Stethoscope,
  Syringe,
} from 'lucide-react';
import { COVER_COLORS, type CoverColor, type LibraryNodeView, type NodeCover } from '@medlevo/shared';
import { cx } from '../../../design';

const ICONS: Record<string, (size: number) => ReactNode> = {
  book: (s) => <BookOpen size={s} />,
  stethoscope: (s) => <Stethoscope size={s} />,
  heart: (s) => <HeartPulse size={s} />,
  brain: (s) => <Brain size={s} />,
  bone: (s) => <Bone size={s} />,
  pill: (s) => <Pill size={s} />,
  microscope: (s) => <Microscope size={s} />,
  baby: (s) => <Baby size={s} />,
  scan: (s) => <ScanLine size={s} />,
  flask: (s) => <FlaskConical size={s} />,
  syringe: (s) => <Syringe size={s} />,
  activity: (s) => <Activity size={s} />,
  eye: (s) => <Eye size={s} />,
  folder: (s) => <Folder size={s} />,
};

export function libraryIcon(token: string | null | undefined, size = 20): ReactNode {
  return token && ICONS[token] ? ICONS[token](size) : null;
}

const DEFAULT_BY_KIND: Record<LibraryNodeView['kind'], NodeCover> = {
  notebook: { style: 'linen', color: 'indigo', symbol: 'book' },
  subject: { style: 'linen', color: 'teal', symbol: 'stethoscope' },
  course: { style: 'grid', color: 'slate', symbol: 'book' },
  folder: { style: 'plain', color: 'slate', symbol: 'folder' },
  section: { style: 'plain', color: 'slate', symbol: 'folder' },
  topic_folder: { style: 'dots', color: 'sky', symbol: 'folder' },
};

/** Cover of a node (its own, or a quiet default for its kind — never random). */
export function coverOf(node: Pick<LibraryNodeView, 'cover' | 'kind' | 'color' | 'icon'>): NodeCover {
  const base = node.cover ?? DEFAULT_BY_KIND[node.kind];
  const color = (COVER_COLORS as readonly string[]).includes(base.color) ? base.color : 'slate';
  return { style: base.style, color, symbol: base.symbol ?? node.icon ?? undefined };
}

/** Colour token for small folder icons in lists. */
export function folderTone(node: Pick<LibraryNodeView, 'cover' | 'kind' | 'color' | 'icon'>): CoverColor {
  if (node.color && (COVER_COLORS as readonly string[]).includes(node.color)) return node.color as CoverColor;
  return coverOf(node).color as CoverColor;
}

export interface CoverProps {
  cover: NodeCover;
  title: string;
  size?: 'shelf' | 'mini';
  className?: string;
}

export function Cover({ cover, title, size = 'shelf', className }: CoverProps) {
  const symbol = libraryIcon(cover.symbol, size === 'mini' ? 14 : 26);
  return (
    <span className={cx('ml-cover', `ml-cover--${size}`, className)} data-color={cover.color} data-style={cover.style} aria-hidden={size === 'mini' ? true : undefined}>
      <span className="ml-cover__spine" aria-hidden="true" />
      {symbol && (
        <span className="ml-cover__symbol" aria-hidden="true">
          {symbol}
        </span>
      )}
      {size === 'shelf' && (
        <span className="ml-cover__label">
          <bdi className="ml-cover__title">{title}</bdi>
        </span>
      )}
    </span>
  );
}
