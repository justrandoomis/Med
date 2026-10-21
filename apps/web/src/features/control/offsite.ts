// Off-site backups in the Control Center (PL-0): the server's /api/data/offsite status, «نسخ احتياطي الآن» and the
// list of encrypted copies in Cloudflare R2. The response shapes mirror apps/server/src/modules/data/offsite.ts (kept
// local to this feature while packages/shared is being reshaped by the Academic OS step-0 track).
import type { JobView } from '@medlevo/shared';
import { api } from '../../lib/api';
import { formatBytes } from './model';

export type OffsiteRunStatus = 'running' | 'uploaded' | 'failed';

export interface OffsiteRunView {
  id: string;
  trigger: 'schedule' | 'manual';
  status: OffsiteRunStatus;
  status_label_ar: string;
  stage: 'backup' | 'verify' | 'upload' | 'retention' | 'done' | null;
  stage_label_ar: string | null;
  created_at: number;
  finished_at: number | null;
  size: number | null;
  archive_size: number | null;
  object_key: string | null;
  parts: number | null;
  parts_resumed: number | null;
  verify_status: 'passed' | 'failed' | null;
  retention: { kept: number; deleted: number; deleted_local: number; errors_ar: string[] } | null;
  warnings_ar: string[];
  error_ar: string | null;
  job: JobView | null;
}

export interface OffsiteStatusResponse {
  configured: boolean;
  problems_ar: string[];
  target: { bucket: string; endpoint_host: string; prefix: string } | null;
  encryption: { key_id: string } | null;
  schedule: { time: string; timezone: string; next_run_at: number | null } | null;
  retention: { keep_daily: number; keep_weekly: number; keep_local: number };
  running: OffsiteRunView | null;
  last: OffsiteRunView | null;
  last_success: OffsiteRunView | null;
  recent: OffsiteRunView[];
  restore_command: string;
  notes_ar: string[];
}

export interface RemoteBackupView {
  key: string;
  file_name: string;
  size: number;
  created_at: number;
  last_modified: number | null;
  restore_command: string;
}

const T = { timeoutMs: 30_000 };

export const offsiteApi = {
  status: () => api.get<OffsiteStatusResponse>('/data/offsite', T),
  run: () => api.post<{ run: OffsiteRunView }>('/data/offsite/run', {}, T),
  remote: () => api.get<{ objects: RemoteBackupView[] }>('/data/offsite/remote', { timeoutMs: 60_000 }),
};

/** «اليوم 03:15» style relative wording is avoided on purpose: an absolute, Latin-digit time is unambiguous. */
export function offsiteSummaryAr(s: OffsiteStatusResponse, formatTime: (ms: number) => string): string {
  if (!s.configured) return 'غير مُعدّ: لا نسخة خارج الخادم. اضبط Cloudflare R2 ومفتاح التشفير في إعدادات Render.';
  if (s.running) return `جارٍ الآن: ${s.running.stage_label_ar ?? s.running.status_label_ar}.`;
  const ok = s.last_success;
  const last = s.last;
  if (last && last.status === 'failed' && (!ok || last.created_at > ok.created_at)) {
    return `فشلت آخر محاولة (${formatTime(last.created_at)})${ok ? `؛ آخر نسخة ناجحة ${formatTime(ok.created_at)}` : '، ولا توجد نسخة ناجحة بعد'}.`;
  }
  if (ok) return `آخر نسخة مشفّرة في R2: ${formatTime(ok.created_at)} (${ok.size !== null ? formatBytes(ok.size) : '؟'}) — نجحت.`;
  return s.schedule ? `مُعدّ؛ أول نسخة في الموعد اليومي ${s.schedule.time}، أو اضغط «نسخ احتياطي الآن».` : 'مُعدّ؛ لا جدول يومي — اضغط «نسخ احتياطي الآن».';
}
