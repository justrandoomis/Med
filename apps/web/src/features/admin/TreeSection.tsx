// «الشجرة» (P1-T4 step 3; IA §4.10; PRD AOS-18.2, 2.1, 21.2, 21.3): create, rename, move and archive the nodes of the
// university tree under the viewer's scope — kinds strictly descend (levels may be skipped), a subject gets its own
// space, and archiving shows its impact first (nodes below, memberships that stop granting access, spaces that become
// read-only, open codes revoked). The platform admin adds universities. Every change is audited by the server.
// (AOS-2.3 / 18.3) A subject can start from a study template — the SAME templates as the personal library's
// «قوالب الدراسة» (GET /api/library/templates): its English name comes from the template and its lecture skeleton (one
// empty draft per topic, unseen by students) is created in the new subject's space; an existing subject gets the
// skeleton from its row («مسودات محاضرات من قالب»). The server decides who may (official moderators of the subject).
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Archive, FolderTree, LayoutTemplate, MoveRight, Pencil, Plus } from 'lucide-react';
import {
  CHANNEL_KIND_LABELS_AR,
  CHANNEL_KINDS,
  isDescendingKind,
  JOIN_POLICIES,
  JOIN_POLICY_LABELS_AR,
  templateLectureTitles,
  type ChannelArchivePreview,
  type ChannelKind,
  type ChannelNodeView,
  type CreateChannelNodeRequest,
  type JoinPolicy,
  type PatchChannelNodeRequest,
  type StudyTemplate,
  type TemplatesResponse,
} from '@medlevo/shared';
import { Button, ConfirmDialog, Dialog, EmptyState, IconButton, Select, StatusPill, TextField, useToast } from '../../design';
import { api, errorMessage, fieldErrors } from '../../lib/api';
import { MixedText } from '../../lib/MixedText';
import { typed } from '../../lib/typedText';
import { channelsApi } from '../channels/api';
import { treeOrder } from '../channels/model';
import { ReasonedButton } from '../channels/ui';
import { IsolatedList } from '../library/labels';
import { lecturesApi } from '../lectures/api';
import { ScopeBar, useAdminScope, useAdminViewer } from './viewer';

const DATED: ReadonlySet<ChannelKind> = new Set(['academic_year', 'course']);

type Editing =
  | { mode: 'create'; parent: ChannelNodeView | null }
  | { mode: 'edit'; node: ChannelNodeView }
  | { mode: 'move'; node: ChannelNodeView }
  | { mode: 'skeleton'; node: ChannelNodeView }
  | null;

/** The study templates (the personal library's), loaded when `enabled` first becomes true. */
function useStudyTemplates(enabled: boolean): { templates: StudyTemplate[] | null; error: string | null } {
  const [templates, setTemplates] = useState<StudyTemplate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled || templates) return;
    let live = true;
    api
      .get<TemplatesResponse>('/library/templates', { timeoutMs: 20_000 })
      .then((r) => {
        if (live) setTemplates(r.templates);
      })
      .catch((e: unknown) => {
        if (live) setError(errorMessage(e));
      });
    return () => {
      live = false;
    };
  }, [enabled, templates]);
  return { templates, error };
}

/** The drafts a template creates, each title isolated (AC-20). */
function SkeletonPreview({ template }: { template: StudyTemplate }) {
  const titles = templateLectureTitles(template);
  return (
    <p className="ml-group-footer">
      {template.description_ar} مسودات المحاضرات التي تُنشأ ({titles.length}): <IsolatedList parts={titles.map((t) => <MixedText key={t} text={t} />)} />. لا يراها الطلاب حتى يُرفع ملفها ويُنشر.
    </p>
  );
}

const lecturesMadeAr = (n: number) =>
  n === 0 ? 'لا مسودات جديدة: كل عناوين القالب موجودة في المادة.' : n === 1 ? 'أُضيفت مسودة محاضرة واحدة.' : n === 2 ? 'أُضيفت مسودتا محاضرتين.' : n <= 10 ? `أُضيفت ${n} مسودات محاضرات.` : `أُضيفت ${n} مسودة محاضرة.`;

