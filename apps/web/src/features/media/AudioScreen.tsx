// /media/audio/:audioId — a lecture recording with its transcript (§29).
//  * the player streams the original recording (owner session, Range); a segment's time plays that moment
//  * segments are typed by the owner (start = the player's current time) or imported from a WebVTT / SRT file; the
//    original text is kept and corrections are saved beside it with their history; deletions can be restored
//  * a segment can be linked to a page of a source (MANUAL link — automatic linking is not built and nothing is
//    invented); links say whether they are manual or automatic
//  * automatic transcription is not available (reason shown); recording happens in the study workspace on an explicit
//    action (track F4) — never here, the microphone never starts on this screen
//  * (track F4) a recording made in the app lists the pen strokes written meanwhile (time links, «تلقائي» / «يدوي»):
//    «استمع» plays that moment, «افتح الصفحة» opens the page
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { FileUp, History, Link2, Mic, Play, Plus, RotateCcw, Search, Trash2 } from 'lucide-react';
import type { MediaStatusResponse, RecordingView, SegmentRevisionView, SourcePageView, TranscriptResponse, TranscriptSegmentView } from '@medlevo/shared';
import { AUDIO_LINK_ORIGIN_LABELS_AR } from '@medlevo/shared';
import { pageDisplayLabel } from '@medlevo/shared';
import { Breadcrumbs, Button, Checkbox, Dialog, ErrorState, IconButton, LoadingState, Select, StatusPill, TextArea, TextField } from '../../design';
import { errorMessage } from '../../lib/api';
import { formatDateTime } from '../../lib/time';
import { usePageTitle } from '../../lib/usePageTitle';
import { BidiText } from '../evidence';
import { useLibrary } from '../library/useLibrary';
import { mediaApi } from './api';
import { filterSegments, formatMs, formatMsPrecise, parseTimecode, studyUrl } from './model';
import './media.css';

function LinkDialog({ segment, open, onClose, onLinked }: { segment: TranscriptSegmentView; open: boolean; onClose: () => void; onLinked: () => void }) {
  const lib = useLibrary();
  const sources = useMemo(() => (lib.data?.sources ?? []).filter((s) => !s.deleted_at && s.format !== 'audio' && s.active_version_id), [lib.data]);
  const [sourceId, setSourceId] = useState('');
  const [pages, setPages] = useState<SourcePageView[] | null>(null);
  const [pageId, setPageId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setPages(null);
    setPageId('');
    const s = sources.find((x) => x.id === sourceId);
    if (!s?.active_version_id) return;
    void mediaApi
      .pages(s.id, s.active_version_id)
      .then((r) => setPages(r.pages))
      .catch((e) => setError(errorMessage(e, 'تعذّر تحميل الصفحات.')));
  }, [sourceId, sources]);
  return (
    <Dialog open={open} onClose={onClose} title="اربط المقطع بصفحة" description="ربط يدوي تنشئه أنت؛ يظهر في التفريغ موسومًا «ربط يدوي».">
      <div className="md-form-col">
        <Select label="المصدر" value={sourceId} onValueChange={setSourceId} options={[{ value: '', label: lib.loading && !lib.data ? 'جارٍ التحميل…' : 'اختر مصدرًا' }, ...sources.map((s) => ({ value: s.id, label: s.title }))]} />
        {pages && <Select label="الصفحة" value={pageId} onValueChange={setPageId} options={[{ value: '', label: 'اختر صفحة' }, ...pages.map((p) => ({ value: p.id, label: pageDisplayLabel(p) }))]} />}
        {error && <ErrorState inline message={error} />}
        <Button
          variant="primary"
          icon={<Link2 size={16} />}
          disabled={!pageId}
          loading={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await mediaApi.link(segment.id, { page_id: pageId });
              onLinked();
              onClose();
            } catch (e) {
              setError(errorMessage(e, 'تعذّر إنشاء الرابط.'));
            } finally {
              setBusy(false);
            }
          }}
        >
          اربط
        </Button>
      </div>
    </Dialog>
  );
}

