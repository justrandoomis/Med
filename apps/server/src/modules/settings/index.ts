// Personal settings + capabilities. Mounted at /api:
//   GET   /api/settings      → { settings } (merged with defaults)
//   PATCH /api/settings      → partial update, validated by the shared schema
//   GET   /api/capabilities  → CapabilitiesResponse (live feature states with Arabic reasons)
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CapabilitiesResponse, OwnerSettings, SettingsResponse } from '@medlevo/shared';
import type { ModuleOptions } from '../../context';
import { parseBody } from '../../lib/http';

export { CapabilityRegistry, AI_DEPENDENT_FEATURES } from './capabilities';
export { SettingsService } from './service';

const patchBody = z.record(z.string(), z.unknown());

export default async function settingsModule(app: FastifyInstance, opts: ModuleOptions): Promise<void> {
  const { ctx } = opts;

  app.get('/settings', async (): Promise<SettingsResponse> => ({ settings: ctx.settings.get() }));

  app.patch('/settings', async (req): Promise<SettingsResponse> => {
    const patch = parseBody(patchBody, req);
    const { before, after, changedKeys } = ctx.settings.patch(patch);
    if (changedKeys.length) {
      const pick = (s: OwnerSettings) => Object.fromEntries(changedKeys.map((k) => [k, s[k as keyof OwnerSettings]]));
      ctx.audit.record({
        entityType: 'owner_setting',
        entityId: 'owner',
        action: 'update',
        summary: `تعديل الإعدادات: ${changedKeys.join('، ')}`,
        before: pick(before),
        after: pick(after),
      });
    }
    return { settings: after };
  });

  app.get('/capabilities', async (): Promise<CapabilitiesResponse> => ctx.capabilities.snapshot());
}
