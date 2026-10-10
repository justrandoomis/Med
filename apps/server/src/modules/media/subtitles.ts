// WebVTT / SubRip (SRT) → transcript cues (§29). Pure and deterministic.
//
//  * BOM, CRLF / CR line endings, NOTE / STYLE / REGION blocks, cue identifiers and cue settings are handled.
//  * Timestamps: VTT `hh:mm:ss.ttt` or `mm:ss.ttt`; SRT `hh:mm:ss,ttt` (a '.' separator is accepted too).
//  * Text: markup tags (<b>, <i>, <c.x>, <lang>, <ruby>, timestamp tags, SRT {\an8}) are removed; entities decoded;
//    bidi control characters stripped (never persisted, RichText rule); lines joined with a space. Arabic text is kept
//    in logical order as written in the file.
//  * A speaker is kept ONLY when the file names it in a VTT voice tag (<v Name>) — never guessed (§29).
//  * Invalid cues are skipped with an Arabic reason (bad timing line, end ≤ start, no text, too long).
import { stripBidiControls } from '@medlevo/shared';

export interface Cue {
  /** 1-based position of the cue block in the file */
  index: number;
  start_ms: number;
  end_ms: number;
  text: string;
  speaker: string | null;
}

export interface SubtitleParseResult {
  format: 'vtt' | 'srt';
  cues: Cue[];
  skipped: Array<{ cue: number; reason_ar: string }>;
}

export const MAX_CUES = 20_000;
const MAX_MS = 24 * 3600 * 1000;
const TIMING = /^\s*(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/;

export function detectFormat(text: string): 'vtt' | 'srt' | null {
  const t = text.replace(/^﻿/, '').trimStart();
  if (/^WEBVTT(?:[ \t]|$|\r?\n)/.test(t)) return 'vtt';
  if (/^\d+\s*\r?\n\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s+-->/.test(t)) return 'srt';
  if (/^\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s+-->/.test(t)) return 'srt';
  return null;
}

/** `hh:mm:ss.ttt`, `mm:ss.ttt` (VTT) or `hh:mm:ss,ttt` (SRT) → ms; null when malformed. */
export function parseTimestamp(raw: string): number | null {
  const m = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(raw.trim());
  if (!m) return null;
  const h = m[1] ? Number(m[1]) : 0;
  const min = Number(m[2]);
  const s = Number(m[3]);
  const frac = m[4]!.padEnd(3, '0');
  if (min > 59 || s > 59) return null;
  return ((h * 60 + min) * 60 + s) * 1000 + Number(frac);
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lrm: '', rlm: '' };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    const v = ENTITIES[e.toLowerCase()];
    return v === undefined ? all : v;
  });
}

function cleanText(lines: string[]): { text: string; speaker: string | null } {
  let speaker: string | null = null;
  const joined = lines.join('\n');
  const voice = /<v(?:\.[^\s>]+)*\s+([^>]+)>/i.exec(joined);
  if (voice) speaker = decodeEntities(voice[1]!).trim().slice(0, 80) || null;
  const text = stripBidiControls(
    decodeEntities(
      joined
        .replace(/\{\\[^}]*\}/g, '') // SRT/ASS override tags {\an8}
        .replace(/<[^>]*>/g, ''), // markup and timestamp tags
    ),
  )
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ');
  return { text, speaker };
}

function blocks(text: string): string[][] {
  return text
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n+/)
    .map((b) => b.split('\n').filter((l, i, arr) => !(l.trim() === '' && (i === 0 || i === arr.length - 1))))
    .filter((b) => b.some((l) => l.trim() !== ''));
}

function cueFrom(index: number, lines: string[], skipped: SubtitleParseResult['skipped']): Cue | null {
  // optional identifier / SRT number before the timing line
  const timingAt = lines.findIndex((l) => l.includes('-->'));
  if (timingAt < 0 || timingAt > 1) {
    skipped.push({ cue: index, reason_ar: 'كتلة بلا سطر توقيت صالح (start --> end).' });
    return null;
  }
  const m = TIMING.exec(lines[timingAt]!);
  const start = m ? parseTimestamp(m[1]!) : null;
  const end = m ? parseTimestamp(m[2]!) : null;
  if (start === null || end === null) {
    skipped.push({ cue: index, reason_ar: 'سطر توقيت غير صالح.' });
    return null;
  }
  if (end <= start) {
    skipped.push({ cue: index, reason_ar: 'نهاية المقطع ليست بعد بدايته.' });
    return null;
  }
  if (end > MAX_MS) {
    skipped.push({ cue: index, reason_ar: 'توقيت أطول من 24 ساعة.' });
    return null;
  }
  const { text, speaker } = cleanText(lines.slice(timingAt + 1));
  if (!text) {
    skipped.push({ cue: index, reason_ar: 'مقطع بلا نص.' });
    return null;
  }
  return { index, start_ms: start, end_ms: end, text: text.slice(0, 4000), speaker };
}

export function parseSubtitles(input: string, format: 'vtt' | 'srt' | 'auto' = 'auto'): SubtitleParseResult {
  const detected = format === 'auto' ? detectFormat(input) : format;
  if (!detected) throw new SubtitleError('لم يُتعرّف على صيغة الملف: يجب أن يبدأ ملف WebVTT بـ «WEBVTT» وأن يحتوي ملف SRT على رقم ثم سطر توقيت.');
  const all = blocks(input);
  const cues: Cue[] = [];
  const skipped: SubtitleParseResult['skipped'] = [];
  let n = 0;
  for (const [i, b] of all.entries()) {
    if (detected === 'vtt') {
      if (i === 0) {
        if (!/^WEBVTT(?:[ \t]|$)/.test(b[0]!.replace(/^﻿/, ''))) throw new SubtitleError('ملف WebVTT يجب أن يبدأ بالسطر «WEBVTT».');
        // the header block may be followed directly by a cue without a blank line (lenient)
        const rest = b.slice(1);
        if (!rest.some((l) => l.includes('-->'))) continue;
        n++;
        const c = cueFrom(n, rest.filter((l) => !/^[A-Za-z-]+:/.test(l) || l.includes('-->')), skipped);
        if (c) cues.push(c);
        continue;
      }
      if (/^(NOTE|STYLE|REGION)(?:[ \t]|$)/.test(b[0]!)) continue;
    }
    n++;
    if (n > MAX_CUES) {
      skipped.push({ cue: n, reason_ar: `تجاوز الملف الحد الأقصى (${MAX_CUES} مقطعًا)؛ أُهمل الباقي.` });
      break;
    }
    const c = cueFrom(n, b, skipped);
    if (c) cues.push(c);
  }
  cues.sort((a, b) => a.start_ms - b.start_ms || a.index - b.index);
  return { format: detected, cues, skipped };
}

export class SubtitleError extends Error {
  constructor(readonly message_ar: string) {
    super(message_ar);
    this.name = 'SubtitleError';
  }
}

/** «12:05» / «1:02:03» */
export function formatMs(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (x: number) => String(x).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
