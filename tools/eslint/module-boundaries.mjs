// ESLint rule `medlevo/module-boundaries` (AOS-21.47; ARCHITECTURE_DELTA §1.1, §2, §5.5): the server's module boundaries
// as a LINT rule, so a violation fails `npm run lint` in the editor and in CI — not only a test run.
//
// It keeps cross-database access inside the allow-listed modules and the space routes inside the allow-list of
// ARCHITECTURE_DELTA §5.5:
//   * `system-db`       the system DB handle (`ctx.system.db`, `this.system.db`) — the system layer and the listed files;
//   * `internal-call`   the `*Internal(` repository methods (no viewer) — the binding / auth / jobs / boot-time code;
//   * `second-db`       a second database in one request (`ctx.dbs.vault(` / `ctx.dbs.space(`) — the copy services only;
//   * `open-db`         a database file opened by path (`openDb(`, `new DatabaseSync(`) — the pool, the boot guard, the
//                       context, backup / restore and the CLIs;
//   * `bound-db`        the bound proxy / a TenantBinding built anywhere but the context and the system layer;
//   * `space-route`     a route under /api/spaces/:spaceId (`app.get('/:spaceId/…')`) — only in the files that mount the
//                       space routes, and only a path that `modules/authz/spaceRoutes.ts` declares as MOUNTED for that
//                       method; a module entry with `prefix: '/api/spaces'` only for the modules on that list.
// The allow-lists below are the single source: `apps/server/test/tenancy/import-boundary.test.ts` imports them too.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SERVER_SRC = join(HERE, '..', '..', 'apps', 'server', 'src');

/** Files (relative to apps/server, forward slashes) that may use the system DB handle, besides src/system/. */
export const SYSTEM_DB_FILES = [
  'src/app.ts', // GET /api/health: SELECT 1
  'src/context.ts',
  'src/modules/auth/index.ts', // limiter + session revocation transactions
  'src/modules/data/backups.ts', // the instance backup snapshots the system DB (VACUUM INTO)
  'src/modules/platform/index.ts', // counts only
  'src/modules/accounts/deletion.ts', // step 2: one system transaction per deletion step
  'src/modules/channels/service.ts', // P1-T4: the channel repository (tree, memberships, codes, roles) on the system DB
  'src/modules/notifications/service.ts', // P1-T4 step 2: the inbox, preferences and the fan-out queue (system DB)
  'src/modules/notifications/fanout.ts', // P1-T4 step 2: the fan-out worker writes notification rows in batches
  'src/modules/moderation/service.ts', // P1-T4 step 2: reports, moderation actions and the scoped audit view
  'src/modules/forks/system.ts', // P1-T5 step 2: lecture_copy (holders, counts only) and read-only course_follow / space / vault lookups
  'src/modules/channels/courseMapping.ts', // AOS-21.5: the viewer's own course follows and the course above (read-only)
];

/** Files that may call `*Internal(` repository methods (no viewer), besides src/system/. */
export const INTERNAL_CALL_FILES = [
  'src/context.ts',
  'src/modules/auth/guard.ts',
  'src/modules/auth/index.ts',
  'src/modules/auth/clientGate.ts', // step 3: is the session's account user #1 (an old client may act only as user #1)
  'src/modules/authz/hook.ts',
  'src/modules/data/backups.ts',
  'src/modules/data/offsite.ts',
  'src/modules/files/blobs.ts', // bytes are kept while several databases share the blob store
  'src/modules/jobs/queue.ts',
  // P1-T1 step 2 — the blob registry / GC, uploads, quotas and the AI ledger are internal APIs of these files:
  'src/modules/files/gc.ts', // mark-and-sweep over every registered database
  'src/modules/files/index.ts', // maintenance tick (last sweep)
  'src/modules/files/uploads.ts', // expiry of upload sessions
  'src/modules/ai/budget.ts', // atomic reservations in the system ledger
  'src/modules/ai/consent.ts', // AOS-21.42: the ai_processing consent of the user whose content a call carries
  'src/modules/accounts/deletion.ts', // finishing a deletion (no viewer: background)
  'src/modules/accounts/export.ts', // the export job (bound to the user's own vault)
  'src/modules/accounts/allowance.ts', // AOS-21.46: the subjects whose AI allowance the viewer may see (moderators)
  'src/modules/platform/index.ts', // platform-admin quotas and counts
  'src/modules/data/vault-backup.ts', // platform-admin per-vault backup / restore
  'src/modules/data/space-backup.ts', // AOS-21.1 / X8 (d): platform-admin per-space backup and restore check
  'src/modules/channels/service.ts', // P1-T4: a subject's space is registered through the registry (registerSpaceInternal)
  'src/modules/forks/system.ts', // AOS-21.18: a copy holder's `view` grant is written / revoked with the copy row (acl_grant)
];

