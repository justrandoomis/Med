// «انضم برمز أو QR» (P1-T4 step 3; IA §4.1, J9; PRD AOS-2.11–2.13). One sheet: the code field (LTR, base32 groups —
// it also takes a pasted invite link), «امسح رمز QR» (camera, decoded on the device) and «اختر صورة رمز QR» (a
// screenshot or photo). A link read from a QR first shows the channel's title from the public preview; the person
// then taps «انضم». The server decides everything: pending or approved, wrong / expired / revoked codes, rate limits.
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { CircleCheck, Clock, ImageUp, ScanLine } from 'lucide-react';
import { JOIN_POLICY_LABELS_AR, type JoinPreviewResponse, type JoinResponse } from '@medlevo/shared';
import { Button, Dialog, TextField } from '../../design';
import { errorMessage, isApiError } from '../../lib/api';
import { useOnline } from '../../lib/useOnline';
import { channelsApi } from './api';
import { dropCache } from './cache';
import { parseJoinInput, type JoinInput } from './model';
import { decodeQrFromFile, joinFromQrText } from './qr';
import { QrScanner } from './QrScanner';
import './channels.css';

interface Props {
  open: boolean;
  onClose: () => void;
  /** after a join (pending or approved): the caller reloads its lists */
  onJoined?: (r: JoinResponse) => void;
}

/** Where a membership leads: a subject opens its page, any other node its place in the tree. */
export function membershipLink(r: JoinResponse): string {
  const n = r.membership.node;
  return n.kind === 'subject' ? `/subjects/${n.id}` : `/channels/${n.id}`;
}

export function JoinResult({ result, focusOnShow }: { result: JoinResponse; focusOnShow?: boolean }) {
  const pending = result.membership.status === 'pending';
  const ref = useRef<HTMLDivElement>(null);
  // the control that had the focus (the field, «انضم») is gone: the result takes it, so Escape and Tab keep working
  useEffect(() => {
    if (focusOnShow) ref.current?.focus();
  }, [focusOnShow]);
  return (
    <div ref={ref} tabIndex={-1} className="ch-join__result" role="status">
      <p className="ch-section__title">
        {pending ? <Clock size={20} aria-hidden="true" /> : <CircleCheck size={20} aria-hidden="true" />} {pending ? 'طلبك قيد المراجعة' : 'تم الانضمام'}
      </p>
      <p>{result.message_ar}</p>
      {pending ? (
        <p className="ml-group-footer">يصلك تنبيه في «التنبيهات» عند قرار المشرف. مكتبتك الشخصية تعمل كما هي في الأثناء.</p>
      ) : (
        <Link className="ml-btn ml-btn--primary ml-btn--md" to={membershipLink(result)}>
          {result.membership.node.kind === 'subject' ? 'افتح المادة' : 'افتح القناة'}
        </Link>
      )}
    </div>
  );
}

