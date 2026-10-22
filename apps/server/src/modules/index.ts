// Module registry. Each entry is mounted by app.ts with its prefix and receives { ctx }.
// Feature modules (library, sources, processing, …) are appended here by their owning tracks.
import type { ModulePlugin } from '../context';
import aiModule from './ai';
import auditModule from './audit';
import { createAuthModule } from './auth';
import filesModule from './files';
import jobsModule from './jobs';
import settingsModule from './settings';
import syncModule from './sync';
import libraryModule from './library';
import sourcesModule from './sources';
import processingModule from './processing';
import annotationsModule from './annotations';
import evidenceModule from './evidence';
import searchModule from './search';
import studybookModule from './studybook';
import questionsModule from './questions';
import examsModule from './exams';
import learningModule from './learning';
import controlModule from './control';
import dataModule from './data';
import casesModule from './cases';
import mediaModule from './media';
import brainModule from './brain';
import versionsModule from './versions';
import accountsModule from './accounts';
import platformModule from './platform';
import channelsModule from './channels';
import lecturesModule from './lectures';
import forksModule from './forks';
import notificationsModule from './notifications';
import moderationModule, { adminAuditModule } from './moderation';
import { createChannelJoinVerifier } from './channels/verifier';

export interface ModuleEntry {
  name: string;
  /** e.g. '/api/jobs' */
  prefix: string;
  plugin: ModulePlugin;
}

export const MODULES: ModuleEntry[] = [
  // P1-T4: registration (POST /api/auth/register) behind P1-T1's JoinTokenVerifier, implemented by the channels module
  { name: 'auth', prefix: '/api/auth', plugin: createAuthModule({ joinVerifier: createChannelJoinVerifier }) },
  // settings owns /api/settings and /api/capabilities
  { name: 'settings', prefix: '/api', plugin: settingsModule },
  { name: 'audit', prefix: '/api/audit', plugin: auditModule },
  { name: 'files', prefix: '/api/files', plugin: filesModule },
  { name: 'jobs', prefix: '/api/jobs', plugin: jobsModule },
  { name: 'sync', prefix: '/api/sync', plugin: syncModule },
  { name: 'ai', prefix: '/api/ai', plugin: aiModule },
  { name: 'library', prefix: '/api/library', plugin: libraryModule },
  { name: 'sources', prefix: '/api/sources', plugin: sourcesModule },
  { name: 'processing', prefix: '/api/processing', plugin: processingModule },
  { name: 'annotations', prefix: '/api/annotations', plugin: annotationsModule },
  { name: 'evidence', prefix: '/api/evidence', plugin: evidenceModule },
  { name: 'search', prefix: '/api/search', plugin: searchModule },
  { name: 'studybook', prefix: '/api/studybook', plugin: studybookModule },
  { name: 'questions', prefix: '/api/questions', plugin: questionsModule },
  { name: 'exams', prefix: '/api/exams', plugin: examsModule },
  { name: 'learning', prefix: '/api/learning', plugin: learningModule },
  { name: 'control', prefix: '/api/control', plugin: controlModule },
  { name: 'data', prefix: '/api/data', plugin: dataModule },
  { name: 'cases', prefix: '/api/cases', plugin: casesModule },
  { name: 'media', prefix: '/api/media', plugin: mediaModule },
  // Course Brain (track F2): knowledge structure, concept corrections, maps, coverage
  { name: 'brain', prefix: '/api/brain', plugin: brainModule },
  // Academic OS P1-T3: lecture identity, page fingerprints, version page maps, compare, link candidates
  { name: 'versions', prefix: '/api/versions', plugin: versionsModule },
  // Academic OS P1-T1 step 1: the signed-in user's own account and devices (system DB, viewer-scoped)
  { name: 'accounts', prefix: '/api/accounts', plugin: accountsModule },
  // Academic OS P1-T1 step 1: whole-deployment views, platform admin only (404 for everyone else)
  { name: 'platform', prefix: '/api/platform', plugin: platformModule },
  // Academic OS P1-T4 step 1: the university tree, joining, members, codes, invitations and roles (system DB)
  { name: 'channels', prefix: '/api/channels', plugin: channelsModule },
  // Academic OS P1-T4 step 2: the in-app inbox, minimal moderation and the scoped audit view (system DB)
  { name: 'notifications', prefix: '/api/notifications', plugin: notificationsModule },
  { name: 'moderation', prefix: '/api/moderation', plugin: moderationModule },
  { name: 'admin', prefix: '/api/admin', plugin: adminAuditModule },
  // Academic OS P1-T5 step 1: official lectures and the subject's content in subject spaces (/api/spaces/:spaceId/…,
  // every route on the space-route allow-list, authz/spaceRoutes.ts)
  { name: 'lectures', prefix: '/api/spaces', plugin: lecturesModule },
  // Academic OS P1-T5 step 2: study copies of official lectures in the user's own vault (stubs, «ابدأ الدراسة», link)
  { name: 'forks', prefix: '/api/copies', plugin: forksModule },
];
