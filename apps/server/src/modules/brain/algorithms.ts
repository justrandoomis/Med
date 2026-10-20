// Algorithms and flowcharts as knowledge structure (§16 «الخوارزميات», §31 Flowcharts; Round 7 H4 item 2) —
// deterministic, NO AI, never invented. From the regions of one processed source version:
//  * NUMBERED STEPS («1. …  2. …», «Step 1: …», «الخطوة الأولى: …») — consecutive numbering from 1, under a heading that
//    names a procedure (algorithm / pathway / approach / management / steps / خوارزمية / خطوات / تدبير …) or written as
//    «Step N» → steps in their printed order;
//  * «IF … THEN» rules («If X, Y», «If X then Y», «If X → Y», «Otherwise Y», «إذا X، Y», «إذا X فيجب …», «وإلا …») →
//    condition → action (an «otherwise» line is the other branch of the rule before it);
//  * ARROWS («A → B → C», «A -> B»; «←» only in an Arabic line, where it points forward) → a chain;
//  * DECISION LISTS (a question line «… ?» followed by «Yes → …» / «No → …» / «نعم: …» / «لا: …») → branches;
//  * FLOWCHART FIGURES (a diagram region whose OCR labels sit under a flowchart / pathway heading or caption) → the
//    labels as nodes, with NO edges: arrows are not read by OCR, so the order and the links stay unknown unless the
//    owner reviewed a figure reading of that diagram (then its confirmed edges are used, marked as such).
// Every node is the EXACT text of a region (or a part of a line of it) with that region's id; an algorithm read from an
// OCR region, or from figure labels without a review, is `uncertain`. Nothing is paraphrased, completed or ordered by
// guess.
import { stripBidiControls, type DiagramStructure } from '@medlevo/shared';
import { fromJson } from '../../db/db';
import { arabicMatchable, headingConceptPart, meaningfulName, originalSlice, sentencesOf, wordsCount, type RegionIn } from './extract';

export const ALGORITHM_EXTRACTOR_VERSION = 'algo-1';

export type AlgorithmKind = 'numbered_steps' | 'conditional' | 'arrow_chain' | 'decision_list' | 'flowchart_figure';

export interface AlgoNode {
  key: string;
  /** exact printed text */
  text: string;
  kind: 'step' | 'condition' | 'action' | 'label';
  regionId: string;
}
export interface AlgoEdge {
  from: string;
  to: string;
  /** printed branch word («Yes», «لا», «Otherwise») — null when the text gives none */
  label: string | null;
}
export interface ExtractedAlgorithm {
  kind: AlgorithmKind;
  /** the heading it sits under / the figure caption (exact text) */
  title: string | null;
  section: string | null;
  /** name of the concept it is about (section heading, else the topic heading before it) */
  conceptName: string | null;
  nodes: AlgoNode[];
  edges: AlgoEdge[];
  /** the order of the nodes is printed (numbered steps, arrow chains) */
  ordered: boolean;
  regionIds: string[];
  pageId: string | null;
  /** read from OCR text / OCR figure labels (may be misread) */
  ocr: boolean;
  /** flowchart figures: the diagram region */
  diagramRegionId: string | null;
  /** flowchart figures: edges came from the owner-reviewed figure reading */
  reviewed: boolean;
}

export interface ReviewedDiagram {
  /** the owner's confirmed structure (only edges between labels it confirmed) */
  structure: DiagramStructure;
}

type RegionWithOrigin = RegionIn & { text_origin?: string | null };

const MAX_NODES = 60;
const MAX_ALGORITHMS = 200;

/** A heading that names a procedure: its numbered lists are steps, one «if» rule is enough. */
const PROCEDURE_CUE =
  /\balgorithms?\b|\bpathways?\b|\bapproach\b|\bprotocols?\b|\bflow\s?-?charts?\b|\bsteps?\b|\bstep-by-step\b|\bmanagement\b|\btreatment\s+plan\b|\bwork-?up\b|\bresuscitation\b|\bdecision\b|خوارزمي|مسار|خطوات|نهج|بروتوكول|مخطط|تدبير|خطه العلاج|خطة العلاج/iu;
const FLOWCHART_CUE = /\balgorithms?\b|\bpathways?\b|\bflow\s?-?charts?\b|\bdecision\b|\bapproach\b|\bmanagement\b|خوارزمي|مسار|مخطط|تدبير|قرار/iu;

