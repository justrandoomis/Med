// /media — the images and recordings of the owner's sources (§29, §32).
//  * الصور: every extracted image with its caption, page and ORIGIN BADGE (photo from a source / educational drawing /
//    re-organized diagram / generated illustration — never confused), filtered by the kinds that actually exist; a
//    «find an example» search that runs the AC-09 gate over the library (mismatches excluded with reasons); external
//    image search is unavailable and says why.
//  * التسجيلات: lecture recordings and audio notes, with what works (playback, manual transcript, subtitle import,
//    manual links) and what does not (automatic transcription, in-app recording — the microphone never starts).
import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AudioLines, Images, Mic, Search } from 'lucide-react';
import {
  AGE_GROUPS,
  AGE_GROUP_LABELS_AR,
  type AgeGroup,
  type AudioListResponse,
  type ImageListResponse,
  type ImageMatchResponse,
  type ImageSummaryView,
  type MediaStatusResponse,
} from '@medlevo/shared';
import { Button, EmptyState, ErrorState, ListItem, LoadingState, Select, StatusPill, Tab, TabList, TabPanel, Tabs, TextField, buttonClass } from '../../design';
import { errorMessage } from '../../lib/api';
import { formatDateTime } from '../../lib/time';
import { usePageTitle } from '../../lib/usePageTitle';
import { BidiText } from '../evidence';
import { mediaApi } from './api';
import { formatMs, ORIGIN_TONE } from './model';
import './media.css';

export function ImageCard({ img }: { img: ImageSummaryView }) {
  return (
    <li className="md-card">
      <Link to={`/media/images/${encodeURIComponent(img.id)}`} className="md-card__link">
        <span className="md-card__frame">{img.file_url ? <img src={img.file_url} alt={img.caption ? `صورة: ${img.caption.slice(0, 120)}` : 'صورة من المصدر بلا تعليق'} loading="lazy" /> : null}</span>
        <span className="md-card__body">
          <StatusPill tone={ORIGIN_TONE[img.origin_badge]} icon={false}>
            {img.origin_label_ar}
          </StatusPill>
          {img.caption ? <BidiText as="span" className="md-card__caption" text={img.caption} /> : <span className="md-muted">بلا تعليق من المصدر</span>}
          <span className="md-muted">
            <BidiText as="span" text={[img.source?.title, img.page?.label_ar].filter(Boolean).join(' — ')} />
          </span>
        </span>
      </Link>
    </li>
  );
}

