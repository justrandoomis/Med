// Pen ↔ recording time links (§29, track F4). While the owner records in the app (an explicit action, see
// features/workspace/audio), every stroke written gets `data.audio_link = { recording_id, offset_ms, origin: 'auto' }`
// computed on THIS device from the recording's start (paused time excluded). The owner can move the link to another
// moment (→ origin 'manual') or remove it; tapping a linked stroke with the lasso offers «استمع من هذه اللحظة».
// No link is invented for strokes written outside a recording.
import type { InkAudioLink } from '@medlevo/shared';
import type { InkItem } from './model';

export interface ActiveRecording {
  recordingId: string;
  /** device clock (epoch ms) when the recorder actually started */
  startedAt: number;
  /** total paused time before `at` (epoch ms) — strokes during a pause get no link */
  pausedBefore(at: number): number;
  /** true while paused */
  isPaused(): boolean;
}

let active: ActiveRecording | null = null;

export function setActiveRecording(r: ActiveRecording | null): void {
  active = r;
}

export function getActiveRecording(): ActiveRecording | null {
  return active;
}

/** The automatic link for a stroke that started at `strokeStart` (epoch ms), or null when nothing is recording. */
export function audioLinkAt(strokeStart: number, rec: ActiveRecording | null = active): InkAudioLink | null {
  if (!rec || rec.isPaused()) return null;
  if (strokeStart < rec.startedAt - 1000) return null; // written before the recording started
  const offset = Math.max(0, Math.round(strokeStart - rec.startedAt - rec.pausedBefore(strokeStart)));
  return { recording_id: rec.recordingId, offset_ms: offset, origin: 'auto' };
}

/** The time link of an item (ink stroke or recognized shape), if any. */
export function audioLinkOf(item: InkItem): InkAudioLink | null {
  if (item.kind !== 'ink' && item.kind !== 'shape') return null;
  const l = (item.data as { audio_link?: InkAudioLink }).audio_link;
  return l && typeof l.recording_id === 'string' && Number.isFinite(l.offset_ms) ? l : null;
}

/** A copy of the item with its link replaced (null removes it). The stroke itself is unchanged. */
export function withAudioLink(item: InkItem, link: InkAudioLink | null, now: number): InkItem {
  const data = { ...(item.data as Record<string, unknown>) };
  if (link) data.audio_link = link;
  else delete data.audio_link;
  return { ...item, data: data as InkItem['data'], updated_at: now };
}

/** «1:05» / «1:02:07» — Latin digits, shown inside an LTR isolate. */
export function formatOffset(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Parses «m:ss», «h:mm:ss» or plain seconds (Arabic-Indic digits accepted); null when invalid. */
export function parseOffset(text: string): number | null {
  const t = text
    .trim()
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٫،]/g, ':');
  if (!t) return null;
  if (/^\d+$/.test(t)) return Number(t) * 1000;
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(t);
  if (!m) return null;
  const [, h, mm, ss] = m;
  if (Number(ss) > 59 || (h !== undefined && Number(mm) > 59)) return null;
  return ((Number(h ?? 0) * 60 + Number(mm)) * 60 + Number(ss)) * 1000;
}