export function TreeSection() {
  const v = useAdminViewer();
  const toast = useToast();
  const scope = useAdminScope(['admin']);
  const [editing, setEditing] = useState<Editing>(null);
  const [archiving, setArchiving] = useState<{ node: ChannelNodeView; preview: ChannelArchivePreview | null } | null>(null);
  const offline = v.cachedAt !== null;

  // the scope node and everything below it, in tree order
  const scopeId = scope.current?.node.id ?? null;
  const rows = useMemo(() => {
    if (!scopeId) return [];
    const all = treeOrder(v.nodes);
    const start = all.findIndex((x) => x.node.id === scopeId);
    if (start < 0) return [];
    const base = all[start]!.depth;
    const out = [all[start]!];
    for (let i = start + 1; i < all.length && all[i]!.depth > base; i++) out.push(all[i]!);
    return out.map((x) => ({ ...x, depth: x.depth - base }));
  }, [v.nodes, scopeId]);

  const openArchive = async (node: ChannelNodeView) => {
    setArchiving({ node, preview: null });
    try {
      const r = await channelsApi.archive(node.id, true);
      setArchiving({ node, preview: r.preview });
    } catch (e) {
      setArchiving(null);
      toast.show({ title: errorMessage(e), tone: 'danger' });
    }
  };

  return (
    <div className="ml-page ml-page--narrow ad-section">
      <h1 className="ml-page__title">الشجرة</h1>
      <ScopeBar scope={scope} />
      {v.isPlatformAdmin && (
        <div className="ad-actions">
          <ReasonedButton icon={<Plus size={18} />} reason={offline ? 'يحتاج اتصالًا بالإنترنت.' : null} onClick={() => setEditing({ mode: 'create', parent: null })}>
            أضف جامعة
          </ReasonedButton>
        </div>
      )}
      {rows.length === 0 ? (
        <EmptyState icon={<FolderTree size={28} />} title="لا توجد عقد في نطاقك" description={v.isPlatformAdmin ? 'ابدأ بإضافة جامعة.' : 'تظهر هنا العقد التي أنت مديرها وما تحتها.'} />
      ) : (
        <ul role="list" className="ml-list ad-tree">
          {rows.map(({ node, depth }) => (
            <li key={node.id} className="ml-list__row ad-tree__row" style={{ paddingInlineStart: `calc(var(--ml-space-4) + ${depth} * var(--ml-space-5))` }}>
              <div className="ad-tree__text">
                <span className="ad-tree__title">
                  <MixedText text={node.title} />
                </span>
                <span className="ad-tree__meta">
                  <span>{CHANNEL_KIND_LABELS_AR[node.kind]}</span>
                  {node.kind === 'subject' && <span>{JOIN_POLICY_LABELS_AR[node.join_policy]}</span>}
                  {node.status === 'archived' && <StatusPill tone="warning">مؤرشفة</StatusPill>}
                </span>
              </div>
              {node.status === 'active' && !offline && (
                <div className="ad-tree__actions">
                  {node.kind !== 'subject' && <IconButton label={`أضف تحت ${node.title}`} icon={<Plus size={18} />} onClick={() => setEditing({ mode: 'create', parent: node })} />}
                  {node.kind === 'subject' && node.space_id && (
                    <IconButton label={`مسودات محاضرات من قالب لـ ${node.title}`} icon={<LayoutTemplate size={18} />} onClick={() => setEditing({ mode: 'skeleton', node })} />
                  )}
                  <IconButton label={`عدّل ${node.title}`} icon={<Pencil size={18} />} onClick={() => setEditing({ mode: 'edit', node })} />
                  {node.parent_id !== null && <IconButton label={`انقل ${node.title}`} icon={<MoveRight size={18} />} onClick={() => setEditing({ mode: 'move', node })} />}
                  <IconButton label={`أرشف ${node.title}`} icon={<Archive size={18} />} onClick={() => void openArchive(node)} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="ml-group-footer">المستويات تنزل من الجامعة إلى المادة ويمكن تخطي مستوى. لكل مادة مساحتها المشتركة الخاصة. الأرشفة لا تحذف شيئًا.</p>

      {editing?.mode === 'create' && (
        <NodeDialog
          parent={editing.parent}
          onClose={() => setEditing(null)}
          onDone={(created, note) => {
            setEditing(null);
            toast.show({ title: `أُنشئت «${created.title}».${note ? ` ${note}` : ''}`, tone: 'success' });
            // a new university is a new scope of its own: show it (it would otherwise sit in another scope, unseen)
            if (created.parent_id === null) scope.choose(created.id);
            v.reload();
          }}
        />
      )}
      {editing?.mode === 'edit' && (
        <EditDialog
          node={editing.node}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            toast.show({ title: 'حُفظت التعديلات.', tone: 'success' });
            v.reload();
          }}
        />
      )}
      {editing?.mode === 'skeleton' && (
        <SkeletonDialog
          node={editing.node}
          onClose={() => setEditing(null)}
          onDone={(note) => {
            setEditing(null);
            toast.show({ title: note, tone: 'success' });
          }}
        />
      )}
      {editing?.mode === 'move' && (
        <MoveDialog
          node={editing.node}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            toast.show({ title: 'نُقلت العقدة.', tone: 'success' });
            v.reload();
          }}
        />
      )}
      <ConfirmDialog
        open={archiving !== null}
        title={`أرشفة «${archiving?.node.title ?? ''}»`}
        impact={
          archiving?.preview
            ? `ستُؤرشف معها ${archiving.preview.descendants} عقدة تحتها، و${archiving.preview.memberships} عضوية تتوقف عن منح الوصول، و${archiving.preview.spaces} مساحة مادة تصبح للقراءة فقط، ويُلغى ${archiving.preview.open_codes} رمزًا مفتوحًا. لا يُحذف شيء، وتبقى ملاحظات الطلاب في مكتباتهم.`
            : 'جارٍ حساب الأثر…'
        }
        confirmLabel="أرشف"
        destructive
        onCancel={() => setArchiving(null)}
        onConfirm={async () => {
          if (!archiving?.preview) return;
          await channelsApi.archive(archiving.node.id, false);
          setArchiving(null);
          toast.show({ title: 'أُرشفت.', tone: 'success' });
          v.reload();
        }}
      />
    </div>
  );
}

function NodeDialog({ parent, onClose, onDone }: { parent: ChannelNodeView | null; onClose: () => void; onDone: (created: ChannelNodeView, note?: string) => void }) {
  const kinds = CHANNEL_KINDS.filter((k) => (parent ? isDescendingKind(parent.kind, k) : k === 'university'));
  const [kind, setKind] = useState<ChannelKind>(kinds[0]!);
  const [title, setTitle] = useState('');
  const [titleEn, setTitleEn] = useState('');
  const [policy, setPolicy] = useState<JoinPolicy>('approval');
  const [startsOn, setStartsOn] = useState('');
  const [endsOn, setEndsOn] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [templateKey, setTemplateKey] = useState('');
  const study = useStudyTemplates(kind === 'subject');
  const template = kind === 'subject' ? (study.templates?.find((t) => t.key === templateKey) ?? null) : null;
  // choosing a template fills the names the person has not typed themselves (what the previous template filled is replaced)
  const chooseTemplate = (key: string) => {
    const prev = study.templates?.find((t) => t.key === templateKey) ?? null;
    const next = study.templates?.find((t) => t.key === key) ?? null;
    setTemplateKey(key);
    if (next && (!title.trim() || title === prev?.title_ar)) setTitle(next.title_ar);
    if (next && (!titleEn.trim() || titleEn === prev?.title_en)) setTitleEn(next.title_en);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      setErrors({ title: 'اكتب اسم العقدة.' });
      return;
    }
    setBusy(true);
    setError(null);
    const body: CreateChannelNodeRequest = { parent_id: parent?.id ?? null, kind, title: title.trim(), join_policy: policy };
    if (titleEn.trim()) body.title_en = titleEn.trim();
    if (DATED.has(kind) && startsOn) body.starts_on = startsOn;
    if (DATED.has(kind) && endsOn) body.ends_on = endsOn;
    if (kind === 'subject') body.create_space = true;
    if (template) body.template_key = template.key;
    try {
      const created = await channelsApi.createNode(body);
      if (!template || !created.space_id) return onDone(created);
      // the subject exists now; its lecture skeleton goes into its space (a failure keeps the subject and says why)
      try {
        const made = await lecturesApi.fromTemplate(created.space_id, template.key);
        onDone(created, lecturesMadeAr(made.created.length));
      } catch (err) {
        onDone(created, `لم تُنشأ مسودات المحاضرات: ${errorMessage(err)} أنشئها من زر «مسودات محاضرات من قالب» في صف المادة.`);
      }
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={parent ? `عقدة جديدة تحت ${parent.title}` : 'جامعة جديدة'}
      footer={
        <>
          <Button onClick={onClose}>إلغاء</Button>
          <Button type="submit" form="ad-node-form" variant="primary" loading={busy}>
            أنشئ
          </Button>
        </>
      }
    >
      <form id="ad-node-form" className="ml-stack" onSubmit={(e) => void submit(e)}>
        <Select label="النوع" value={kind} onValueChange={(k) => setKind(k)} options={kinds.map((k) => ({ value: k, label: CHANNEL_KIND_LABELS_AR[k] }))} />
        <TextField label="الاسم" value={title} onChange={typed(setTitle)} error={errors.title} maxLength={120} />
        <TextField label="الاسم الإنجليزي (اختياري)" dir="ltr" value={titleEn} onChange={typed(setTitleEn)} error={errors.title_en} maxLength={120} />
        <Select label="طريقة الانضمام" value={policy} onValueChange={(p) => setPolicy(p)} options={JOIN_POLICIES.map((p) => ({ value: p, label: JOIN_POLICY_LABELS_AR[p] }))} />
        {DATED.has(kind) && (
          <div className="ad-two">
            <TextField label="يبدأ في" type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} error={errors.starts_on} />
            <TextField label="ينتهي في" type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} error={errors.ends_on} />
          </div>
        )}
        {kind === 'subject' && study.templates && (
          <Select
            label="قالب الدراسة (اختياري)"
            value={templateKey}
            onValueChange={chooseTemplate}
            options={[{ value: '', label: 'بلا قالب' }, ...study.templates.map((t) => ({ value: t.key, label: t.title_ar }))]}
          />
        )}
        {kind === 'subject' && study.error && <p className="ml-field__error">تعذّر تحميل قوالب الدراسة: {study.error}</p>}
        {template && <SkeletonPreview template={template} />}
        {kind === 'subject' && <p className="ml-group-footer">تُنشأ للمادة مساحتها المشتركة الخاصة (المحاضرات الرسمية وملفاتها).</p>}
        {error && <p className="ml-field__error">{error}</p>}
      </form>
    </Dialog>
  );
}

/** (AOS-2.3 / 18.3) an existing subject's lecture skeleton from a template (titles it already has are kept as they are). */
function SkeletonDialog({ node, onClose, onDone }: { node: ChannelNodeView; onClose: () => void; onDone: (note: string) => void }) {
  const study = useStudyTemplates(true);
  const [templateKey, setTemplateKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const template = study.templates?.find((t) => t.key === templateKey) ?? null;
  return (
    <Dialog
      open
      onClose={onClose}
      title={`مسودات محاضرات من قالب — ${node.title}`}
      description="مسودة فارغة لكل موضوع في القالب، بترتيبه. العناوين الموجودة في المادة لا تتكرر. ينشئها مشرف المادة أو مدير فوقها."
      footer={
        <>
          <Button onClick={onClose}>إلغاء</Button>
          <ReasonedButton
            variant="primary"
            loading={busy}
            reason={!template ? 'اختر قالبًا أولًا.' : null}
            onClick={async () => {
              if (!template || !node.space_id) return;
              setBusy(true);
              setError(null);
              try {
                const made = await lecturesApi.fromTemplate(node.space_id, template.key);
                onDone(lecturesMadeAr(made.created.length));
              } catch (err) {
                setError(errorMessage(err));
                setBusy(false);
              }
            }}
          >
            أنشئ المسودات
          </ReasonedButton>
        </>
      }
    >
      {study.templates ? (
        <Select label="قالب الدراسة" value={templateKey} onValueChange={setTemplateKey} options={[{ value: '', label: 'اختر قالبًا' }, ...study.templates.map((t) => ({ value: t.key, label: t.title_ar }))]} />
      ) : study.error ? (
        <p className="ml-field__error">تعذّر تحميل قوالب الدراسة: {study.error}</p>
      ) : (
        <p>جارٍ تحميل القوالب…</p>
      )}
      {template && <SkeletonPreview template={template} />}
      {error && <p className="ml-field__error">{error}</p>}
    </Dialog>
  );
}

function EditDialog({ node, onClose, onDone }: { node: ChannelNodeView; onClose: () => void; onDone: () => void }) {
  const [title, setTitle] = useState(node.title);
  const [titleEn, setTitleEn] = useState(node.title_en ?? '');
  const [policy, setPolicy] = useState<JoinPolicy>(node.join_policy);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body: PatchChannelNodeRequest = {};
    if (title.trim() !== node.title) body.title = title.trim();
    if ((titleEn.trim() || null) !== node.title_en) body.title_en = titleEn.trim() || null;
    if (policy !== node.join_policy) body.join_policy = policy;
    if (Object.keys(body).length === 0) return onClose();
    setBusy(true);
    try {
      await channelsApi.patchNode(node.id, body);
      onDone();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`تعديل «${node.title}»`}
      footer={
        <>
          <Button onClick={onClose}>إلغاء</Button>
          <Button type="submit" form="ad-edit-form" variant="primary" loading={busy}>
            احفظ
          </Button>
        </>
      }
    >
      <form id="ad-edit-form" className="ml-stack" onSubmit={(e) => void submit(e)}>
        <TextField label="الاسم" value={title} onChange={typed(setTitle)} maxLength={120} />
        <TextField label="الاسم الإنجليزي (اختياري)" dir="ltr" value={titleEn} onChange={typed(setTitleEn)} maxLength={120} />
        <Select label="طريقة الانضمام" value={policy} onValueChange={(p) => setPolicy(p)} options={JOIN_POLICIES.map((p) => ({ value: p, label: JOIN_POLICY_LABELS_AR[p] }))} />
        {error && <p className="ml-field__error">{error}</p>}
      </form>
    </Dialog>
  );
}

function MoveDialog({ node, onClose, onDone }: { node: ChannelNodeView; onClose: () => void; onDone: () => void }) {
  const v = useAdminViewer();
  // places the viewer administers, of a higher kind, not inside the node itself
  const inside = useMemo(() => {
    const ids = new Set([node.id]);
    for (const x of treeOrder(v.nodes)) if (x.node.parent_id && ids.has(x.node.parent_id)) ids.add(x.node.id);
    return ids;
  }, [v.nodes, node.id]);
  const targets = treeOrder(v.nodes).filter(
    ({ node: t }) => !inside.has(t.id) && t.id !== node.parent_id && t.status === 'active' && isDescendingKind(t.kind, node.kind) && (v.isPlatformAdmin || t.viewer.roles.includes('admin')),
  );
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`نقل «${node.title}»`}
      description="تنتقل العقدة بكل ما تحتها. يلزم أن تكون مديرًا لمكانها الحالي وللوجهة."
      footer={
        <>
          <Button onClick={onClose}>إلغاء</Button>
          <ReasonedButton
            variant="primary"
            loading={busy}
            reason={targets.length === 0 ? 'لا توجد وجهة متاحة.' : !target ? 'اختر الوجهة أولًا.' : null}
            onClick={async () => {
              setBusy(true);
              try {
                await channelsApi.patchNode(node.id, { parent_id: target });
                onDone();
              } catch (err) {
                setError(errorMessage(err));
                setBusy(false);
              }
            }}
          >
            انقل
          </ReasonedButton>
        </>
      }
    >
      {targets.length === 0 ? (
        <p>لا توجد وجهة تديرها يمكن نقل هذه العقدة إليها.</p>
      ) : (
        <Select
          label="الوجهة"
          value={target}
          onValueChange={setTarget}
          options={[{ value: '', label: 'اختر الوجهة' }, ...targets.map(({ node: t, depth }) => ({ value: t.id, label: `${'— '.repeat(depth)}${t.title} (${CHANNEL_KIND_LABELS_AR[t.kind]})` }))]}
        />
      )}
      {error && <p className="ml-field__error">{error}</p>}
    </Dialog>
  );
}

export const Component = TreeSection;
