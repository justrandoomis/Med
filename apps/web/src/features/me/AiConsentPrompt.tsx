// AOS-21.42: AI features need this account's ai_processing consent. Instead of an error, an AI action the server refuses
// with CONSENT_REQUIRED opens ONE dialog «تفعيل ميزات الذكاء الاصطناعي» with the exact consent text of «الخصوصية
// والبيانات» (the server's text_ar, from @medlevo/shared): «وافق وفعّل» records the consent through the same API and the
// refused request is sent once more; «ليس الآن» closes it and nothing is sent. The home screen shows a small prompt
// (dismissible) while the server has a provider configured and this account has not agreed; it opens the same dialog.
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { Sparkles, X } from 'lucide-react';
import type { AiConsentView } from '@medlevo/shared';
import { Button, Dialog, ErrorState, IconButton, LoadingState } from '../../design';
import { errorMessage, setAiConsentHandler } from '../../lib/api';
import { useOnline } from '../../lib/useOnline';
import { readJson, userStorage, writeJson } from '../../lib/userStorage';
import { ReasonedButton } from '../channels/ui';
import { meApi } from './api';
import { aiConsentRevision, isAskingAiConsent, requestAiConsent, settleAiConsent, subscribeAiConsent } from './aiConsentStore';
import './me.css';

/** The consent text exactly as «الخصوصية والبيانات» shows it (what «أوافق» agrees to), with its version. */
export function AiConsentText({ view }: { view: AiConsentView }) {
  return (
    <>
      <p className="me-note">
        نص الموافقة (الإصدار <bdi dir="ltr">{view.current_text_version}</bdi>):
      </p>
      <ul className="me-bullets">
        {view.text_ar.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
    </>
  );
}

/** Mounted once behind the session: answers CONSENT_REQUIRED for every request of the app (lib/api.ts). */
export function AiConsentPrompt() {
  const open = useSyncExternalStore(subscribeAiConsent, isAskingAiConsent);
  useEffect(() => {
    setAiConsentHandler(() => requestAiConsent());
    return () => {
      setAiConsentHandler(null);
      if (isAskingAiConsent()) settleAiConsent(false);
    };
  }, []);
  return open ? <AiConsentDialog /> : null;
}

function AiConsentDialog() {
  const online = useOnline();
  const [view, setView] = useState<AiConsentView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    meApi
      .aiConsent()
      .then((v) => {
        // agreed meanwhile (another tab, «الخصوصية والبيانات»): nothing to ask — the request goes again
        if (v.granted) settleAiConsent(true);
        else {
          setView(v);
          setLoadError(null);
        }
      })
      .catch((e) => setLoadError(errorMessage(e)));
  }, []);
  useEffect(load, [load]);

  const p = view?.provider ?? null;
  const askable = !!view && !!p && p.leaves_deployment;
  const agree = async () => {
    if (!view || !p) return;
    setBusy(true);
    setSaveError(null);
    try {
      const v = await meApi.setAiConsent({ granted: true, provider: p.id, text_version: view.current_text_version });
      if (v.granted) settleAiConsent(true);
      else setView(v);
    } catch (e) {
      setSaveError(errorMessage(e));
      load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={() => settleAiConsent(false)}
      title="تفعيل ميزات الذكاء الاصطناعي"
      description={p ? `الشرح والملخصات والأسئلة وباقي ميزات الذكاء الاصطناعي تحتاج موافقتك على إرسال ما تطلب معالجته إلى ${p.label_ar}. لم يُرسل شيء بعد.` : 'لم يُرسل شيء بعد.'}
      footer={
        <>
          <Button variant="secondary" onClick={() => settleAiConsent(false)} disabled={busy}>
            ليس الآن
          </Button>
          {askable && (
            <ReasonedButton variant="primary" loading={busy} reason={online ? null : 'تسجيل الموافقة يحتاج اتصالًا بالخادم.'} onClick={() => void agree()}>
              وافق وفعّل
            </ReasonedButton>
          )}
        </>
      }
    >
      {loadError && !view ? (
        <ErrorState inline message={loadError} onRetry={load} />
      ) : !view ? (
        <LoadingState inline stage="جارٍ التحميل…" />
      ) : !p ? (
        <p className="me-note">لا يوجد مزوّد ذكاء اصطناعي مضبوط على هذا الخادم، فلا يُرسل شيء من محتواك إلى أي جهة.</p>
      ) : !p.leaves_deployment ? (
        <p className="me-note">مزوّد الذكاء الاصطناعي المضبوط ({p.label_ar}) يعمل داخل هذا الخادم، فلا تلزم موافقة.</p>
      ) : (
        <div className="ml-stack">
          <AiConsentText view={view} />
          <p className="me-note">
            تستطيع سحب موافقتك في أي وقت من <Link to="/me/privacy" onClick={() => settleAiConsent(false)}>«أنا» ← «الخصوصية والبيانات»</Link>.
          </p>
          {saveError && (
            <p className="me-ai-dialog__error" role="alert">
              {saveError}
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}

const NUDGE_DISMISSED_KEY = 'medlevo.ai-consent-nudge.dismissed.v1';

/**
 * Home: a small, dismissible prompt while AI is configured on the server (a provider outside the deployment) and this
 * account has not agreed. «فعّل» opens the same dialog; «إخفاء» hides it on this device until the consent text changes.
 */
export function AiConsentNudge() {
  const online = useOnline();
  const revision = useSyncExternalStore(subscribeAiConsent, aiConsentRevision);
  const [view, setView] = useState<AiConsentView | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(() => readJson<{ text_version: string }>(userStorage, NUDGE_DISMISSED_KEY)?.text_version ?? null);
  useEffect(() => {
    if (!online) return;
    let live = true;
    meApi
      .aiConsent()
      .then((v) => {
        if (live) setView(v);
      })
      .catch(() => undefined); // nothing to prompt about when the server cannot say
    return () => {
      live = false;
    };
  }, [online, revision]);

  const p = view?.provider ?? null;
  if (!view || !p || !p.leaves_deployment || view.granted || dismissed === view.current_text_version) return null;
  const dismiss = () => {
    writeJson(userStorage, NUDGE_DISMISSED_KEY, { text_version: view.current_text_version });
    setDismissed(view.current_text_version);
  };
  return (
    <aside className="me-ai-nudge" aria-label="ميزات الذكاء الاصطناعي">
      <Sparkles size={18} aria-hidden="true" className="me-ai-nudge__icon" />
      <p className="me-ai-nudge__text">ميزات الذكاء الاصطناعي (الشرح والملخصات والأسئلة) متوقفة لحسابك حتى توافق على إرسال ما تطلبه إلى {p.label_ar}.</p>
      <Button size="sm" variant="secondary" onClick={() => void requestAiConsent()}>
        فعّلها
      </Button>
      <IconButton size="sm" label="إخفاء" icon={<X size={16} />} onClick={dismiss} />
    </aside>
  );
}
