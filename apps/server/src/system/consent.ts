// The consent registry (system `consent_record`, migration 2300; ARCHITECTURE_DELTA §5.6). Phase 1 completion C1 uses the
// `ai_processing` kind (AOS-21.42): a user's consent naming the AI providers their own content may be sent to. One ACTIVE
// row per user and kind; granting again revokes the previous row in the same transaction; withdrawing revokes it. Rows
// are never deleted (they are the record of what was agreed to, and when).
import type { Db } from '../db/db';
import { fromJson, toJson } from '../db/db';
import { newId } from '../lib/ids';
import type { Clock } from '../lib/time';
import type { Viewer } from './binding';

export interface ConsentRow {
  id: string;
  kind: string;
  subject_user_id: string;
  recorded_by: string;
  resource_db: string | null;
  resource_type: string | null;
  resource_id: string | null;
  scope_json: string;
  text_version: string;
  granted_at: number;
  revoked_at: number | null;
}

export interface AiConsent {
  providers: string[];
  textVersion: string;
  grantedAt: number;
}

export class ConsentRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  /** The viewer's own consents of one kind, newest first (granted and withdrawn). */
  history(viewer: Viewer, kind: 'ai_processing', limit = 20): ConsentRow[] {
    return this.db.all<ConsentRow>('SELECT * FROM consent_record WHERE subject_user_id = ? AND kind = ? ORDER BY granted_at DESC, id DESC LIMIT ?', [
      viewer.userId,
      kind,
      Math.min(Math.max(limit, 1), 100),
    ]);
  }

  /** The viewer's active ai_processing consent. */
  aiProcessing(viewer: Viewer): AiConsent | null {
    return this.aiProcessingOfUserInternal(viewer.userId);
  }

  /**
   * The active ai_processing consent of the user whose content an AI call carries (the orchestrator's gate: a request's
   * viewer or, for background work, the vault's owner — never a user chosen by the caller of a route).
   */
  aiProcessingOfUserInternal(userId: string): AiConsent | null {
    const r = this.db.get<ConsentRow>(`SELECT * FROM consent_record WHERE subject_user_id = ? AND kind = 'ai_processing' AND revoked_at IS NULL ORDER BY granted_at DESC, id DESC LIMIT 1`, [userId]);
    if (!r) return null;
    const scope = fromJson<{ providers?: unknown }>(r.scope_json, {}) ?? {};
    const providers = Array.isArray(scope.providers) ? scope.providers.filter((p): p is string => typeof p === 'string') : [];
    return { providers, textVersion: r.text_version, grantedAt: r.granted_at };
  }

  /** The viewer grants ai_processing for these providers (replaces the active row). */
  grantAiProcessing(viewer: Viewer, providers: string[], textVersion: string): void {
    const now = this.clock.now();
    this.db.tx(() => {
      this.db.run(`UPDATE consent_record SET revoked_at = ? WHERE subject_user_id = ? AND kind = 'ai_processing' AND revoked_at IS NULL`, [now, viewer.userId]);
      this.db.run(
        `INSERT INTO consent_record (id, kind, subject_user_id, recorded_by, resource_db, resource_type, resource_id, scope_json, text_version, granted_at, revoked_at)
         VALUES (?, 'ai_processing', ?, ?, NULL, NULL, NULL, ?, ?, ?, NULL)`,
        [newId(now), viewer.userId, viewer.userId, toJson({ providers: [...new Set(providers)].sort() }), textVersion, now],
      );
    });
  }

  /** The viewer withdraws ai_processing. Returns the number of rows withdrawn. */
  revokeAiProcessing(viewer: Viewer): number {
    return this.db.run(`UPDATE consent_record SET revoked_at = ? WHERE subject_user_id = ? AND kind = 'ai_processing' AND revoked_at IS NULL`, [this.clock.now(), viewer.userId]).changes;
  }
}
