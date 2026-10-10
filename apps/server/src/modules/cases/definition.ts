// Case definitions: normalization of the authoring input into the stored definition, structural validation
// (every reference resolves, every branch target exists, the case can end, every checklist item can be scored),
// the evidence status of every rubric item, and the honesty notes (what the simulation can / cannot assess).
// Pure functions — no database access (the evidence step lives in authoring.ts).
import {
  CASE_KIND_LABELS_AR,
  OSCE_STATION_TYPE_LABELS_AR,
  type CaseDefinition,
  type CaseDefinitionParsed,
  type CaseHonesty,
  type CaseSentence,
  type CaseSentenceInput,
  type CaseStatus,
  type CaseValidationIssue,
} from '@medlevo/shared';

/** Turns every sentence list of the input into stored sentences (the caller resolves evidence / claims). */
export type SentenceResolver = (path: string, sentences: CaseSentenceInput[]) => CaseSentence[];

/** Every sentence list of a parsed definition with its path (for the evidence step). */
export function sentenceLists(def: CaseDefinitionParsed): Array<{ path: string; sentences: CaseSentenceInput[] }> {
  const out: Array<{ path: string; sentences: CaseSentenceInput[] }> = [];
  def.stages.forEach((s, i) => {
    out.push({ path: `stages.${i}.teaching_points`, sentences: s.teaching_points });
    s.decisions.forEach((d, j) => out.push({ path: `stages.${i}.decisions.${j}.explanation`, sentences: d.explanation }));
  });
  def.checklist.forEach((c, i) => out.push({ path: `checklist.${i}.rationale`, sentences: c.rationale }));
  def.viva?.questions.forEach((q, i) => {
    q.points.forEach((p, j) => out.push({ path: `viva.questions.${i}.points.${j}.rationale`, sentences: p.rationale }));
    q.misconceptions.forEach((m, j) => out.push({ path: `viva.questions.${i}.misconceptions.${j}.correction`, sentences: m.correction }));
  });
  return out.filter((l) => l.sentences.length > 0);
}

/** Parsed input → stored definition (sentences resolved by `resolve`). */
export function buildDefinition(def: CaseDefinitionParsed, resolve: SentenceResolver): CaseDefinition {
  return {
    schema_version: 1,
    kind: def.kind,
    title: def.title,
    summary: def.summary,
    language: def.language,
    objectives: def.objectives,
    facts: def.facts.map((f) => ({ id: f.id, label: f.label, value: f.value, kind: f.kind, reveal: f.reveal })),
    stages: def.stages.map((s, i) => ({
      id: s.id,
      type: s.type,
      title: s.title,
      prompt: s.prompt,
      reveal_fact_ids: s.reveal_fact_ids,
      select: s.select,
      decisions: s.decisions.map((d, j) => ({
        id: d.id,
        label: d.label,
        appropriateness: d.appropriateness,
        reveal_fact_ids: d.reveal_fact_ids,
        consequence: d.consequence,
        explanation: resolve(`stages.${i}.decisions.${j}.explanation`, d.explanation),
        next_stage_id: d.next_stage_id,
      })),
      next_stage_id: s.next_stage_id,
      teaching_points: resolve(`stages.${i}.teaching_points`, s.teaching_points),
    })),
    start_stage_id: def.kind === 'case' ? (def.start_stage_id ?? def.stages[0]?.id ?? null) : (def.start_stage_id ?? null),
    checklist: def.checklist.map((c, i) => ({
      id: c.id,
      text: c.text,
      category: c.category,
      points: c.points,
      satisfied_by: c.satisfied_by,
      match: c.match,
      order: c.order,
      critical: c.critical,
      rationale: resolve(`checklist.${i}.rationale`, c.rationale),
    })),
    osce: def.osce
      ? {
          station_type: def.osce.station_type,
          candidate_instructions: def.osce.candidate_instructions,
          roles: [...new Set(def.osce.roles)],
          minutes: def.osce.minutes,
          patient_responses: def.osce.patient_responses,
        }
      : null,
    viva: def.viva
      ? {
          max_follow_ups: def.viva.max_follow_ups,
          questions: def.viva.questions.map((q, i) => ({
            id: q.id,
            prompt: q.prompt,
            points: q.points.map((p, j) => ({ id: p.id, text: p.text, match: p.match, rationale: resolve(`viva.questions.${i}.points.${j}.rationale`, p.rationale) })),
            follow_ups: q.follow_ups.map((f) => ({ id: f.id, prompt: f.prompt, when: f.when })),
            misconceptions: q.misconceptions.map((m, j) => ({ id: m.id, match: m.match, correction: resolve(`viva.questions.${i}.misconceptions.${j}.correction`, m.correction) })),
          })),
        }
      : null,
  };
}

