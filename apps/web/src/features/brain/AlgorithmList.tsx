// Algorithms / flowcharts read from the lectures (Round 7 H4, §16, §31): numbered steps, «if … then» rules, arrow
// chains, decision lists, flowchart-figure labels. Each step is the lecture's exact text with a link to its place; the
// certainty is said in words (OCR / figure labels without arrows are «غير مؤكدة»); a flowchart figure without a
// reviewed reading has NO links between its labels — it says so instead of drawing guessed arrows.
import { Link } from 'react-router-dom';
import { GitBranch } from 'lucide-react';
import type { KnowledgeAlgorithmListResponse, KnowledgeAlgorithmView } from '@medlevo/shared';
import { ErrorState, LoadingState, StatusPill } from '../../design';
import { useQuery } from '../library/data';
import { conceptUrl } from './api';

export function algorithmsPath(filter: { sourceId?: string; conceptId?: string; courseNodeId?: string }): string {
  const q = new URLSearchParams();
  if (filter.sourceId) q.set('source_id', filter.sourceId);
  if (filter.conceptId) q.set('concept_id', filter.conceptId);
  if (filter.courseNodeId) q.set('course_node_id', filter.courseNodeId);
  return `/brain/algorithms?${q.toString()}`;
}

function StepText({ text, href }: { text: string; href: string | null }) {
  return href ? (
    <Link className="lw-link" to={href}>
      <bdi>{text}</bdi>
    </Link>
  ) : (
    <bdi>{text}</bdi>
  );
}

export function AlgorithmCard({ a, showSource, headingLevel = 3 }: { a: KnowledgeAlgorithmView; showSource?: boolean; headingLevel?: 3 | 4 }) {
  const byKey = new Map(a.nodes.map((n) => [n.key, n]));
  const H = `h${headingLevel}` as 'h3' | 'h4';
  const outgoing = (key: string) => a.edges.filter((e) => e.from === key);
  const pending = a.certainty === 'uncertain';
  return (
    <article className="kb-algo" aria-label={`${a.kind_label_ar}${a.title ? `: ${a.title}` : ''}`}>
      <H className="kb-algo__title">
        <GitBranch size={16} aria-hidden="true" /> <bdi>{a.title ?? a.kind_label_ar}</bdi>
      </H>
      <div className="kb-algo__meta">
        <span className="kb-role">{a.kind_label_ar}</span>
        <StatusPill tone={pending ? 'warning' : a.certainty === 'owner_reviewed' ? 'success' : 'neutral'}>{a.certainty_label_ar}</StatusPill>
        {showSource && (
          <span className="lw-muted">
            <bdi>{a.source_title}</bdi>
            {a.location?.page_label_ar ? ` — ${a.location.page_label_ar}` : ''}
          </span>
        )}
        {!showSource && a.location?.page_label_ar && <span className="lw-muted">{a.location.page_label_ar}</span>}
        {a.concept && (
          <Link className="lw-link" to={conceptUrl(a.concept.id)}>
            <bdi>{a.concept.name}</bdi>
          </Link>
        )}
      </div>
      {a.kind === 'numbered_steps' || a.kind === 'arrow_chain' ? (
        <>
          <ol className="kb-algo__steps">
            {a.nodes.map((n) => (
              <li key={n.key}>
                <StepText text={n.text} href={n.href} />
              </li>
            ))}
          </ol>
          {a.kind === 'arrow_chain' && a.edges.length > a.nodes.length - 1 && (
            <ul className="kb-algo__branches" aria-label="الأسهم كما كُتبت">
              {a.edges.map((e, i) => (
                <li key={i}>
                  <bdi>{byKey.get(e.from)?.text}</bdi> ← <bdi>{byKey.get(e.to)?.text}</bdi>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : a.kind === 'flowchart_figure' ? (
        <>
          <ul className="kb-algo__labels" aria-label="تسميات الشكل">
            {a.nodes.map((n) => (
              <li key={n.key}>
                <StepText text={n.text} href={n.href} />
              </li>
            ))}
          </ul>
          {a.edges.length > 0 && (
            <ul className="kb-algo__branches" aria-label="الأسهم المؤكدة">
              {a.edges.map((e, i) => (
                <li key={i}>
                  <bdi>{byKey.get(e.from)?.text}</bdi> ← <bdi>{byKey.get(e.to)?.text}</bdi>
                  {e.label && <span className="kb-role">{e.label}</span>}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <ul className="kb-algo__rules">
          {a.nodes
            .filter((n) => n.kind === 'condition')
            .map((c) => (
              <li key={c.key}>
                <span className="kb-algo__cond">
                  <span className="lw-muted">إذا </span>
                  <StepText text={c.text} href={c.href} />
                </span>
                <ul className="kb-algo__branches">
                  {outgoing(c.key).map((e, i) => {
                    const target = byKey.get(e.to);
                    return (
                      <li key={i}>
                        {e.label ? <span className="kb-role">{e.label}</span> : <span className="lw-muted">← </span>}
                        {target && <StepText text={target.text} href={target.href} />}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
        </ul>
      )}
      {a.notes_ar.map((n) => (
        <p key={n} className="lw-muted">
          {n}
        </p>
      ))}
    </article>
  );
}

/** Algorithms of a lecture, a concept or a course (empty → a short honest sentence, not a placeholder). */
export function AlgorithmList({ filter, showSource, emptyText, headingLevel }: { filter: { sourceId?: string; conceptId?: string; courseNodeId?: string }; showSource?: boolean; emptyText: string; headingLevel?: 3 | 4 }) {
  const q = useQuery<KnowledgeAlgorithmListResponse>(algorithmsPath(filter), { cache: true });
  if (q.loading && !q.data) return <LoadingState stage="جارٍ تحميل الخوارزميات…" inline />;
  if (q.error && !q.data) return <ErrorState inline message={q.error.message} onRetry={() => void q.refresh()} />;
  const items = q.data?.items ?? [];
  return (
    <div className="lw-stack-sm">
      {items.length === 0 ? (
        <p className="lw-muted">{emptyText}</p>
      ) : (
        items.map((a) => <AlgorithmCard key={a.id} a={a} showSource={showSource} headingLevel={headingLevel} />)
      )}
      {items.length > 0 &&
        q.data!.notes_ar.map((n) => (
          <p key={n} className="lw-muted">
            {n}
          </p>
        ))}
    </div>
  );
}
