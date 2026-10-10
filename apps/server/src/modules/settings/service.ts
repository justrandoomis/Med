// Owner settings: key/value rows in owner_setting, validated per key by the shared zod schema and
// merged with defaults. Invalid stored values fall back to the default for that key (never crash).
import { DEFAULT_OWNER_SETTINGS, mergeSettingsPatch, ownerSettingsSchema, type OwnerSettings } from '@medlevo/shared';
import type { Db } from '../../db/db';
import { fromJson, toJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { validationError } from '../../lib/http';
import { isValidTimeZone, type Clock } from '../../lib/time';

const KEYS = Object.keys(ownerSettingsSchema.shape) as Array<keyof OwnerSettings>;

export class SettingsService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  get(): OwnerSettings {
    const rows = this.db.all<{ key: string; value_json: string }>('SELECT key, value_json FROM owner_setting');
    const merged: Record<string, unknown> = { ...DEFAULT_OWNER_SETTINGS };
    for (const r of rows) {
      if (!(KEYS as string[]).includes(r.key)) continue;
      const fieldSchema = ownerSettingsSchema.shape[r.key as keyof OwnerSettings];
      const parsed = fieldSchema.safeParse(fromJson(r.value_json));
      if (parsed.success) merged[r.key] = parsed.data;
    }
    return ownerSettingsSchema.parse(merged);
  }

  /** Validate a partial patch against the full schema; unknown keys are rejected. Returns the new settings. */
  patch(patch: Record<string, unknown>): { before: OwnerSettings; after: OwnerSettings; changedKeys: string[] } {
    const unknown = Object.keys(patch).filter((k) => !(KEYS as string[]).includes(k));
    if (unknown.length) {
      throw new AppError('VALIDATION_FAILED', 'البيانات المرسلة غير صالحة. راجع الحقول المحددة ثم أعد المحاولة.', 400, {
        where: 'body',
        issues: [{ path: '', code: 'unrecognized_keys', message: `حقول غير معروفة: ${unknown.join('، ')}.` }],
      });
    }
    const before = this.get();
    // a partial source_priority changes only the purposes it names (the others are never reset to the defaults)
    const candidate = mergeSettingsPatch(before, patch);
    const parsed = ownerSettingsSchema.safeParse(candidate);
    if (!parsed.success) throw validationError(parsed.error, 'body');
    if (!isValidTimeZone(parsed.data.timezone)) {
      throw new AppError('VALIDATION_FAILED', 'المنطقة الزمنية غير معروفة.', 400, {
        where: 'body',
        issues: [{ path: 'timezone', code: 'invalid_value', message: 'اختر منطقة زمنية صحيحة مثل Asia/Baghdad.' }],
      });
    }
    const after = parsed.data;
    const now = this.clock.now();
    const changedKeys: string[] = [];
    this.db.tx(() => {
      for (const key of Object.keys(patch) as Array<keyof OwnerSettings>) {
        const value = after[key];
        if (JSON.stringify(value) === JSON.stringify(before[key])) continue;
        changedKeys.push(key);
        this.db.run(
          `INSERT INTO owner_setting (key, value_json, updated_at) VALUES (?, ?, ?)
           ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
          [key, toJson(value), now],
        );
      }
    });
    return { before, after, changedKeys };
  }
}
