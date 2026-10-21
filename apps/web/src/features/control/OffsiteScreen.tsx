// النسخ الاحتياطي خارج الخادم (PL-0): one calm status row — when the last encrypted copy reached Cloudflare R2, its
// size and result — the «نسخ احتياطي الآن» action (disabled with its reason when R2 is not configured or a run is in
// progress), recent runs, the copies R2 holds, and how to restore from a phone. Restore itself is deliberately not a
// button here: it runs from the Render dashboard's Shell (one command), so a stolen session can never trigger it.
import { useEffect, useState } from 'react';
import { CloudUpload, Copy } from 'lucide-react';
import { Bidi, Button, ErrorState, LoadingState, StatusPill, useToast } from '../../design';
import { errorMessage } from '../../lib/api';
import { formatDateTime } from '../../lib/time';
import { formatBytes } from './model';
import { offsiteApi, offsiteSummaryAr, type OffsiteRunView, type OffsiteStatusResponse, type RemoteBackupView } from './offsite';
import { SectionHeader, useLoad } from './shared';
import './offsite.css';

const TRIGGER_AR = { schedule: 'مجدولة', manual: 'بطلبك' } as const;

function tone(r: OffsiteRunView): 'success' | 'danger' | 'info' {
  return r.status === 'uploaded' ? 'success' : r.status === 'failed' ? 'danger' : 'info';
}

function CopyCommand({ command, label }: { command: string; label: string }) {
  const toast = useToast();
  return (
    <div className="cc-offsite__command">
      <code dir="ltr" className="cc-offsite__code">
        {command}
      </code>
      <Button
        icon={<Copy size={16} aria-hidden="true" />}
        aria-label={`انسخ ${label}`}
        onClick={() => {
          void navigator.clipboard
            ?.writeText(command)
            .then(() => toast.show({ title: 'نُسخ الأمر.', tone: 'success' }))
            .catch(() => toast.show({ title: 'تعذّر النسخ؛ حدّد الأمر وانسخه يدويًا.', tone: 'danger' }));
        }}
      >
        انسخ
      </Button>
    </div>
  );
}

