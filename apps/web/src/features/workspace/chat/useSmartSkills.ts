// Smart chat skills of a lecture (wp/smart-rail): which skills can run here, and why not (each gated by its own
// capability with the server's reason), and how each runs — always through the module that already owns it:
//   explain / summarize   the chat itself (evidence-checked answer)            ai.chat
//   mcq                   POST /exams/generate (page, count, difficulty)        ai.generate_questions
//   figure_question       POST /exams/generate { figure: description }          ai.generate_questions + a described figure
//   case                  POST /cases/generate (this page)                      ai.cases
//   compare               POST /studybook/compare (evidence-checked table)      ai.summaries
//   explain_figure        POST /studybook/explain/stream { explain_image }      ai.figure_explain
//   cards                 POST /learning/cards/from-figures (drafts)            described figures
//   lecture_questions     GET /questions/for-lecture                            questions.vault
//   sources               the conversation's Source Lock (no request)
// Generated questions are published only when they pass the independent checks; the card says what was not.
import { useMemo } from 'react';
import {
  GENERATION_DIFFICULTY_LABELS_AR,
  SOURCE_TYPE_LABELS_AR,
  type CaseSummaryView,
  type GenerateQuestionsRequest,
  type GenerationRunView,
  type SelectionAnchor,
  type SourceScope,
} from '@medlevo/shared';
import { useCapabilities, type FeatureGateState } from '../../../lib/capabilities';
import { api } from '../../../lib/api';
import { useSettings } from '../../../lib/settings';
import { examsApi } from '../../exams/api';
import { questionsApi } from '../../questions/api';
import { studybookApi } from '../../studybook/api';
import type { ChatSkillsConfig, SkillCardResult } from '../../studybook/chat/ChatSurface';
import type { CardContext } from '../../studybook/chat/cards';
import type { SkillItem } from '../../studybook/chat/SkillBar';
import { SKILL_DEFS, requestText } from '../../studybook/chat/skills';
import { referencesOf } from '../../studybook/model';
import type { SourceDocument } from '../data/useSourceDocument';
import { fullPageLabel } from '../model/pages';
import { figuresApi, useFigureDescriptions } from '../panels/FigureDescriptionPanel';

const TERMINAL = new Set(['completed', 'partial', 'needs_review', 'abstained', 'failed']);
const POLL_MS = 1500;
/** generation jobs are bounded on the server; the card waits at most this long before saying so */
const MAX_WAIT_MS = 6 * 60 * 1000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('aborted', 'AbortError'));
    });
  });
}

async function waitForRun(run: GenerationRunView, signal: AbortSignal, onStage: (s: string) => void): Promise<GenerationRunView> {
  const started = Date.now();
  let r = run;
  while (!TERMINAL.has(r.status)) {
    if (Date.now() - started > MAX_WAIT_MS) break;
    onStage(r.status_label_ar);
    await sleep(POLL_MS, signal);
    r = (await examsApi.run(r.id)).run;
  }
  return r;
}

export interface SmartSkillsInput {
  doc: SourceDocument;
  pageIndex: number;
  /** the reader's selection the chat has attached (it focuses explain / summarize / mcq / compare) */
  selection: { anchor: SelectionAnchor; text: string } | null;
  scope: SourceScope;
  online: boolean;
  onJumpToPage?: (pageIndex: number) => void;
  onOpenTool?: CardContext['onOpenTool'];
}

const gateItem = (g: FeatureGateState): { available: boolean; reason: string | null } => ({ available: g.available, reason: g.available ? null : (g.reason ?? 'غير متاح الآن.') });

