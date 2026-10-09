// Module registry. Each entry is mounted by app.ts with its prefix and receives { ctx }.
// Feature modules (library, sources, processing, …) are appended here by their owning tracks.
import type { ModulePlugin } from '../context';
import aiModule from './ai';
import auditModule from './audit';
import authModule from './auth';
import filesModule from './files';
import jobsModule from './jobs';
import settingsModule from './settings';
import syncModule from './sync';

export interface ModuleEntry {
  name: string;
  /** e.g. '/api/jobs' */
  prefix: string;
  plugin: ModulePlugin;
}

export const MODULES: ModuleEntry[] = [
  { name: 'auth', prefix: '/api/auth', plugin: authModule },
  // settings owns /api/settings and /api/capabilities
  { name: 'settings', prefix: '/api', plugin: settingsModule },
  { name: 'audit', prefix: '/api/audit', plugin: auditModule },
  { name: 'files', prefix: '/api/files', plugin: filesModule },
  { name: 'jobs', prefix: '/api/jobs', plugin: jobsModule },
  { name: 'sync', prefix: '/api/sync', plugin: syncModule },
  { name: 'ai', prefix: '/api/ai', plugin: aiModule },
];