const NUMBERED = /^\s*(?:(step|stage)\s*)?([0-9٠-٩]{1,2})\s*[.)\-:–]\s+(\S.*)$/iu;
const AR_ORDINALS: Record<string, number> = { الاولى: 1, الأولى: 1, الثانيه: 2, الثانية: 2, الثالثه: 3, الثالثة: 3, الرابعه: 4, الرابعة: 4, الخامسه: 5, الخامسة: 5, السادسه: 6, السادسة: 6 };
const AR_STEP = /^\s*(?:الخطوه|الخطوة|خطوه|خطوة)\s+([0-9٠-٩]{1,2}|الاولى|الأولى|الثانيه|الثانية|الثالثه|الثالثة|الرابعه|الرابعة|الخامسه|الخامسة|السادسه|السادسة)\s*[:.\-–]?\s*(\S.*)$/u;

const ARROWS = /\s*(?:→|->|⟶|⇒|➔|➝|➜|=>)\s*/u;
const ARROWS_AR = /\s*(?:→|->|⟶|⇒|➔|➝|➜|=>|←)\s*/u;

const EN_IF = /^(?:if|in\s+cases?\s+of)\s+(.+?)(?:\s*,\s*(?:then\s+)?|\s+then\s+|\s*(?:→|->|⟶|⇒|=>)\s*)(\S.*?)[.]?$/iu;
const EN_ELSE = /^(otherwise|if\s+not|else|if\s+negative|if\s+no)\b\s*[,:]?\s*(?:(?:→|->|⟶|⇒|=>)\s*)?(\S.*?)[.]?$/iu;
// Arabic (on harakat-free text): «إذا X، Y» / «إذا X فيجب …» (closed list of consequence words) / «إذا X → Y»
const AR_IF =
  /^(?:و)?(?:اذا|في حال|في حاله|في حالة)\s+(.+?)(?:\s*[،,]\s*(?:ف(?=\S))?|\s+(?=(?:فان|فلا|فيجب|فيتم|فيعطي|فيعطى|فيجري|فيجرى|فيحال|فيعالج|فتجري|فتجرى|فينصح|فهو|فهي|فالعلاج|فالخطوه|عندها|حينها)(?:\s|$))|\s*(?:→|->|⟶|⇒|=>|←)\s*)(\S.*?)[.]?$/du;
const AR_ELSE = /^(والا|وإلا|الا|إلا|خلاف ذلك|وخلاف ذلك|في غير ذلك)(?=\s|[،,:]|$)\s*[،,:]?\s*(?:(?:→|->|←)\s*)?(\S.*?)[.]?$/du;
const YES_NO = /^(yes|no|positive|negative|نعم|لا|إيجابي|ايجابي|سلبي)\s*(?::|→|->|⟶|⇒|=>|←|-|–)\s*(\S.*?)[.]?$/iu;

const toAsciiDigits = (s: string) => s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
const isArabicLine = (s: string) => /[؀-ۿ]/.test(s) && !/[A-Za-z]{3,}/.test(s.replace(/[؀-ۿ]/g, ''));
const nodeText = (s: string) => s.replace(/^[\s•▪◦●○■□\-–*·]+/u, '').replace(/[.;،؛]+\s*$/u, '').trim();
const plausibleNode = (s: string, maxWords: number) => !!s && wordsCount(s) <= maxWords && /[\p{L}]/u.test(s);

interface SectionBuffer {
  title: string | null;
  cue: boolean;
  conceptName: string | null;
  numbered: Array<{ n: number; text: string; regionId: string; stepWord: boolean; ocr: boolean }>;
  numberedRuns: Array<Array<{ n: number; text: string; regionId: string; stepWord: boolean; ocr: boolean }>>;
  rules: Array<{ cond: string; action: string; regionId: string; ocr: boolean; inList: boolean; else?: { label: string; action: string; regionId: string; ocr: boolean } }>;
  chains: Array<{ parts: string[]; regionId: string; ocr: boolean }>;
  decisions: Array<{ question: string; regionId: string; ocr: boolean; branches: Array<{ label: string; text: string; regionId: string; ocr: boolean }> }>;
  pageId: string | null;
}