function StatusBlock({ s, onStarted }: { s: OffsiteStatusResponse; onStarted: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const disabledReason = !s.configured ? 'غير متاح: النسخ خارج الخادم غير مُعدّ بعد.' : s.running ? 'هناك نسخ جارٍ الآن؛ انتظر اكتماله.' : null;
  const start = async () => {
    setBusy(true);
    try {
      await offsiteApi.run();
      toast.show({ title: 'بدأ النسخ الاحتياطي: نسخة على الخادم، ثم تجربة استعادتها، ثم تشفيرها ورفعها.', tone: 'success' });
      onStarted();
    } catch (e) {
      toast.show({ title: errorMessage(e), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };
  const ok = s.last_success;
  return (
    <section className="cc-block" aria-labelledby="cc-offsite-h">
      <h2 id="cc-offsite-h" className="cc-block__title">
        الحالة
      </h2>
      <p className="cc-offsite__summary" role="status">
        {offsiteSummaryAr(s, (ms) => formatDateTime(ms))}
      </p>
      {s.problems_ar.length > 0 && (
        <ul className="cc-bullets" aria-label="ما ينقص الإعداد">
          {s.problems_ar.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      )}
      <dl className="cc-facts">
        <div className="cc-facts__row">
          <dt>آخر نسخة ناجحة</dt>
          <dd>
            {ok ? (
              <>
                {formatDateTime(ok.created_at)} — <Bidi dir="ltr">{ok.size !== null ? formatBytes(ok.size) : '—'}</Bidi> مشفّرة
                {ok.parts_resumed ? ` (استُؤنف رفعها بعد ${ok.parts_resumed} جزءًا محفوظًا)` : ''}
              </>
            ) : (
              'لا توجد بعد'
            )}
          </dd>
        </div>
        {s.last && s.last.id !== ok?.id && (
          <div className="cc-facts__row">
            <dt>آخر محاولة</dt>
            <dd>
              <StatusPill tone={tone(s.last)}>{s.last.status_label_ar}</StatusPill> {formatDateTime(s.last.created_at)}
              {s.last.error_ar && <span className="cc-table__note">{s.last.error_ar}</span>}
            </dd>
          </div>
        )}
        <div className="cc-facts__row">
          <dt>الوجهة</dt>
          <dd>{s.target ? <Bidi dir="ltr">{`${s.target.bucket} · ${s.target.endpoint_host} · ${s.target.prefix}backups/`}</Bidi> : 'غير مضبوطة'}</dd>
        </div>
        <div className="cc-facts__row">
          <dt>التشفير</dt>
          <dd>
            {s.encryption ? (
              <>
                على الخادم قبل الرفع (AES-256-GCM)؛ بصمة المفتاح <Bidi dir="ltr">{s.encryption.key_id.slice(0, 12)}</Bidi>
              </>
            ) : (
              'لا مفتاح تشفير صالح'
            )}
          </dd>
        </div>
        <div className="cc-facts__row">
          <dt>الموعد اليومي</dt>
          <dd>
            {s.schedule ? (
              <>
                <Bidi dir="ltr">{s.schedule.time}</Bidi> بتوقيت <Bidi dir="ltr">{s.schedule.timezone}</Bidi>
                {s.schedule.next_run_at ? ` — التالي ${formatDateTime(s.schedule.next_run_at)}` : ''}
              </>
            ) : (
              'متوقف (يدوي فقط)'
            )}
          </dd>
        </div>
        <div className="cc-facts__row">
          <dt>الاحتفاظ</dt>
          <dd>
            في R2: أحدث نسخة من كل يوم لآخر {s.retention.keep_daily} أيام، ومن كل أسبوع لآخر {s.retention.keep_weekly} أسابيع. على قرص الخادم: آخر {s.retention.keep_local} من نسخ هذه العملية.
          </dd>
        </div>
      </dl>
      <div className="cc-offsite__actions">
        <Button
          variant="primary"
          icon={<CloudUpload size={18} aria-hidden="true" />}
          loading={busy || Boolean(s.running)}
          loadingLabel={s.running ? `جارٍ: ${s.running.stage_label_ar ?? ''}` : 'جارٍ البدء…'}
          disabled={Boolean(disabledReason) && !s.running}
          aria-describedby={disabledReason ? 'cc-offsite-why' : undefined}
          onClick={() => void start()}
        >
          نسخ احتياطي الآن
        </Button>
        {disabledReason && (
          <p id="cc-offsite-why" className="cc-muted">
            {disabledReason}
          </p>
        )}
      </div>
    </section>
  );
}

function RecentRuns({ runs }: { runs: OffsiteRunView[] }) {
  if (!runs.length) return null;
  return (
    <section className="cc-block" aria-labelledby="cc-offsite-runs-h">
      <h2 id="cc-offsite-runs-h" className="cc-block__title">
        آخر المحاولات
      </h2>
      <div className="cc-table-wrap" role="region" aria-label="آخر محاولات النسخ خارج الخادم" tabIndex={0}>
        <table className="cc-table">
          <thead>
            <tr>
              <th scope="col">الوقت</th>
              <th scope="col">النوع</th>
              <th scope="col">النتيجة</th>
              <th scope="col">الحجم المشفّر</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <th scope="row">{formatDateTime(r.created_at)}</th>
                <td>{TRIGGER_AR[r.trigger]}</td>
                <td>
                  <StatusPill tone={tone(r)}>{r.status === 'running' && r.stage_label_ar ? r.stage_label_ar : r.status_label_ar}</StatusPill>
                  {r.error_ar && <span className="cc-table__note">{r.error_ar}</span>}
                  {r.warnings_ar.map((w, i) => (
                    <span key={i} className="cc-table__note">
                      {w}
                    </span>
                  ))}
                  {r.retention && r.retention.errors_ar.map((w, i) => (
                    <span key={`r${i}`} className="cc-table__note">
                      {w}
                    </span>
                  ))}
                </td>
                <td>
                  <Bidi dir="ltr">{r.size !== null ? formatBytes(r.size) : '—'}</Bidi>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RemoteCopies({ s }: { s: OffsiteStatusResponse }) {
  const [list, setList] = useState<RemoteBackupView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setBusy(true);
    setError(null);
    try {
      setList((await offsiteApi.remote()).objects);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="cc-block" aria-labelledby="cc-offsite-restore-h">
      <h2 id="cc-offsite-restore-h" className="cc-block__title">
        الاستعادة من هاتفك
      </h2>
      <ol className="cc-bullets">
        <li>
          افتح لوحة <Bidi dir="ltr">Render</Bidi> ← خدمة <Bidi dir="ltr">MedLevo</Bidi> ← <Bidi dir="ltr">Shell</Bidi>.
        </li>
        <li>الصق هذا الأمر واضغط Enter. يُنزّل أحدث نسخة، ويفك تشفيرها، ويجرّب استعادتها بكل الفحوص، ثم يضعها في مجلد جديد بجانب بياناتك دون أن يلمسها:</li>
      </ol>
      <CopyCommand command={s.restore_command} label="أمر الاستعادة" />
      <ol className="cc-bullets" start={3}>
        <li>
          في <Bidi dir="ltr">Render</Bidi> ← <Bidi dir="ltr">Environment</Bidi> أضف المتغير <Bidi dir="ltr">MEDLEVO_DATA_DIR</Bidi> (أو عدّله إن كان موجودًا) بقيمة المجلد الذي يطبعه الأمر واحفظ؛ يعيد Render التشغيل على البيانات المستعادة. سجّل الدخول من جديد، وتعيد الأجهزة المزامنة وحدها.
        </li>
      </ol>
      <p className="cc-muted">الاستعادة ليست زرًّا هنا عمدًا: لا يستطيع أحد سرق جلستك أن يستبدل بياناتك، وتحتاج دخول حساب Render.</p>
      <div className="cc-offsite__actions">
        <Button onClick={() => void load()} loading={busy} loadingLabel="جارٍ القراءة من R2…" disabled={!s.configured} aria-describedby={!s.configured ? 'cc-offsite-why' : undefined}>
          اعرض النسخ المحفوظة في R2
        </Button>
      </div>
      {error && <ErrorState inline message={error} onRetry={() => void load()} />}
      {list && list.length === 0 && <p className="cc-muted">لا توجد نسخ في R2 بعد.</p>}
      {list && list.length > 0 && (
        <ul role="list" className="cc-offsite__remote">
          {list.map((o) => (
            <li key={o.key}>
              <p className="cc-offsite__remote-title">
                {formatDateTime(o.created_at)} — <Bidi dir="ltr">{formatBytes(o.size)}</Bidi>
              </p>
              <CopyCommand command={o.restore_command} label={`أمر استعادة نسخة ${formatDateTime(o.created_at)}`} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function OffsiteScreen() {
  const s = useLoad(() => offsiteApi.status(), []);
  const running = Boolean(s.data?.running);
  const { reload } = s;
  // while a run is in progress, refresh its stage every few seconds (stops by itself when it ends)
  useEffect(() => {
    if (!running) return;
    const id = setInterval(reload, 4000);
    return () => clearInterval(id);
  }, [running, reload]);
  return (
    <div className="cc-section">
      <SectionHeader
        title="النسخ الاحتياطي خارج الخادم"
        lede="نسخة كاملة تُختبر استعادتها على الخادم، ثم تُشفَّر وتُرفع إلى Cloudflare R2 كل يوم. إذا ضاع الخادم أو قرصه بقيت بياناتك هناك."
      />
      {s.error ? (
        <ErrorState inline message={s.error} onRetry={s.reload} />
      ) : !s.data ? (
        <LoadingState inline stage="جارٍ قراءة حالة النسخ…" />
      ) : (
        <>
          <StatusBlock s={s.data} onStarted={s.reload} />
          <RecentRuns runs={s.data.recent} />
          <RemoteCopies s={s.data} />
          <ul className="cc-notes">
            {s.data.notes_ar.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