function SegmentRow({ s, onSeek, reload, busySet }: { s: TranscriptSegmentView; onSeek: (ms: number) => void; reload: () => Promise<void>; busySet: (b: boolean) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(s.display_text);
  // the exact times (ms kept): a text correction must never re-time an imported cue by rounding it to seconds
  const [start, setStart] = useState(formatMsPrecise(s.start_ms));
  const [end, setEnd] = useState(formatMsPrecise(s.end_ms));
  const beginEdit = () => {
    setText(s.display_text);
    setStart(formatMsPrecise(s.start_ms));
    setEnd(formatMsPrecise(s.end_ms));
    setError(null);
    setEditing(true);
  };
  const [history, setHistory] = useState<SegmentRevisionView[] | null>(null);
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>, fallback: string) => {
    busySet(true);
    setError(null);
    try {
      await fn();
      await reload();
      return true;
    } catch (e) {
      setError(errorMessage(e, fallback));
      return false;
    } finally {
      busySet(false);
    }
  };
  return (
    <li className={`md-seg${s.deleted ? ' md-seg--deleted' : ''}`}>
      <button type="button" className="md-seg__time" onClick={() => onSeek(s.start_ms)} aria-label={`شغّل من ${formatMs(s.start_ms)}`}>
        <Play size={12} aria-hidden="true" />
        <bdi dir="ltr">{formatMs(s.start_ms)}</bdi>
      </button>
      <div className="md-seg__body">
        {!editing ? (
          <>
            <BidiText className="md-seg__text" text={s.display_text} />
            <p className="md-seg__meta">
              <span>{s.origin_label_ar}</span>
              {s.speaker && <span>المتحدث كما في الملف: <BidiText as="span" text={s.speaker} /></span>}
              {s.corrected_text && <StatusPill tone="info" icon={false}>مصحَّح — الأصل محفوظ</StatusPill>}
              {s.deleted && <StatusPill tone="warning" icon={false}>محذوف</StatusPill>}
            </p>
            {s.corrected_text && (
              <details className="md-seg__orig">
                <summary>النص الأصلي</summary>
                <BidiText text={s.text} />
              </details>
            )}
            {s.links.length > 0 && (
              <ul className="md-links">
                {s.links.map((l) => (
                  <li key={l.id}>
                    {l.source_id ? (
                      <Link to={studyUrl(l.source_id, { versionId: l.version_id, pageId: l.page_id, regionId: l.region_id })}>
                        <BidiText as="span" text={[l.source_title, l.page_label_ar].filter(Boolean).join(' — ')} />
                      </Link>
                    ) : (
                      <span>{l.page_label_ar}</span>
                    )}
                    <StatusPill tone={l.origin === 'auto' ? 'warning' : 'neutral'} icon={false}>
                      {l.origin_label_ar}
                    </StatusPill>
                    {l.origin === 'auto' && !l.confirmed && (
                      <Button size="sm" variant="plain" onClick={() => void act(() => mediaApi.confirmLink(l.id), 'تعذّر تأكيد الرابط.')}>
                        أكّد
                      </Button>
                    )}
                    <IconButton size="sm" label="أزل الرابط" icon={<Trash2 size={14} />} onClick={() => void act(() => mediaApi.unlink(l.id), 'تعذّر إزالة الرابط.')} />
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <form
            className="md-form-col"
            onSubmit={async (e) => {
              e.preventDefault();
              // a time field left as it was is not sent (the stored time stays exactly as imported or typed)
              const st = start.trim() === formatMsPrecise(s.start_ms) ? s.start_ms : parseTimecode(start);
              const en = end.trim() === formatMsPrecise(s.end_ms) ? s.end_ms : parseTimecode(end);
              if (st === null || en === null || en <= st) {
                setError('اكتب التوقيت بصيغة دقائق:ثوانٍ، وتكون النهاية بعد البداية.');
                return;
              }
              const body: { base_rev: number; corrected_text?: string | null; start_ms?: number; end_ms?: number } = { base_rev: s.rev };
              if (text.trim() !== s.display_text) body.corrected_text = text.trim() === s.text ? null : text.trim();
              if (st !== s.start_ms) body.start_ms = st;
              if (en !== s.end_ms) body.end_ms = en;
              if (Object.keys(body).length === 1) {
                setEditing(false);
                return;
              }
              if (await act(() => mediaApi.patchSegment(s.id, body), 'تعذّر حفظ التصحيح.')) setEditing(false);
            }}
          >
            <TextArea label="النص (يُحفظ تصحيحًا بجانب الأصل)" rows={3} value={text} onChange={(e) => setText(e.target.value)} />
            <div className="md-form-row">
              <TextField label="من" dir="ltr" value={start} onChange={(e) => setStart(e.target.value)} />
              <TextField label="إلى" dir="ltr" value={end} onChange={(e) => setEnd(e.target.value)} />
            </div>
            <div className="ml-cluster">
              <Button type="submit" size="sm" variant="primary">
                احفظ
              </Button>
              <Button type="button" size="sm" variant="plain" onClick={() => setEditing(false)}>
                إلغاء
              </Button>
            </div>
          </form>
        )}
        {error && <ErrorState inline message={error} />}
        {history && (
          <ol className="md-history" aria-label="سجل التعديلات">
            {history.map((h) => (
              <li key={`${h.rev}-${h.action}-${h.at}`}>
                <span className="md-muted">
                  {formatDateTime(h.at)} — {h.action_label_ar}:{' '}
                </span>
                <BidiText as="span" text={h.corrected_text ?? h.text} />
              </li>
            ))}
          </ol>
        )}
        {!editing && (
          <div className="ml-cluster md-seg__actions">
            {!s.deleted ? (
              <>
                <Button size="sm" variant="plain" onClick={beginEdit}>
                  صحّح
                </Button>
                <Button size="sm" variant="plain" icon={<Link2 size={14} />} onClick={() => setLinking(true)}>
                  اربط بصفحة
                </Button>
                <IconButton size="sm" label="احذف المقطع (يمكن استعادته)" icon={<Trash2 size={14} />} onClick={() => void act(() => mediaApi.deleteSegment(s.id, s.rev), 'تعذّر الحذف.')} />
              </>
            ) : (
              <Button size="sm" variant="plain" icon={<RotateCcw size={14} />} onClick={() => void act(() => mediaApi.restoreSegment(s.id), 'تعذّرت الاستعادة.')}>
                استعد
              </Button>
            )}
            {s.revisions > 1 && (
              <Button
                size="sm"
                variant="plain"
                icon={<History size={14} />}
                onClick={async () => {
                  if (history) return setHistory(null);
                  try {
                    setHistory((await mediaApi.revisions(s.id)).revisions);
                  } catch (e) {
                    setError(errorMessage(e, 'تعذّر تحميل السجل.'));
                  }
                }}
              >
                {history ? 'أخفِ السجل' : `السجل (${s.revisions})`}
              </Button>
            )}
          </div>
        )}
      </div>
      {linking && <LinkDialog segment={s} open={linking} onClose={() => setLinking(false)} onLinked={() => void reload()} />}
    </li>
  );
}

export function AudioScreen() {
  const { audioId = '' } = useParams();
  const [data, setData] = useState<TranscriptResponse | null>(null);
  const [status, setStatus] = useState<MediaStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [newText, setNewText] = useState('');
  const [newStart, setNewStart] = useState('0:00');
  const [newEnd, setNewEnd] = useState('0:10');
  const [replace, setReplace] = useState(false);
  const [importNote, setImportNote] = useState<string | null>(null);
  const player = useRef<HTMLAudioElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  usePageTitle(data?.audio.source_title ?? 'تسجيل');

  const load = useCallback(async () => {
    try {
      setData(await mediaApi.transcript(audioId, showDeleted));
      setError(null);
    } catch (e) {
      setError(errorMessage(e, 'تعذّر تحميل التسجيل.'));
    }
  }, [audioId, showDeleted]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    void mediaApi
      .status()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);
  // (track F4) strokes written while this recording was made in the app
  const [strokes, setStrokes] = useState<RecordingView['linked_strokes']>([]);
  const audioSourceId = data?.audio.source_id ?? null;
  useEffect(() => {
    setStrokes([]);
    if (!audioSourceId) return;
    let alive = true;
    mediaApi
      .recordings(audioSourceId)
      .then((list) => alive && setStrokes(list.filter((r) => r.source_id === audioSourceId).flatMap((r) => r.linked_strokes)))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [audioSourceId]);

  if (error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!data) return <LoadingState stage="جارٍ تحميل التسجيل…" />;
  const segments = filterSegments(data.segments, query);

  const seek = (ms: number) => {
    const a = player.current;
    if (!a) return;
    a.currentTime = ms / 1000;
    void a.play().catch(() => undefined);
  };
  const useCurrent = () => {
    const t = Math.floor((player.current?.currentTime ?? 0) * 1000);
    setNewStart(formatMs(t));
    setNewEnd(formatMs(t + 10_000));
  };

  return (
    <div className="ml-page md-page">
      <Breadcrumbs items={[{ label: 'الصور والصوت', to: '/media?tab=audio' }, { label: data.audio.source_title }]} />
      <header className="ml-page__header">
        <h1 className="ml-page__title">
          <BidiText as="span" text={data.audio.source_title} />
        </h1>
        <p className="ml-page__lede">{data.audio.source_type === 'my_audio_note' ? 'ملاحظة صوتية' : 'تسجيل محاضرة'} — الأصل محفوظ كما رُفع.</p>
      </header>

      <div className="md-player">
        <audio
          ref={player}
          controls
          preload="metadata"
          src={data.audio.stream_url}
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration;
            if (Number.isFinite(d) && d > 0 && Math.abs((data.audio.duration_ms ?? 0) - d * 1000) > 1000) void mediaApi.reportDuration(audioId, Math.round(d * 1000)).catch(() => undefined);
          }}
        >
          متصفحك لا يشغّل هذا الملف.
        </audio>
        <div className="md-player__caps">
          {status?.recording.state !== 'available' && (
            <Button size="sm" variant="secondary" icon={<Mic size={14} />} disabled aria-describedby="md-rec-why">
              سجّل
            </Button>
          )}
          <p id="md-rec-why" className="md-muted">
            {status?.recording.reason_ar ?? 'التسجيل داخل التطبيق غير متاح.'}
          </p>
          <p className="md-muted">{status?.transcription.reason_ar}</p>
        </div>
      </div>

      {actionError && <ErrorState inline message={actionError} />}

      {strokes.length > 0 && (
        <section className="md-section" aria-labelledby="md-strokes-h">
          <h2 id="md-strokes-h" className="md-section__title">
            ملاحظات القلم أثناء التسجيل
          </h2>
          <ul className="md-links">
            {strokes.map((st) => (
              <li key={st.annotation_id}>
                <Button size="sm" variant="secondary" icon={<Play size={14} />} onClick={() => seek(st.offset_ms)} aria-label={`استمع من ${formatMs(st.offset_ms)}`}>
                  <bdi dir="ltr">{formatMs(st.offset_ms)}</bdi>
                </Button>
                <span>{st.page_label_ar ?? 'صفحة'}</span>
                <StatusPill tone={st.origin === 'auto' ? 'info' : 'accent'}>{st.origin === 'auto' ? 'رابط تلقائي' : 'رابط يدوي'}</StatusPill>
                <span className="md-muted">{AUDIO_LINK_ORIGIN_LABELS_AR[st.origin]}</span>
                {st.source_id && (
                  <Link to={studyUrl(st.source_id, { pageId: st.page_id })}>
                    افتح الصفحة
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="md-section" aria-labelledby="md-tr-h">
        <div className="md-head">
          <h2 id="md-tr-h" className="md-section__title">
            التفريغ
          </h2>
          <div className="md-form-row">
            <TextField label="ابحث في التفريغ" value={query} onChange={(e) => setQuery(e.target.value)} endAdornment={<Search size={16} aria-hidden="true" />} />
            <Checkbox checked={showDeleted} onCheckedChange={setShowDeleted} label="أظهر المحذوف" />
          </div>
        </div>
        {data.notes_ar.map((n) => (
          <p key={n} className="md-muted">
            {n}
          </p>
        ))}
        {data.segments.length === 0 ? (
          <p className="md-muted">لا مقاطع بعد. اكتب أول مقطع أدناه أو استورد ملف ترجمة.</p>
        ) : segments.length === 0 ? (
          <p className="md-muted">لا مقاطع تطابق البحث.</p>
        ) : (
          <ol className="md-segments">
            {segments.map((s) => (
              <SegmentRow key={s.id} s={s} onSeek={seek} reload={load} busySet={setBusy} />
            ))}
          </ol>
        )}
      </section>

      <section className="md-section" aria-labelledby="md-add-h">
        <h2 id="md-add-h" className="md-section__title">
          <Plus size={18} aria-hidden="true" /> أضف مقطعًا
        </h2>
        <form
          className="md-form-col"
          onSubmit={async (e) => {
            e.preventDefault();
            const st = parseTimecode(newStart);
            const en = parseTimecode(newEnd);
            if (st === null || en === null || en <= st) {
              setActionError('اكتب التوقيت بصيغة دقائق:ثوانٍ، وتكون النهاية بعد البداية.');
              return;
            }
            setBusy(true);
            setActionError(null);
            try {
              await mediaApi.addSegment(audioId, { start_ms: st, end_ms: en, text: newText.trim() });
              setNewText('');
              setNewStart(formatMs(en));
              setNewEnd(formatMs(en + 10_000));
              await load();
            } catch (err) {
              setActionError(errorMessage(err, 'تعذّر حفظ المقطع.'));
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="md-form-row">
            <TextField label="من" dir="ltr" value={newStart} onChange={(e) => setNewStart(e.target.value)} />
            <TextField label="إلى" dir="ltr" value={newEnd} onChange={(e) => setNewEnd(e.target.value)} />
            <Button type="button" variant="plain" onClick={useCurrent}>
              من موضع التشغيل الحالي
            </Button>
          </div>
          <TextArea label="النص كما سمعته" rows={3} value={newText} onChange={(e) => setNewText(e.target.value)} hint="لا تخمّن كلمة غير مسموعة؛ اكتب [غير مسموع] مكانها." />
          <Button type="submit" variant="primary" loading={busy} disabled={!newText.trim()}>
            احفظ المقطع
          </Button>
        </form>
      </section>

      <section className="md-section" aria-labelledby="md-imp-h">
        <h2 id="md-imp-h" className="md-section__title">
          <FileUp size={18} aria-hidden="true" /> استورد ملف ترجمة (VTT / SRT)
        </h2>
        <Checkbox checked={replace} onCheckedChange={setReplace} label="استبدل الاستيراد السابق" description="تُحذف (ويمكن استعادتها) المقاطع المستوردة التي لم تصحّحها أو تربطها فقط؛ تصحيحاتك ومقاطعك اليدوية تبقى." />
        <input
          ref={fileInput}
          type="file"
          accept=".vtt,.srt,text/vtt,application/x-subrip,text/plain"
          className="ml-visually-hidden"
          aria-label="اختر ملف VTT أو SRT"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            if (f.size > 2_000_000) {
              setActionError('الملف أكبر من 2 MB.');
              return;
            }
            setBusy(true);
            setActionError(null);
            setImportNote(null);
            try {
              const text = await f.text();
              const r = await mediaApi.importSubtitles(audioId, { text, file_name: f.name, replace_previous_import: replace });
              setImportNote(
                `استُورد ${r.created} مقطعًا من ${r.format.toUpperCase()}${r.skipped.length ? `، وتُرك ${r.skipped.length} غير صالح (${r.skipped.slice(0, 3).map((s) => `#${s.cue}: ${s.reason_ar}`).join(' ')})` : ''}${r.replaced ? `، واستُبدل ${r.replaced}` : ''}${r.kept_corrected ? `، وبقي ${r.kept_corrected} مما صحّحته أو ربطته` : ''}.`,
              );
              await load();
            } catch (err) {
              setActionError(errorMessage(err, 'تعذّر الاستيراد.'));
            } finally {
              setBusy(false);
            }
          }}
        />
        <Button variant="secondary" icon={<FileUp size={16} />} loading={busy} onClick={() => fileInput.current?.click()}>
          اختر ملفًا
        </Button>
        {importNote && (
          <p className="md-muted" role="status">
            {importNote}
          </p>
        )}
        {data.imports.length > 0 && (
          <ul className="md-list">
            {data.imports.map((i) => (
              <li key={i.id} className="md-muted">
                {formatDateTime(i.created_at)} — {i.format.toUpperCase()} {i.file_name ? <BidiText as="span" text={i.file_name} /> : null}: {i.created} مقطعًا{i.skipped ? `، ${i.skipped} غير صالح` : ''}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