export function useSmartSkills(p: SmartSkillsInput): ChatSkillsConfig {
  const caps = useCapabilities();
  const { settings } = useSettings();
  const { doc, pageIndex, selection, scope, online } = p;
  const page = doc.pages[pageIndex] ?? null;
  const figs = useFigureDescriptions(doc.version.id, online);
  const described = useMemo(() => (figs.data?.items ?? []).filter((d) => !!d.content), [figs.data]);
  const pageFigure = page ? (described.find((d) => d.page_id === page.id) ?? null) : null;
  const chat = caps.feature('ai.chat');
  const gen = caps.feature('ai.generate_questions');
  const cases = caps.feature('ai.cases');
  const compare = caps.feature('ai.summaries');
  const figure = caps.feature('ai.figure_explain');
  const vault = caps.feature('questions.vault');
  const offline = online ? null : 'تحتاج هذه المهارة اتصالًا بالخادم.';
  const noPage = page ? null : 'افتح صفحة من المحاضرة أولًا.';

  const items: SkillItem[] = SKILL_DEFS.map((def) => {
    let s: { available: boolean; reason: string | null };
    switch (def.id) {
      case 'explain_page':
      case 'summarize':
        s = gateItem(chat);
        break;
      case 'mcq':
        s = gateItem(gen);
        break;
      case 'figure_question':
        s = !gen.available ? gateItem(gen) : pageFigure ? { available: true, reason: null } : { available: false, reason: 'لا توجد في هذه الصفحة صورة موصوفة يُبنى عليها سؤال؛ صِف صور المحاضرة من «⋯ ← المصادر والأشكال».' };
        break;
      case 'explain_figure':
        s = !figure.available ? gateItem(figure) : page?.has_images || selection ? { available: true, reason: null } : { available: false, reason: 'لا يوجد شكل في هذه الصفحة؛ حدّد الشكل أو انتقل إلى صفحة فيها صورة.' };
        break;
      case 'case':
        s = gateItem(cases);
        break;
      case 'compare':
        s = gateItem(compare);
        break;
      case 'cards':
        s = described.length ? { available: true, reason: null } : { available: false, reason: 'لا توجد صور موصوفة في هذه المحاضرة بعد؛ البطاقات تُصنع من أوصاف الصور.' };
        break;
      case 'lecture_questions':
        s = gateItem(vault);
        break;
      case 'sources':
        s = { available: true, reason: null };
        break;
    }
    if (s.available && offline) s = { available: false, reason: offline };
    if (s.available && noPage && def.id !== 'sources' && def.id !== 'lecture_questions' && def.id !== 'cards') s = { available: false, reason: noPage };
    return { def, ...s };
  });

  const pageName = page ? fullPageLabel(page) : null;
  const context = selection ? { page_id: selection.anchor.page_id ?? page?.id ?? null, region_ids: selection.anchor.region_ids ?? [], quote: selection.text.slice(0, 6000) } : page ? { page_id: page.id } : null;
  const pageAnchor: SelectionAnchor | null = page ? { source_id: doc.detail.id, version_id: page.version_id, page_id: page.id, region_ids: [] } : null;

  const run: ChatSkillsConfig['run'] = async (id, input, { signal, onStage }): Promise<SkillCardResult> => {
    const sourceId = doc.detail.id;
    switch (id) {
      case 'mcq':
      case 'figure_question': {
        const difficulty = input.difficulty ?? (id === 'figure_question' ? 'medium' : 'hard');
        const count = id === 'figure_question' ? 1 : (input.count ?? 3);
        const body: GenerateQuestionsRequest =
          id === 'figure_question'
            ? { lecture_source_id: sourceId, figure: { description_id: pageFigure!.id }, count: 1, difficulty, language: 'ar', origin: 'figure' }
            : selection?.anchor.page_id
              ? { lecture_source_id: sourceId, anchor: { page_id: selection.anchor.page_id, region_ids: selection.anchor.region_ids ?? [], quote: selection.text || null }, count, difficulty, origin: 'selection' }
              : { lecture_source_id: sourceId, page_ids: page ? [page.id] : [], count, difficulty };
        const started = await examsApi.generate(body);
        const done = await waitForRun(started.run, signal, onStage);
        const published = done.candidates.filter((c) => c.status === 'published' && c.question_id).map((c) => c.question_id!);
        const pendingIds = done.candidates.filter((c) => c.status === 'needs_review').map((c) => c.id);
        return {
          text: requestText(id, { count, difficultyLabel: GENERATION_DIFFICULTY_LABELS_AR[difficulty], page: pageName, selection: !!selection && id === 'mcq' }),
          attachment: { type: 'mcq', run_id: done.id, question_ids: published, pending_ids: pendingIds, difficulty, figure: id === 'figure_question' },
          context,
        };
      }
      case 'case': {
        const r = await api.post<{ case: CaseSummaryView }>('/cases/generate', { lecture_source_id: sourceId, kind: 'case', page_ids: page ? [page.id] : [], language: 'ar' }, { timeoutMs: 30_000, signal });
        // the case is generated in a job; the card follows it (it polls) — the request returns as soon as it is queued
        onStage(r.case.generation?.status_label_ar ?? r.case.status_label_ar);
        return { text: requestText('case', { page: pageName }), attachment: { type: 'case', case_id: r.case.id }, context };
      }
      case 'compare': {
        const items = (input.items ?? []).filter((x) => x.trim());
        const res = await studybookApi.compare({ items, scope, anchor: selection?.anchor ?? null, style: settings.answer_style }, signal);
        return { text: requestText('compare', { items }), attachment: { type: 'compare', items }, artifact_id: res.artifact.id, context };
      }
      case 'explain_figure': {
        const anchor = selection?.anchor ?? pageAnchor;
        if (!anchor) throw new Error('افتح صفحة فيها الشكل أولًا.');
        const { result } = await studybookApi.explainStream({ action: 'explain_image', anchor, scope, style: settings.answer_style, level: settings.explanation_level }, { signal });
        return { text: requestText('explain_figure', { page: pageName, selection: !!selection }), attachment: { type: 'figure' }, artifact_id: result.artifact.id, context };
      }
      case 'cards': {
        const made = await figuresApi.cardsFromFigures(doc.version.id);
        const drafts = await figuresApi.drafts(doc.version.id);
        const ids = [...new Set([...made.cards.map((c) => c.id), ...drafts.items.map((c) => c.id)])].slice(0, 20);
        return { text: requestText('cards'), attachment: { type: 'cards', card_ids: ids, version_id: doc.version.id, notes_ar: made.notes_ar.slice(0, 6) }, context: page ? { page_id: page.id } : null };
      }
      case 'lecture_questions': {
        const r = await questionsApi.forLecture(sourceId, page?.id ?? null);
        const ids = [...new Set(r.items.map((x) => x.question_id))].slice(0, 60);
        return { text: requestText('lecture_questions'), attachment: { type: 'questions', ids, page_id: page?.id ?? null }, context: page ? { page_id: page.id } : null };
      }
      case 'sources':
        return { text: requestText('sources'), attachment: { type: 'sources', page_id: page?.id ?? null }, context: page ? { page_id: page.id } : null };
      default:
        throw new Error('هذه المهارة سؤال للمحادثة نفسها.');
    }
  };

  const card: CardContext = {
    pageIndexOf: (pageId) => {
      const i = doc.pages.findIndex((x) => x.id === pageId);
      return i >= 0 ? i : null;
    },
    pageLabel: (i) => doc.pages[i]?.printed_label ?? null,
    onJump: p.onJumpToPage,
    onOpenTool: p.onOpenTool,
    sources: [
      { id: doc.detail.id, title: doc.detail.title, role_ar: 'المحاضرة' },
      ...referencesOf(doc.detail).map((r) => ({ id: r.id, title: r.title, role_ar: r.source_type ? (SOURCE_TYPE_LABELS_AR as Record<string, string>)[r.source_type] ?? 'مرجع' : 'مرجع' })),
    ],
  };

  return { items, run, card, compareSeed: selection?.text ? selection.text.slice(0, 200) : undefined };
}

