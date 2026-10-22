// «أنا» — the signed-in account's own routes (P1-T1's /api/accounts/me/*; accounts-api.ts). Nobody reads another
// account through them; the screens only show what the server answers for this account.
import type {
  AccountDeleteResponse,
  AccountExportsResponse,
  AccountExportView,
  DeletionPreview,
  DevicesResponse,
  QuotaView,
} from '@medlevo/shared';
import { api } from '../../lib/api';

const T = { timeoutMs: 20_000 };

export const meApi = {
  devices: () => api.get<DevicesResponse>('/accounts/me/devices', T),
  revokeDevice: (deviceId: string) => api.del<{ ok: true }>(`/accounts/me/devices/${encodeURIComponent(deviceId)}`, T),
  quota: () => api.get<QuotaView>('/accounts/me/quota', T),
  exports: () => api.get<AccountExportsResponse>('/accounts/me/exports', T),
  startExport: () => api.post<{ job_id: string; export: AccountExportView }>('/accounts/me/export', {}, T),
  deletePreview: () => api.post<DeletionPreview>('/accounts/me/delete', { preview: true }, T),
  deleteConfirm: (confirm_token: string, password: string) => api.post<AccountDeleteResponse>('/accounts/me/delete', { confirm_token, password }, { timeoutMs: 60_000 }),
};

/** «300.0 MB», «1.00 GB» — sizes as the rest of the app writes them. */
export function formatSize(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Arabic count with the right noun form: 1 مصدر · 2 مصدران · 3–10 مصادر · 11+ مصدرًا · 0 مصادر. */
export function countAr(n: number, forms: { one: string; two: string; few: string; many: string }): string {
  if (n === 1) return `1 ${forms.one}`;
  if (n === 2) return forms.two;
  const mod = n % 100;
  if (n === 0 || (mod >= 3 && mod <= 10)) return `${n} ${forms.few}`;
  return `${n} ${forms.many}`;
}