// ───────── validation ─────────
function reachable(def: CaseDefinition): Set<string> {
  const byId = new Map(def.stages.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const stack = def.start_stage_id ? [def.start_stage_id] : [];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id) || !byId.has(id)) continue;
    seen.add(id);
    const s = byId.get(id)!;
    if (s.next_stage_id) stack.push(s.next_stage_id);
    for (const d of s.decisions) if (d.next_stage_id) stack.push(d.next_stage_id);
  }
  return seen;
}

/** A stage from which the scenario can end (no next, and for 'one' stages at least one decision without a branch). */
function endsAt(s: CaseDefinition['stages'][number]): boolean {
  if (s.type === 'review') return true;
  if (s.select === 'one') return s.next_stage_id === null && s.decisions.some((d) => d.next_stage_id === null);
  return s.next_stage_id === null;
}

export function sentenceIsBacked(s: CaseSentence): boolean {
  return s.medical && (s.status === 'linked' || s.status === 'needs_review');
}

export function structuralIssues(def: CaseDefinition): CaseValidationIssue[] {
  const issues: CaseValidationIssue[] = [];
  const err = (path: string, message_ar: string) => issues.push({ path, severity: 'error', message_ar });
  const warn = (path: string, message_ar: string) => issues.push({ path, severity: 'warning', message_ar });

  // unique ids per namespace
  const dup = (ids: string[], what: string, path: string) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) err(path, `المعرّف «${id}» مكرر في ${what}.`);
      seen.add(id);
    }
  };
  dup(def.facts.map((f) => f.id), 'المعلومات الثابتة', 'facts');
  dup(def.stages.map((s) => s.id), 'المراحل', 'stages');
  dup(def.stages.flatMap((s) => s.decisions.map((d) => d.id)), 'القرارات', 'stages');
  dup(def.checklist.map((c) => c.id), 'بنود قائمة التقييم', 'checklist');

  const facts = new Set(def.facts.map((f) => f.id));
  const stageIds = new Set(def.stages.map((s) => s.id));
  const decisionIds = new Set(def.stages.flatMap((s) => s.decisions.map((d) => d.id)));
  const revealedSomewhere = new Set<string>(def.facts.filter((f) => f.reveal === 'start').map((f) => f.id));

  def.stages.forEach((s, i) => {
    const p = `stages.${i}`;
    for (const f of s.reveal_fact_ids) {
      if (!facts.has(f)) err(`${p}.reveal_fact_ids`, `المرحلة «${s.title}» تكشف معلومة غير معرّفة («${f}»).`);
      revealedSomewhere.add(f);
    }
    if (s.next_stage_id && !stageIds.has(s.next_stage_id)) err(`${p}.next_stage_id`, `المرحلة التالية لـ«${s.title}» غير موجودة («${s.next_stage_id}»).`);
    if (s.next_stage_id === s.id) err(`${p}.next_stage_id`, `المرحلة «${s.title}» تشير إلى نفسها.`);
    if (s.select !== 'none' && s.decisions.length === 0) err(`${p}.decisions`, `المرحلة «${s.title}» تطلب قرارًا لكن لا توجد خيارات.`);
    if (s.select === 'none' && s.decisions.length > 0) err(`${p}.decisions`, `المرحلة «${s.title}» للقراءة فقط ولها خيارات؛ اختر «قرار واحد» أو «عدة اختيارات».`);
    s.decisions.forEach((d, j) => {
      const dp = `${p}.decisions.${j}`;
      for (const f of d.reveal_fact_ids) {
        if (!facts.has(f)) err(`${dp}.reveal_fact_ids`, `الخيار «${d.label}» يكشف معلومة غير معرّفة («${f}»).`);
        revealedSomewhere.add(f);
      }
      if (d.next_stage_id && !stageIds.has(d.next_stage_id)) err(`${dp}.next_stage_id`, `الخيار «${d.label}» يتفرع إلى مرحلة غير موجودة («${d.next_stage_id}»).`);
      if (d.next_stage_id && s.select === 'many') err(`${dp}.next_stage_id`, `الخيار «${d.label}» في مرحلة متعددة الاختيار لا يمكن أن يتفرع؛ التفرع للقرار الواحد فقط.`);
      if (d.appropriateness === 'inappropriate' && !d.consequence.trim() && !d.explanation.some(sentenceIsBacked)) {
        warn(dp, `الخيار غير المناسب «${d.label}» بلا أثر مؤلف ولا شرح مرتبط بدليل؛ سيُعرض أنه غير مناسب دون تفسير.`);
      }
    });
  });

  if (def.kind === 'case') {
    if (def.stages.length === 0) err('stages', 'الحالة السريرية تحتاج مرحلة واحدة على الأقل.');
    else if (!def.start_stage_id || !stageIds.has(def.start_stage_id)) err('start_stage_id', 'مرحلة البداية غير محددة أو غير موجودة.');
    else {
      const reach = reachable(def);
      def.stages.forEach((s, i) => {
        if (!reach.has(s.id)) warn(`stages.${i}`, `لا يمكن الوصول إلى المرحلة «${s.title}» من البداية.`);
      });
      if (![...reach].some((id) => endsAt(def.stages.find((s) => s.id === id)!))) err('stages', 'لا توجد نهاية يمكن الوصول إليها: كل المراحل تؤدي إلى مرحلة أخرى.');
    }
  }
  if (def.kind === 'osce') {
    if (!def.osce) err('osce', 'محطة OSCE تحتاج نوع المحطة وتعليمات المرشح.');
    else {
      def.osce.patient_responses.forEach((r, i) => {
        if (!facts.has(r.fact_id)) err(`osce.patient_responses.${i}`, `رد المريض «${r.id}» يشير إلى معلومة غير معرّفة («${r.fact_id}»).`);
        revealedSomewhere.add(r.fact_id);
      });
      if (def.osce.roles.includes('patient') && def.osce.patient_responses.length === 0 && def.osce.station_type !== 'data_interpretation') {
        warn('osce.patient_responses', 'لا توجد ردود معرّفة للمريض: سيجيب «لا تتوفر هذه المعلومة في سيناريو المحطة» على كل سؤال.');
      }
    }
    if (def.checklist.length === 0) err('checklist', 'محطة OSCE تحتاج قائمة تقييم (Checklist) من بند واحد على الأقل.');
  }
  if (def.kind === 'viva') {
    if (!def.viva || def.viva.questions.length === 0) err('viva', 'الامتحان الشفهي يحتاج سؤالًا واحدًا على الأقل.');
    def.viva?.questions.forEach((q, i) => {
      const pids = new Set(q.points.map((p) => p.id));
      dup(q.points.map((p) => p.id), `نقاط السؤال «${q.id}»`, `viva.questions.${i}.points`);
      q.follow_ups.forEach((f, j) => {
        if (f.when.type !== 'always' && !pids.has(f.when.point_id)) err(`viva.questions.${i}.follow_ups.${j}`, `سؤال المتابعة «${f.id}» يشير إلى نقطة غير موجودة («${f.when.point_id}»).`);
      });
      q.points.forEach((p, j) => {
        if (!p.rationale.some(sentenceIsBacked)) warn(`viva.questions.${i}.points.${j}`, `النقطة «${p.text}» بلا دليل من مصادرك.`);
      });
    });
    dup(def.viva?.questions.map((q) => q.id) ?? [], 'أسئلة الامتحان الشفهي', 'viva.questions');
  }

  def.checklist.forEach((c, i) => {
    const p = `checklist.${i}`;
    for (const d of c.satisfied_by) if (!decisionIds.has(d)) err(`${p}.satisfied_by`, `البند «${c.text}» يشير إلى قرار غير موجود («${d}»).`);
    const scorable = c.satisfied_by.length > 0 || c.match.length > 0;
    if (!scorable) err(p, `البند «${c.text}» لا يمكن تقييمه: اربطه بقرار أو أضف عبارات يطابقها النص.`);
    if (def.kind === 'case' && c.satisfied_by.length === 0 && c.match.length > 0) {
      warn(p, `البند «${c.text}» يعتمد على نص مكتوب، والحالة التدريجية تُجاب بالاختيارات فقط؛ اربطه بقرار.`);
    }
    if (!c.rationale.some(sentenceIsBacked)) warn(p, `البند «${c.text}» بلا دليل من مصادرك.`);
  });

  def.facts.forEach((f, i) => {
    if (f.reveal === 'on_request' && !revealedSomewhere.has(f.id)) warn(`facts.${i}`, `المعلومة «${f.label}» لا تكشفها أي مرحلة أو قرار أو رد؛ لن تظهر أبدًا.`);
  });

  // owner sentences whose evidence does not support them are kept, but said
  const sentencesOf = (path: string, list: CaseSentence[]) =>
    list.forEach((s, i) => {
      if (s.status === 'rejected' || s.status === 'conflict') warn(`${path}.${i}`, `جملة «${clipText(s.text, 60)}»: ${s.reason_ar ?? 'الدليل المرفق لا يدعمها'}`);
    });
  def.stages.forEach((s, i) => {
    sentencesOf(`stages.${i}.teaching_points`, s.teaching_points);
    s.decisions.forEach((d, j) => sentencesOf(`stages.${i}.decisions.${j}.explanation`, d.explanation));
  });
  def.checklist.forEach((c, i) => sentencesOf(`checklist.${i}.rationale`, c.rationale));
  def.viva?.questions.forEach((q, i) => {
    q.points.forEach((p, j) => sentencesOf(`viva.questions.${i}.points.${j}.rationale`, p.rationale));
    q.misconceptions.forEach((m, j) => sentencesOf(`viva.questions.${i}.misconceptions.${j}.correction`, m.correction));
  });
  return issues;
}