export function JoinSheet({ open, onClose, onJoined }: Props) {
  const online = useOnline();
  const fieldRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const formId = useId();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [preview, setPreview] = useState<{ token: string; info: JoinPreviewResponse } | null>(null);
  const [result, setResult] = useState<JoinResponse | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  // a link read from a QR replaces the form (and the button that had the focus): the channel's title takes the focus
  useEffect(() => {
    if (preview) previewRef.current?.focus();
  }, [preview]);

  const reset = () => {
    setValue('');
    setError(null);
    setNote(null);
    setBusy(false);
    setScanning(false);
    setPreview(null);
    setResult(null);
  };
  const close = () => {
    reset();
    onClose();
  };

  const join = async (input: JoinInput) => {
    if (input.kind === 'invalid') {
      setError(input.reason_ar);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = input.kind === 'code' ? await channelsApi.joinWithCode(input.code) : await channelsApi.joinWithLink(input.token);
      dropCache('tree');
      setResult(r);
      setPreview(null);
      onJoined?.(r);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  /** A decoded QR (camera or picture): a link shows the channel's title first; a code goes into the field. */
  const fromQr = async (text: string) => {
    setScanning(false);
    const r = joinFromQrText(text);
    if (r.kind === 'invalid') {
      setError(r.reason_ar);
      return;
    }
    if (r.kind === 'code') {
      setValue(r.code);
      setNote('قُرئ رمز الانضمام من الصورة. اضغط «انضم».');
      fieldRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      setPreview({ token: r.token, info: await channelsApi.preview(r.token) });
      setError(null);
    } catch (e) {
      // the public preview answers an unusable link with the body of a missing route: say what it means here
      // (review P1-T4 step 3, R7); no connection or a rate limit keep their own message
      setError(isApiError(e) && e.status === 404 ? 'رابط الدعوة في هذا الرمز غير صالح أو انتهت صلاحيته. اطلب رمزًا جديدًا من مشرف المادة.' : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setNote(null);
    setBusy(true);
    try {
      const text = await decodeQrFromFile(file);
      setBusy(false);
      if (!text) {
        setError('لم نجد رمز QR واضحًا في هذه الصورة. صوّر الرمز من قرب، أو اكتب الرمز بنفسك.');
        return;
      }
      await fromQr(text);
    } catch {
      setBusy(false);
      setError('تعذّرت قراءة هذه الصورة. اختر صورة أخرى أو اكتب الرمز.');
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void join(parseJoinInput(value));
  };

  const offlineReason = online ? null : 'الانضمام يحتاج اتصالًا بالإنترنت.';
  return (
    <Dialog
      open={open}
      onClose={close}
      title="انضم إلى مادة"
      description="اكتب رمز الانضمام الذي أعطاك إياه مشرف المادة، أو الصق رابط الدعوة، أو امسح رمز QR."
      footer={
        result ? (
          <Button onClick={close}>تم</Button>
        ) : (
          <>
            <Button onClick={close}>إلغاء</Button>
            {!preview && (
              <Button type="submit" form={formId} variant="primary" loading={busy} disabled={!!offlineReason} aria-describedby={offlineReason ? `${formId}-off` : undefined}>
                انضم
              </Button>
            )}
          </>
        )
      }
    >
      {result ? (
        <JoinResult result={result} focusOnShow />
      ) : (
        <div className="ch-join">
          {offlineReason && (
            <p id={`${formId}-off`} className="ch-reasoned__why">
              {offlineReason}
            </p>
          )}
          {preview ? (
            <div ref={previewRef} tabIndex={-1} className="ch-join__result">
              <p>
                دعوة للانضمام إلى: <strong>{preview.info.title_ar}</strong>
              </p>
              <p className="ml-group-footer">{preview.info.requires_approval ? JOIN_POLICY_LABELS_AR.approval : 'تنضم مباشرة.'}</p>
              <div className="ch-join__or">
                <Button
                  variant="primary"
                  loading={busy}
                  disabled={!!offlineReason}
                  aria-describedby={offlineReason ? `${formId}-off` : undefined}
                  onClick={() => void join({ kind: 'link', token: preview.token })}
                >
                  {`انضم إلى ${preview.info.title_ar}`}
                </Button>
                <Button onClick={() => setPreview(null)}>ليس الآن</Button>
              </div>
            </div>
          ) : (
            <form id={formId} onSubmit={submit} className="ch-join">
              <TextField
                ref={fieldRef}
                className="ch-join__input"
                fieldClassName="ch-join__code"
                label="رمز الانضمام أو رابط الدعوة"
                hint="8 رموز مثل ABCD-EFGH، أو رابط يبدأ بـ https ويحوي /join/"
                dir="ltr"
                inputMode="text"
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
                value={value}
                error={error ?? undefined}
                onChange={(e) => {
                  setValue(e.target.value);
                  setError(null);
                }}
              />
              {note && (
                <p className="ml-group-footer" role="status">
                  {note}
                </p>
              )}
            </form>
          )}
          {!preview && (
            <>
              {scanning ? (
                <QrScanner
                  onResult={(t) => void fromQr(t)}
                  onStop={() => setScanning(false)}
                  onUnavailable={(reason) => {
                    setScanning(false);
                    setNote(reason);
                    setTimeout(() => fieldRef.current?.focus(), 0);
                  }}
                />
              ) : (
                <div className="ch-join__or">
                  <Button
                    icon={<ScanLine size={18} />}
                    onClick={() => {
                      setNote(null);
                      setError(null);
                      setScanning(true);
                    }}
                  >
                    امسح رمز QR
                  </Button>
                  <Button icon={<ImageUp size={18} />} onClick={() => fileRef.current?.click()}>
                    اختر صورة رمز QR
                  </Button>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    className="ch-file-input"
                    tabIndex={-1}
                    aria-label="صورة رمز QR"
                    onChange={(e) => void onFile(e.target.files?.[0])}
                  />
                </div>
              )}
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}
