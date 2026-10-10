// The reader's side of track F4: provides the lasso actions «تحويل إلى نص» / «اسأل عن المحدد» (handwriting
// recognition + the contextual chat) and the recording features (start from the «المزيد» menu, the indicator, playing
// a stroke's moment, editing its time link) to the ink engine through InkSelectionActionsProvider.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Mic } from 'lucide-react';
import type { AnnotationAnchor, InkAudioLink } from '@medlevo/shared';
import { MenuItem } from '../../../design';
import { useCapabilities } from '../../../lib/capabilities';
import { getSyncEngine } from '../../../lib/sync';
import { InkSelectionActionsProvider, type InkSelectionActions, type InkSelectionInfo } from '../ink/selectionActions';
import { useInkInternal } from '../ink/InkProvider';
import { audioLinkOf, withAudioLink } from '../ink/audioLink';
import type { InkItem } from '../ink/model';
import { aiRequestStore } from '../model/aiActions';
import { AudioLinkDialog, DeviceRecordingsNotice, getRecorder, RecordingBar, RecordingPlayer, useRecorderState, type PlayRequest } from '../audio/AudioUi';
import { recordingSupport, type RecorderController } from '../audio/recorder';
import { RecognitionDialog, writingIds, type AskHandoff, type RecognitionDialogDeps, type RecognitionTarget } from './RecognitionDialog';

interface HostCtx {
  recorder: RecorderController;
  startRecording: () => void;
  supportReason: string | null;
}
const Ctx = createContext<HostCtx | null>(null);

export const NOTE_PAGE_ASK_AR = 'السؤال عن المحدد يعمل بجانب فقرات المحاضرة؛ هذه صفحة ملاحظات.';

export function HandwritingHost({
  sourceId,
  nodeId,
  online,
  children,
  recorder: recorderProp,
  dialogDeps,
}: {
  sourceId: string;
  nodeId: string | null;
  online: boolean;
  children: ReactNode;
  recorder?: RecorderController;
  dialogDeps?: RecognitionDialogDeps;
}) {
  const caps = useCapabilities();
  const recognition = caps.feature('workspace.handwriting_recognition');
  const chat = caps.feature('ai.chat');
  const { store, announce } = useInkInternal();
  const recorder = useMemo(() => recorderProp ?? getRecorder(), [recorderProp]);
  const [target, setTarget] = useState<RecognitionTarget | null>(null);
  const [play, setPlay] = useState<PlayRequest | null>(null);
  const [linkEdit, setLinkEdit] = useState<{ item: InkItem; targetKey: string } | null>(null);
  const support = useMemo(() => recordingSupport(), []);

  const open = useCallback((mode: 'convert' | 'ask', sel: InkSelectionInfo) => {
    if (!sel.anchor) return;
    setTarget({ mode, targetKey: sel.targetKey, anchor: sel.anchor as AnnotationAnchor, items: sel.items, bbox: sel.bbox, ar: sel.ar });
  }, []);

  const actions = useMemo<InkSelectionActions>(
    () => ({
      convert: {
        reason: !recognition.available ? (recognition.reason ?? 'قراءة الخط غير متاحة الآن.') : !online ? 'قراءة الخط تحتاج اتصالًا بالخادم.' : null,
        run: (sel) => open('convert', sel),
      },
      ask: {
        reason: !online ? 'السؤال يحتاج اتصالًا بالخادم.' : null,
        // on a note page the dialog says why (no paragraph to ask about) instead of doing nothing
        run: (sel) => open('ask', sel),
      },
      playAudio: (link) => setPlay((p) => ({ link, nonce: (p?.nonce ?? 0) + 1 })),
      editAudioLink: (item, targetKey) => setLinkEdit({ item, targetKey }),
    }),
    [recognition.available, recognition.reason, online, open],
  );

  const onAsk = useCallback((h: AskHandoff) => {
    aiRequestStore.request({
      action: 'ask',
      anchor: { source_id: h.anchor.source_id, version_id: h.anchor.version_id, page_id: h.anchor.page_id, region_ids: h.anchor.region_ids, quote: h.anchor.quote },
      text: h.text,
      pageIndex: h.pageIndex,
      rects: [],
      prefill: h.question,
    });
  }, []);

  const saveLink = (offsetMs: number | null) => {
    if (!linkEdit) return;
    const before = store.page(linkEdit.targetKey)?.items.get(linkEdit.item.id) ?? linkEdit.item;
    const link = audioLinkOf(before);
    if (!link) return setLinkEdit(null);
    const after: InkItem = withAudioLink(before, offsetMs === null ? null : { recording_id: link.recording_id, offset_ms: offsetMs, origin: 'manual' }, Date.now());
    store.commit(offsetMs === null ? 'إزالة الرابط الزمني' : 'تعديل الرابط الزمني', [{ id: before.id, targetKey: linkEdit.targetKey, before, after }]);
    announce(offsetMs === null ? 'أُزيل الرابط الزمني؛ الكتابة باقية.' : 'عُدّل الرابط الزمني ووُسم «يدوي».');
    setLinkEdit(null);
  };

  // leaving the reader stops and saves a running recording (it never runs on without its indicator)
  useEffect(() => () => void recorder.abandon(), [recorder]);

  const startRecording = useCallback(() => {
    void recorder.start({ linkedSourceId: sourceId, nodeId });
  }, [recorder, sourceId, nodeId]);

  const ctx = useMemo<HostCtx>(() => ({ recorder, startRecording, supportReason: support.reason }), [recorder, startRecording, support.reason]);
  const editing = linkEdit ? audioLinkOf(linkEdit.item) : null;

  return (
    <Ctx.Provider value={ctx}>
      <InkSelectionActionsProvider value={actions}>
        {children}
        <RecognitionDialog
          target={target}
          onClose={() => setTarget(null)}
          recognition={{ available: recognition.available, reason: recognition.reason }}
          chat={{ available: chat.available, reason: chat.reason }}
          online={online}
          onAsk={onAsk}
          deps={{ syncNow: () => getSyncEngine().syncNow(), ...dialogDeps }}
        />
        <div className="hw-dock">
          <RecordingPlayer request={play} onClose={() => setPlay(null)} />
          <DeviceRecordingsNotice />
          <RecordingBar recorder={recorder} />
        </div>
        <AudioLinkDialog link={editing as InkAudioLink | null} open={!!linkEdit} onClose={() => setLinkEdit(null)} onSave={(ms) => saveLink(ms)} onRemove={() => saveLink(null)} />
      </InkSelectionActionsProvider>
    </Ctx.Provider>
  );
}

/** «سجّل ملاحظة صوتية» for the reader's «المزيد» menu: only an explicit click ever starts the microphone. */
export function RecordMenuItem() {
  const ctx = useContext(Ctx);
  const state = useRecorderState(ctx?.recorder ?? getRecorder());
  if (!ctx) return null;
  const busy = state.kind === 'recording' || state.kind === 'requesting' || state.kind === 'saving';
  const unsaved = state.kind === 'error' && state.code === 'save_failed' && !!ctx.recorder.unsaved();
  const reason =
    ctx.supportReason ??
    (busy ? 'يجري تسجيل الآن؛ أوقفه من شريط التسجيل أسفل الشاشة.' : unsaved ? 'التسجيل السابق لم يُحفظ بعد: احفظه أو نزّل نسخة منه من شريط التسجيل أولًا.' : null);
  return (
    <MenuItem icon={<Mic size={16} />} disabled={!!reason} disabledReason={reason ?? undefined} onSelect={ctx.startRecording}>
      سجّل ملاحظة صوتية…
    </MenuItem>
  );
}

export { writingIds };