export function extractAlgorithms(regions: RegionWithOrigin[], reviewed: Map<string, ReviewedDiagram> = new Map()): ExtractedAlgorithm[] {
  const out: ExtractedAlgorithm[] = [];
  let topicConcept: string | null = null;
  let sec: SectionBuffer = newSection(null, null, null);
  // the caption on the same page (figure captions name the flowchart: «Figure 1: Management pathway …»)
  const captionsByPage = new Map<string, string>();
  for (const r of regions) if (r.kind === 'caption' && r.text && !captionsByPage.has(r.page_id ?? '')) captionsByPage.set(r.page_id ?? '', stripBidiControls(r.text).trim());

  function newSection(title: string | null, conceptName: string | null, pageId: string | null): SectionBuffer {
    return { title, cue: !!title && PROCEDURE_CUE.test(title), conceptName, numbered: [], numberedRuns: [], rules: [], chains: [], decisions: [], pageId };
  }

  const flushNumbered = () => {
    if (sec.numbered.length) sec.numberedRuns.push(sec.numbered);
    sec.numbered = [];
  };

  const flushSection = () => {
    flushNumbered();
    const base = { title: sec.title, section: sec.title, conceptName: sec.conceptName, diagramRegionId: null, reviewed: false };
    // numbered steps: a run of ≥ 2 steps 1…n, under a procedure heading or printed as «Step N»
    for (const run of sec.numberedRuns) {
      if (run.length < 2 || !(sec.cue || run.every((x) => x.stepWord))) continue;
      const nodes = run.slice(0, MAX_NODES).map((x, i): AlgoNode => ({ key: `s${i + 1}`, text: x.text, kind: 'step', regionId: x.regionId }));
      out.push({
        ...base,
        kind: 'numbered_steps',
        nodes,
        edges: nodes.slice(1).map((n, i) => ({ from: nodes[i]!.key, to: n.key, label: null })),
        ordered: true,
        regionIds: [...new Set(run.map((x) => x.regionId))],
        pageId: sec.pageId,
        ocr: run.some((x) => x.ocr),
      });
    }
    // if … then rules: ≥ 2 in a section, or 1 under a procedure heading
    if (sec.rules.length >= 2 || (sec.rules.length === 1 && sec.cue)) {
      const nodes: AlgoNode[] = [];
      const edges: AlgoEdge[] = [];
      for (const [i, rule] of sec.rules.slice(0, MAX_NODES / 3).entries()) {
        nodes.push({ key: `c${i + 1}`, text: rule.cond, kind: 'condition', regionId: rule.regionId }, { key: `a${i + 1}`, text: rule.action, kind: 'action', regionId: rule.regionId });
        edges.push({ from: `c${i + 1}`, to: `a${i + 1}`, label: null });
        if (rule.else) {
          nodes.push({ key: `e${i + 1}`, text: rule.else.action, kind: 'action', regionId: rule.else.regionId });
          edges.push({ from: `c${i + 1}`, to: `e${i + 1}`, label: rule.else.label });
        }
      }
      out.push({
        ...base,
        kind: sec.rules.every((x) => x.inList) ? 'decision_list' : 'conditional',
        nodes,
        edges,
        ordered: false,
        regionIds: [...new Set(sec.rules.flatMap((x) => [x.regionId, ...(x.else ? [x.else.regionId] : [])]))],
        pageId: sec.pageId,
        ocr: sec.rules.some((x) => x.ocr || !!x.else?.ocr),
      });
    }
    // arrow chains: the same printed text is one node across the section's lines
    if (sec.chains.length) {
      const nodes: AlgoNode[] = [];
      const edges: AlgoEdge[] = [];
      const keyOf = new Map<string, string>();
      for (const ch of sec.chains) {
        const keys = ch.parts.map((p) => {
          const k = p.toLowerCase();
          let key = keyOf.get(k);
          if (!key && nodes.length < MAX_NODES) {
            key = `n${nodes.length + 1}`;
            keyOf.set(k, key);
            nodes.push({ key, text: p, kind: 'step', regionId: ch.regionId });
          }
          return key ?? null;
        });
        for (let i = 1; i < keys.length; i++) {
          const a = keys[i - 1];
          const b = keys[i];
          if (a && b && a !== b && !edges.some((e) => e.from === a && e.to === b)) edges.push({ from: a, to: b, label: null });
        }
      }
      out.push({ ...base, kind: 'arrow_chain', nodes, edges, ordered: true, regionIds: [...new Set(sec.chains.map((c) => c.regionId))], pageId: sec.pageId, ocr: sec.chains.some((c) => c.ocr) });
    }
    // decision lists: a question with its printed Yes / No branches
    for (const d of sec.decisions) {
      if (d.branches.length === 0) continue;
      const nodes: AlgoNode[] = [{ key: 'q', text: d.question, kind: 'condition', regionId: d.regionId }];
      const edges: AlgoEdge[] = [];
      d.branches.slice(0, MAX_NODES - 1).forEach((b, i) => {
        nodes.push({ key: `b${i + 1}`, text: b.text, kind: 'action', regionId: b.regionId });
        edges.push({ from: 'q', to: `b${i + 1}`, label: b.label });
      });
      out.push({
        ...base,
        kind: 'decision_list',
        nodes,
        edges,
        ordered: false,
        regionIds: [...new Set([d.regionId, ...d.branches.map((b) => b.regionId)])],
        pageId: sec.pageId,
        ocr: d.ocr || d.branches.some((b) => b.ocr),
      });
    }
  };

  for (const r of regions) {
    if (r.kind === 'header' || r.kind === 'footer' || r.kind === 'question' || r.kind === 'option' || r.kind === 'answer_key') continue;
    const text = stripBidiControls(r.text ?? '').trim();
    const ocr = r.text_origin === 'ocr';

    if (r.kind === 'heading' && !r.parent_region_id) {
      flushSection();
      const part = text
        .split(/\s+[—–]\s+|\s+-\s+|:\s+/)
        .map((p) => headingConceptPart(p))
        .find((p) => meaningfulName(p));
      const own = part ?? null;
      if (own && !PROCEDURE_CUE.test(text)) topicConcept = own;
      sec = newSection(text, own ?? topicConcept, r.page_id);
      continue;
    }

    // flowchart figure: a diagram's OCR labels under a flowchart / pathway heading or caption — or a figure whose
    // reading the owner reviewed (its confirmed labels and arrows)
    if (r.kind === 'diagram' || (r.kind === 'figure' && reviewed.has(r.id))) {
      const own = fromJson<DiagramStructure | null>(r.structure_json, null);
      const st = own && own.type === 'diagram' ? own : (reviewed.get(r.id)?.structure ?? null);
      if (!st || st.type !== 'diagram' || st.nodes.length < 2) continue;
      const caption = captionsByPage.get(r.page_id ?? '') ?? null;
      const yesNo = st.nodes.filter((n) => /^(?:yes|no|نعم|لا)$/iu.test(n.label.trim())).length;
      if (!((sec.title && FLOWCHART_CUE.test(sec.title)) || (caption && FLOWCHART_CUE.test(caption)) || yesNo >= 2)) continue;
      const rv = reviewed.get(r.id);
      const labels = (rv?.structure.nodes ?? st.nodes).filter((n) => !!n.label?.trim()).slice(0, MAX_NODES);
      const nodes: AlgoNode[] = labels.map((n) => ({ key: n.id, text: n.label.trim(), kind: 'label', regionId: r.id }));
      const keys = new Set(nodes.map((n) => n.key));
      const edges: AlgoEdge[] = rv ? rv.structure.edges.filter((e) => keys.has(e.from) && keys.has(e.to)).map((e) => ({ from: e.from, to: e.to, label: e.label ?? null })) : [];
      out.push({
        kind: 'flowchart_figure',
        title: caption ?? sec.title,
        section: sec.title,
        conceptName: sec.conceptName,
        nodes,
        edges,
        ordered: false,
        regionIds: [r.id],
        pageId: r.page_id,
        ocr: !rv,
        diagramRegionId: r.id,
        reviewed: !!rv,
      });
      continue;
    }

    if (r.parent_region_id) continue;
    if (!['paragraph', 'list_item', 'text_block', 'note'].includes(r.kind) || !text) {
      if (r.kind !== 'caption') flushNumbered();
      continue;
    }
    sec.pageId ??= r.page_id;

    for (const rawLine of text.split(/\n+/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const bullet = /^[•▪◦●○■□\-–*·]/u.test(line);
      const inList = r.kind === 'list_item' || bullet;

      // numbered steps
      const nm = NUMBERED.exec(line);
      const am = nm ? null : AR_STEP.exec(arabicMatchable(line).s);
      if (nm || am) {
        const n = nm ? Number(toAsciiDigits(nm[2]!)) : /^[0-9٠-٩]+$/.test(am![1]!) ? Number(toAsciiDigits(am![1]!)) : (AR_ORDINALS[am![1]!] ?? 0);
        const body = nm ? nodeText(nm[3]!) : nodeText(line.replace(/^\s*\S+\s+\S+\s*[:.\-–]?\s*/u, ''));
        const expected = (sec.numbered[sec.numbered.length - 1]?.n ?? 0) + 1;
        if (n === 1 && sec.numbered.length) flushNumbered();
        if (n === 1 || n === expected) {
          if (plausibleNode(body, 30)) sec.numbered.push({ n, text: body, regionId: r.id, stepWord: !!nm?.[1] || !!am, ocr });
          continue;
        }
        flushNumbered();
        continue;
      }
      // a non-numbered line ends a numbered run
      flushNumbered();

      const plain = nodeText(line);
      // decision list: «Yes → …» under a question line
      const yn = YES_NO.exec(plain);
      const lastDecision = sec.decisions[sec.decisions.length - 1];
      if (yn && lastDecision) {
        const target = nodeText(yn[2]!);
        if (plausibleNode(target, 20)) lastDecision.branches.push({ label: yn[1]!, text: target, regionId: r.id, ocr });
        continue;
      }
      if (/[?؟]$/.test(plain) && wordsCount(plain) <= 15 && sentencesOf(plain).length === 1) {
        sec.decisions.push({ question: plain, regionId: r.id, ocr, branches: [] });
        continue;
      }

      for (const sent of sentencesOf(plain)) {
        const s = nodeText(sent);
        if (!s) continue;
        // if … then
        if (/^[؀-ۿ]/.test(s)) {
          const { s: ns, map } = arabicMatchable(s);
          const m = AR_IF.exec(ns);
          if (m) {
            const cond = nodeText(originalSlice(s, map, m.indices![1]![0], m.indices![1]![1]));
            let act = nodeText(originalSlice(s, map, m.indices![2]![0], m.indices![2]![1]));
            act = act.replace(/^ف(?=(?:إن|ان|لا|يجب|يتم|ي|ت|هو|هي|ال))/u, '');
            if (plausibleNode(cond, 15) && plausibleNode(act, 25)) sec.rules.push({ cond, action: act, regionId: r.id, ocr, inList });
            continue;
          }
          const e = AR_ELSE.exec(ns);
          const last = sec.rules[sec.rules.length - 1];
          if (e && last && !last.else) {
            const act = nodeText(originalSlice(s, map, e.indices![2]![0], e.indices![2]![1]));
            const label = originalSlice(s, map, e.indices![1]![0], e.indices![1]![1]);
            if (plausibleNode(act, 25)) last.else = { label, action: act, regionId: r.id, ocr };
            continue;
          }
        } else {
          const m = EN_IF.exec(s);
          if (m) {
            const cond = nodeText(m[1]!);
            const act = nodeText(m[2]!);
            if (plausibleNode(cond, 15) && plausibleNode(act, 25)) sec.rules.push({ cond, action: act, regionId: r.id, ocr, inList });
            continue;
          }
          const e = EN_ELSE.exec(s);
          const last = sec.rules[sec.rules.length - 1];
          if (e && last && !last.else) {
            const act = nodeText(e[2]!);
            if (plausibleNode(act, 25)) last.else = { label: e[1]!, action: act, regionId: r.id, ocr };
            continue;
          }
        }
      }

      // arrows: a whole line «A → B → C» (each part a short phrase)
      const arrowRe = isArabicLine(plain) ? ARROWS_AR : ARROWS;
      if (arrowRe.test(plain) && !/^(?:if\b|in\s+cases?\s+of\b|إذا(?:\s|$)|اذا(?:\s|$)|في حال)/iu.test(plain)) {
        const parts = plain.split(new RegExp(arrowRe.source, 'gu')).map((p) => nodeText(p));
        if (parts.length >= 2 && parts.every((p) => plausibleNode(p, 12))) sec.chains.push({ parts, regionId: r.id, ocr });
      }
    }
  }
  flushSection();
  return out.slice(0, MAX_ALGORITHMS);
}