/** The copy services that may open a second database in one request (`ctx.dbs`), besides the context. */
export const SECOND_DB_FILES = [
  'src/modules/forks/promote.ts',
  'src/modules/forks/purgeExtension.ts',
  'src/modules/forks/stubs.ts',
  'src/modules/search/federation.ts',
];
/** Only these module folders may ever hold a copy service (ARCHITECTURE_DELTA §1.1). */
export const SECOND_DB_MODULES = /^src\/modules\/(forks|channels|social|search|evidence|studybook|data)\//;

/** Files that may open a database file by path. */
export const OPEN_DB_FILES = [
  'src/cli/backup.ts',
  'src/cli/eval.ts',
  'src/context.ts',
  'src/db/db.ts',
  'src/modules/data/backup.ts',
  'src/modules/data/restore.ts',
  'src/modules/data/vault-backup.ts', // step 2: the new epoch of a vault restored in place (pool closed first)
  'src/modules/files/gc.ts', // step 2: the GC mark pass reads every database READ-ONLY (never creates a file)
  'src/system/layout.ts',
  'src/system/pool.ts',
  // step 3: the owner migration reads / moves the single-owner database and builds the system DB beside it; the
  // maintenance page reads the owner row to check the owner's password (nothing is written)
  'src/system/ownerMigration.ts',
  'src/system/maintenance.ts',
];

/** Files that mount routes under /api/spaces/:spaceId (the lectures plugin and the publications it registers). */
export const SPACE_ROUTE_FILES = ['src/modules/lectures/index.ts', 'src/modules/forks/publications.ts'];
/** Module entries (modules/index.ts) that may be mounted with the /api/spaces prefix. */
export const SPACE_PREFIX_MODULES = ['lectures'];

const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

/**
 * The MOUNTED declarations of modules/authz/spaceRoutes.ts as `METHOD /api/spaces/:spaceId/…` (each `declare(` call is
 * one line there; a test checks this parse against the module's own SPACE_ROUTES).
 */
export function declaredSpaceRoutes(text = readFileSync(join(SERVER_SRC, 'modules', 'authz', 'spaceRoutes.ts'), 'utf8')) {
  const out = new Set();
  for (const line of text.split('\n')) {
    const m = /^\s*declare\('(GET|POST|PUT|PATCH|DELETE)',\s*'([^']*)'/.exec(line);
    if (m && /,\s*MOUNTED\),?\s*$/.test(line)) out.add(`${m[1]} /api/spaces/:spaceId${m[2]}`);
  }
  return out;
}

/** `/abs/…/apps/server/src/x.ts` → `src/x.ts`; null outside the server's sources. */
export function serverRelative(filename) {
  const norm = filename.split('\\').join('/');
  const i = norm.lastIndexOf('/apps/server/src/');
  return i < 0 ? null : `src/${norm.slice(i + '/apps/server/src/'.length)}`;
}

const propName = (node) => (node && node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier' ? node.property.name : null);
const isNamed = (node, name) => (node?.type === 'Identifier' && node.name === name) || propName(node) === name;
const stringOf = (node) => {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.quasis.length > 0) return node.quasis.map((q) => q.value.cooked ?? '').join('${}');
  return null;
};

let declaredCache = null;

