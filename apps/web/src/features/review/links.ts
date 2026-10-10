// In-app links used by the learning screens.
const e = encodeURIComponent;

/** The study workspace at a page (exact page id preferred; never a guessed substitute). */
export function studyUrl(sourceId: string, at: { versionId?: string | null; pageId?: string | null; pageIndex?: number | null } = {}): string {
  const q = new URLSearchParams();
  if (at.versionId) q.set('v', at.versionId);
  if (at.pageId) q.set('page_id', at.pageId);
  else if (at.pageIndex != null) q.set('page', String(at.pageIndex));
  const s = q.toString();
  return `/study/${e(sourceId)}${s ? `?${s}` : ''}`;
}

export const cardUrl = (id: string, back?: string) => `/review/cards/${e(id)}${back ? `?back=${e(back)}` : ''}`;
export const sessionUrl = (opts: { sourceId?: string | null; cards?: string[] | null; back?: string | null } = {}) => {
  const q = new URLSearchParams();
  if (opts.sourceId) q.set('source_id', opts.sourceId);
  if (opts.cards?.length) q.set('cards', opts.cards.join(','));
  if (opts.back) q.set('back', opts.back);
  const s = q.toString();
  return `/review/session${s ? `?${s}` : ''}`;
};
export const questionUrl = (id: string) => `/questions/${e(id)}`;
export const practiceUrl = (questionId: string) => `/practice?question_id=${e(questionId)}`;
export const weaknessUrl = (id: string) => `/weakness/${e(id)}`;
export const replayUrl = (questionId: string, attemptId?: string | null) => `/weakness/replay/${e(questionId)}${attemptId ? `?attempt_id=${e(attemptId)}` : ''}`;
export const planUrl = (id: string) => `/planner/${e(id)}`;

/** Accept only in-app paths for «back» parameters (no open redirects). */
export function safeBack(v: string | null | undefined, fallback: string): string {
  return v && v.startsWith('/') && !v.startsWith('//') && !v.includes('\\') ? v : fallback;
}
