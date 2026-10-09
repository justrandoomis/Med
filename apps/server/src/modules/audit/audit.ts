// Owner-visible change history (change_log). Not a debug log: it records what changed in the owner's
// data (moves, renames, trash, corrections, key changes, settings, security events).
import type { AuditEntry } from '@medlevo/shared';
import type { Db } from '../../db/db';
import { fromJson, toJson } from '../../db/db';
import { newId } from '../../lib/ids';
import type { Clock } from '../../lib/time';

export interface AuditRecordInput {
  entityType: string;
  entityId: string;
  action: string;
  summary?: string | null;
  before?: unknown;
  after?: unknown;
  actor?: 'owner' | 'system' | 'job';
  jobId?: string | null;
}

export interface AuditListFilter {
  entityType?: string;
  entityId?: string;
  limit?: number;
  /** id cursor (exclusive) — entries older than this id */
  before?: string;
}

interface ChangeLogRow {
  id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  summary: string | null;
  before_json: string | null;
  after_json: string | null;
  actor: string;
  job_id: string | null;
  created_at: number;
}

const SECRET_KEY_RE = /(password|passwd|secret|token|api[_-]?key|recovery|cookie|authorization)/i;

/** Strip secret-looking fields from before/after snapshots (defense in depth). */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY_RE.test(k) ? '[redacted]' : redactSecrets(v, depth + 1);
  }
  return out;
}

export class AuditLog {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  /** Inserts a change_log row. Participates in the caller's transaction when called inside db.tx. */
  record(input: AuditRecordInput): string {
    const now = this.clock.now();
    const id = newId(now);
    this.db.run(
      `INSERT INTO change_log (id, entity_type, entity_id, action, summary, before_json, after_json, actor, job_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.entityType,
        input.entityId,
        input.action,
        input.summary ?? null,
        input.before === undefined ? null : toJson(redactSecrets(input.before)),
        input.after === undefined ? null : toJson(redactSecrets(input.after)),
        input.actor ?? 'owner',
        input.jobId ?? null,
        now,
      ],
    );
    return id;
  }

  list(filter: AuditListFilter = {}): { entries: AuditEntry[]; next_before: string | null } {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.entityType) {
      where.push('entity_type = ?');
      params.push(filter.entityType);
    }
    if (filter.entityId) {
      where.push('entity_id = ?');
      params.push(filter.entityId);
    }
    if (filter.before) {
      where.push('id < ?');
      params.push(filter.before);
    }
    const rows = this.db.all<ChangeLogRow>(
      `SELECT * FROM change_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`,
      [...params, limit + 1],
    );
    const page = rows.slice(0, limit);
    return {
      entries: page.map(toEntry),
      next_before: rows.length > limit ? page[page.length - 1]!.id : null,
    };
  }
}

function toEntry(r: ChangeLogRow): AuditEntry {
  return {
    id: r.id,
    entity_type: r.entity_type,
    entity_id: r.entity_id,
    action: r.action,
    summary: r.summary,
    before: fromJson(r.before_json),
    after: fromJson(r.after_json),
    actor: r.actor,
    job_id: r.job_id,
    created_at: r.created_at,
  };
}