function clipText(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

export function statusFor(issues: CaseValidationIssue[]): { status: CaseStatus; reasons_ar: string[] } {
  const errors = issues.filter((i) => i.severity === 'error');
  if (errors.length) return { status: 'draft', reasons_ar: [...new Set(errors.map((e) => e.message_ar))].slice(0, 12) };
  const warnings = issues.filter((i) => i.severity === 'warning');
  if (warnings.length) return { status: 'needs_review', reasons_ar: [...new Set(warnings.map((w) => w.message_ar))].slice(0, 12) };
  return { status: 'ready', reasons_ar: [] };
}

export function isPlayable(issues: CaseValidationIssue[]): boolean {
  return !issues.some((i) => i.severity === 'error');
}

// ───────── honesty (§42: say what the simulation assesses and what it cannot) ─────────
export const VOICE_UNAVAILABLE_AR =
  'الوضع الصوتي غير متاح: لا يوجد مزود لتحويل الكلام إلى نص في هذا الإصدار، والميكروفون لا يُشغَّل. عند توفره ستُعرض الكلمات المتعرَّف عليها لتصححها قبل التقييم، ولن يُحسب خطأ التعرف على مصطلح خطأً معرفيًا.';

export function honestyFor(def: CaseDefinition): CaseHonesty {
  const can: string[] = [];
  const cannot: string[] = [];
  if (def.kind === 'case') {
    can.push('قراراتك في كل مرحلة مقارنةً بما حدده التعريف المؤلف للحالة (مناسب / مقبول / غير مناسب).');
    can.push('بنود قائمة التقييم المرتبطة بالقرارات التي اخترتها.');
    cannot.push('لا تقيّم المحاكاة سرعة القرار في الواقع ولا ما كنت ستفعله خارج الخيارات المعروضة.');
  }
  if (def.kind === 'osce' && def.osce) {
    can.push(`ذكر بنود قائمة التقييم نصيًا في محطة ${OSCE_STATION_TYPE_LABELS_AR[def.osce.station_type]} (مطابقة كلمات محددة سلفًا).`);
    if (def.checklist.some((c) => c.order !== null)) can.push('ترتيب الخطوات كما وردت في نصك مقارنةً بالترتيب المحدد في التعريف.');
    if (def.osce.station_type === 'examination') cannot.push('لا تقيس المحاكاة تنفيذ الفحص الجسدي الفعلي ولا المهارة اليدوية ولا صحة الحركة؛ وصفك النصي للخطوات ليس أداءً لها.');
    if (['history_taking', 'counselling', 'emergency'].includes(def.osce.station_type)) {
      cannot.push('لا تقيس التواصل غير اللفظي ولا نبرة الصوت ولا التعاطف الفعلي ولا إدارة الوقت أمام مريض حقيقي.');
    }
    if (def.osce.station_type === 'emergency') cannot.push('لا تقيس الأداء تحت ضغط حقيقي ولا العمل مع فريق.');
    cannot.push('يجيب «المريض» فقط بالمعلومات المعرّفة في المحطة؛ ما لم يُعرَّف لا يُخترع.');
  }
  if (def.kind === 'viva') {
    can.push('تغطية إجابتك المكتوبة للنقاط المحددة لكل سؤال (مطابقة كلمات، أو حكم نموذج ذكاء اصطناعي إن اخترته وكان متاحًا).');
    can.push('المفاهيم غير الدقيقة المعرّفة سلفًا إن وردت في إجابتك.');
    cannot.push('لا تقيس الطلاقة الشفهية ولا الثقة أمام ممتحن حقيقي.');
  }
  cannot.push('المطابقة بالكلمات قد تفوّت صياغة صحيحة مختلفة أو تقبل ذكرًا عابرًا؛ يمكنك تصحيح الحكم على أي بند بعد الإنهاء.');
  cannot.push('الدرجة تقدير من بنود هذه القائمة فقط، وليست حكمًا على كفاءتك السريرية.');
  cannot.push(`تفاصيل المريض بيانات تعليمية مؤلفة (${CASE_KIND_LABELS_AR[def.kind]})، لا مريض حقيقي.`);
  return { can_assess_ar: can, cannot_assess_ar: cannot };
}