function MatchPanel({ external }: { external: MediaStatusResponse['external_image_search'] | null }) {
  const [modality, setModality] = useState('');
  const [region, setRegion] = useState('');
  const [finding, setFinding] = useState('');
  const [age, setAge] = useState<AgeGroup | ''>('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<ImageMatchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="md-section" aria-labelledby="md-match-h">
      <h2 id="md-match-h" className="md-section__title">
        <Search size={18} aria-hidden="true" /> ابحث عن مثال مطابق في صورك
      </h2>
      <p className="md-muted">
        تُقبل الصورة فقط إذا طابق نوع التصوير والمنطقة التشريحية، وذكر تعليقها العلامة المطلوبة غير منفية، وطابقت الفئة العمرية إن حددتها. الصور القريبة غير المطابقة تُستبعد مع السبب.
      </p>
      <form
        className="md-form-row"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            setRes(await mediaApi.match({ modality: modality.trim(), anatomic_region: region.trim(), finding_terms: finding.split(/[,،]/).map((x) => x.trim()).filter(Boolean), age_group: age || null }));
          } catch (err) {
            setError(errorMessage(err, 'تعذّر البحث.'));
          } finally {
            setBusy(false);
          }
        }}
      >
        <TextField label="نوع التصوير" placeholder="X-ray / CT / Ultrasound / Histology" value={modality} onChange={(e) => setModality(e.target.value)} required />
        <TextField label="المنطقة التشريحية" placeholder="chest / الصدر" value={region} onChange={(e) => setRegion(e.target.value)} required />
        <TextField label="العلامة المطلوبة (ومرادفاتها)" placeholder="pneumothorax، استرواح الصدر" value={finding} onChange={(e) => setFinding(e.target.value)} required />
        <Select label="الفئة العمرية (إن كانت مهمة)" value={age} onValueChange={(v) => setAge(v as AgeGroup | '')} options={[{ value: '', label: 'غير مهمة' }, ...AGE_GROUPS.map((a) => ({ value: a, label: AGE_GROUP_LABELS_AR[a] }))]} />
        <Button type="submit" variant="secondary" icon={<Search size={16} />} loading={busy} disabled={!modality.trim() || !region.trim() || !finding.trim()}>
          ابحث
        </Button>
      </form>
      {error && <ErrorState inline message={error} />}
      {res && (
        <div className="md-match">
          <p className="md-muted">{res.note_ar}</p>
          {res.accepted.length > 0 && (
            <ul className="md-grid" aria-label="صور مطابقة">
              {res.accepted.map((a) => (
                <ImageCard key={a.image.id} img={a.image} />
              ))}
            </ul>
          )}
          {res.excluded.length > 0 && (
            <details>
              <summary>استُبعدت {res.excluded.length} صورة ولماذا</summary>
              <ul className="md-excluded">
                {res.excluded.map((x) => (
                  <li key={x.image.id}>
                    <Link to={`/media/images/${encodeURIComponent(x.image.id)}`}>
                      <BidiText as="span" text={x.image.caption ?? x.image.title ?? 'صورة بلا تعليق'} />
                    </Link>
                    <ul className="md-list">
                      {x.validation.reasons_ar.map((r) => (
                        <li key={r}>
                          <BidiText as="span" text={r} />
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
      {external && <p className="md-muted">البحث الخارجي: {external.reason_ar}</p>}
    </section>
  );
}

function ImagesTab({ status }: { status: MediaStatusResponse | null }) {
  const [kind, setKind] = useState('');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [data, setData] = useState<ImageListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await mediaApi.images({ kind, q: query }));
    } catch (e) {
      setError(errorMessage(e, 'تعذّر تحميل الصور.'));
    }
  }, [kind, query]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <>
      <form
        className="md-form-row"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(q.trim());
        }}
      >
        <TextField label="ابحث في التعليقات والعناوين" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select
          label="النوع"
          value={kind}
          onValueChange={setKind}
          options={[{ value: '', label: 'كل الأنواع' }, ...(data?.kinds ?? []).map((k) => ({ value: k.kind, label: `${k.label_ar} (${k.count})` }))]}
        />
        <Button type="submit" variant="secondary">
          اعرض
        </Button>
      </form>
      {error && <ErrorState message={error} onRetry={() => void load()} />}
      {!data && !error && <LoadingState stage="جارٍ تحميل الصور…" />}
      {data?.notes_ar.map((n) => (
        <p key={n} className="md-muted">
          {n}
        </p>
      ))}
      {data && data.images.length === 0 && data.kinds.length > 0 && <p className="md-muted">لا صور تطابق هذا البحث.</p>}
      {data && data.images.length > 0 && (
        <ul className="md-grid" aria-label="الصور">
          {data.images.map((img) => (
            <ImageCard key={img.id} img={img} />
          ))}
        </ul>
      )}
      <MatchPanel external={status?.external_image_search ?? null} />
    </>
  );
}

function AudioTab({ status }: { status: MediaStatusResponse | null }) {
  const [data, setData] = useState<AudioListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await mediaApi.audio());
    } catch (e) {
      setError(errorMessage(e, 'تعذّر تحميل التسجيلات.'));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <>
      {error && <ErrorState message={error} onRetry={() => void load()} />}
      {!data && !error && <LoadingState stage="جارٍ تحميل التسجيلات…" />}
      {data && data.audio.length === 0 && (
        <EmptyState
          icon={<AudioLines size={28} />}
          title="لا توجد تسجيلات بعد"
          description="ارفع تسجيل محاضرة أو ملاحظة صوتية (MP3 / M4A / WAV / OGG) من صفحة الرفع، ثم اكتب تفريغه أو استورد ملف ترجمة."
          actions={
            <Link to="/upload" className={buttonClass({ variant: 'primary' })}>
              اذهب إلى الرفع
            </Link>
          }
        />
      )}
      {data && data.audio.length > 0 && (
        <ul className="ml-list" aria-label="التسجيلات">
          {data.audio.map((a) => (
            <ListItem
              key={a.id}
              to={`/media/audio/${encodeURIComponent(a.id)}`}
              leading={<AudioLines size={20} />}
              title={<BidiText as="span" text={a.source_title} />}
              subtitle={
                <>
                  {a.source_type === 'my_audio_note' ? 'ملاحظة صوتية' : 'تسجيل محاضرة'}
                  {a.duration_ms ? ` — ${formatMs(a.duration_ms)}` : ''} — {a.segments ? `${a.segments} مقطعًا في التفريغ` : 'بلا تفريغ بعد'} — {formatDateTime(a.created_at)}
                </>
              }
            />
          ))}
        </ul>
      )}
      {status && (
        <ul className="md-caps" aria-label="ما يعمل في الصوت">
          <li>
            <Mic size={16} aria-hidden="true" /> {status.recording.reason_ar}
          </li>
          <li>{status.transcription.reason_ar}</li>
          <li>{status.auto_linking.reason_ar}</li>
        </ul>
      )}
    </>
  );
}

export function MediaHub() {
  usePageTitle('الصور والصوت');
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'audio' ? 'audio' : 'images';
  const [status, setStatus] = useState<MediaStatusResponse | null>(null);
  useEffect(() => {
    void mediaApi
      .status()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);
  return (
    <div className="ml-page md-page">
      <header className="ml-page__header">
        <h1 className="ml-page__title">الصور والصوت</h1>
        <p className="ml-page__lede">صور مصادرك مع أصلها وتعليقها وصفحتها، واختبار الصور بأقنعة قابلة للإزالة؛ وتسجيلات المحاضرات مع تفريغ تكتبه أو تستورده.</p>
      </header>
      <Tabs value={tab} onValueChange={(v) => setParams(v === 'audio' ? { tab: 'audio' } : {}, { replace: true })}>
        <TabList label="الوسائط">
          <Tab value="images" icon={<Images size={16} />}>
            الصور
          </Tab>
          <Tab value="audio" icon={<AudioLines size={16} />}>
            التسجيلات
          </Tab>
        </TabList>
        <TabPanel value="images">
          <ImagesTab status={status} />
        </TabPanel>
        <TabPanel value="audio">
          <AudioTab status={status} />
        </TabPanel>
      </Tabs>
    </div>
  );
}