/** @type {import('eslint').Rule.RuleModule} */
export const moduleBoundariesRule = {
  meta: {
    type: 'problem',
    docs: { description: 'Keep cross-database access and space routes inside the allow-lists (AOS-21.47, ARCHITECTURE_DELTA §1.1, §5.5).' },
    schema: [],
    messages: {
      systemDb: 'The system DB handle is used only by src/system/ and the allow-listed files (tools/eslint/module-boundaries.mjs SYSTEM_DB_FILES): {{file}}.',
      internalCall: '`{{name}}()` is an internal repository method (no viewer); only the allow-listed files may call it (INTERNAL_CALL_FILES): {{file}}.',
      secondDb: 'A second database in one request (`dbs.{{kind}}()`) is allowed only in the copy services (SECOND_DB_FILES): {{file}}.',
      openDb: 'Database files are opened by path only by the pool, the boot guard, the context, backup / restore and the CLIs (OPEN_DB_FILES): {{file}}.',
      boundDb: 'Only the context builds the bound database proxy or a TenantBinding: {{file}}.',
      spaceRouteFile: 'A route under /api/spaces/:spaceId may be mounted only in SPACE_ROUTE_FILES (and declared in modules/authz/spaceRoutes.ts): {{file}}.',
      spaceRouteUndeclared: '`{{route}}` is not a MOUNTED declaration of modules/authz/spaceRoutes.ts (the space-route allow-list, ARCHITECTURE_DELTA §5.5).',
      spacePrefix: 'Only {{allowed}} may be mounted with the /api/spaces prefix (the space-route allow-list): module {{name}}.',
    },
  },
  create(context) {
    const file = serverRelative(context.filename ?? context.getFilename());
    if (!file) return {};
    const inSystem = file.startsWith('src/system/');
    const report = (node, messageId, data = {}) => context.report({ node, messageId, data: { file, ...data } });
    return {
      MemberExpression(node) {
        if (propName(node) === 'db' && isNamed(node.object, 'system') && !inSystem && !SYSTEM_DB_FILES.includes(file)) report(node, 'systemDb');
      },
      CallExpression(node) {
        const callee = node.callee;
        const name = propName(callee);
        if (name && /^[a-zA-Z]+Internal$/.test(name) && !inSystem && !INTERNAL_CALL_FILES.includes(file)) report(node, 'internalCall', { name });
        if ((name === 'vault' || name === 'space') && isNamed(callee.object, 'dbs') && file !== 'src/context.ts') {
          if (!SECOND_DB_FILES.includes(file) || !SECOND_DB_MODULES.test(file)) report(node, 'secondDb', { kind: name });
        }
        if (isNamed(callee, 'openDb') && !OPEN_DB_FILES.includes(file)) report(node, 'openDb');
        if (isNamed(callee, 'createBoundDb') && !inSystem && file !== 'src/context.ts') report(node, 'boundDb');
        if (name && ROUTE_METHODS.has(name)) {
          const path = stringOf(node.arguments[0]);
          if (path !== null && (path === '/:spaceId' || path.startsWith('/:spaceId/'))) {
            if (!SPACE_ROUTE_FILES.includes(file)) report(node, 'spaceRouteFile');
            else {
              declaredCache ??= declaredSpaceRoutes();
              const route = `${name.toUpperCase()} /api/spaces${path}`;
              if (!declaredCache.has(route)) context.report({ node, messageId: 'spaceRouteUndeclared', data: { route } });
            }
          }
        }
      },
      NewExpression(node) {
        if (isNamed(node.callee, 'DatabaseSync') && !OPEN_DB_FILES.includes(file)) report(node, 'openDb');
        if (isNamed(node.callee, 'TenantBinding') && !inSystem && file !== 'src/context.ts') report(node, 'boundDb');
      },
      Property(node) {
        const key = node.key?.type === 'Identifier' ? node.key.name : node.key?.type === 'Literal' ? node.key.value : null;
        if (key !== 'prefix') return;
        const value = stringOf(node.value);
        if (value === null || !(value === '/api/spaces' || value.startsWith('/api/spaces/'))) return;
        const owner = node.parent?.type === 'ObjectExpression' ? node.parent.properties.find((p) => p.type === 'Property' && p.key?.type === 'Identifier' && p.key.name === 'name') : null;
        const name = owner ? stringOf(owner.value) : null;
        if (file !== 'src/modules/index.ts' || name === null || !SPACE_PREFIX_MODULES.includes(name)) {
          context.report({ node, messageId: 'spacePrefix', data: { allowed: SPACE_PREFIX_MODULES.join(', '), name: String(name) } });
        }
      },
    };
  },
};

/** The plugin (eslint.config.js registers it as `medlevo`). */
export const medlevoPlugin = { meta: { name: 'medlevo' }, rules: { 'module-boundaries': moduleBoundariesRule } };
export default medlevoPlugin;
