// The deck of a published explanation on its page (AOS-21.27; copies-api «ادرس هذه البطاقات»). The author's cards on the
// lecture ride with the explanation; a classmate copies them into their OWN review with «ادرس هذه البطاقات» — their own
// cards from then on, with their own schedule and review history. A newer deck version is shown as a preview
// («طبّق التحديث» / «تخطَّ هذا الإصدار»); applying it never touches what they reviewed, and keeps the cards they edited.
// The section renders only what works for this viewer: nothing at all when the explanation has no cards (or the deck
// could not be read), the start action only when the server says the viewer may study it.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Layers, RefreshCw } from 'lucide-react';
import type { DeckCopyView, PublicationDeckView } from '@medlevo/shared';
import { Button, useToast } from '../../design';
import { errorMessage } from '../../lib/api';
import { useOnline } from '../../lib/useOnline';
import { copiesApi, pullCopyChanges } from './api';

export function cardsCountAr(n: number): string {
  if (n === 1) return 'بطاقة واحدة';
  if (n === 2) return 'بطاقتان';
  if (n >= 3 && n <= 10) return `${n} بطاقات`;
  return `${n} بطاقة`;
}

export function DeckSection({ spaceId, publicationId, onLoaded }: { spaceId: string; publicationId: string; onLoaded?: (deck: PublicationDeckView | null) => void }) {
  const online = useOnline();
  const toast = useToast();
  const [deck, setDeck] = useState<PublicationDeckView | null>(null);
  const [busy, setBusy] = useState<null | 'study' | 'apply' | 'skip'>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    copiesApi
      .deck(spaceId, publicationId)
      .then((d) => {
        if (cancelled) return;
        setDeck(d);
        onLoaded?.(d);
      })
      // the deck is an addition to the page: without it the explanation still works
      .catch(() => {
        if (cancelled) return;
        setDeck(null);
        onLoaded?.(null);
      });
    return () => {
      cancelled = true;
    };
  }, [spaceId, publicationId, onLoaded]);

  if (!deck || (deck.card_count === 0 && !deck.viewer.copy)) return null;
  const copy = deck.viewer.copy;
  const setCopy = (c: DeckCopyView) => setDeck((d) => (d ? { ...d, viewer: { ...d.viewer, can_study: false, copy: c } } : d));

  const study = async () => {
    setBusy('study');
    setError(null);
    try {
      const r = await copiesApi.studyDeck({ space_id: spaceId, publication_id: publicationId });
      setCopy(r.deck);
      pullCopyChanges();
      toast.show({ tone: 'success', title: r.created ? `أُضيفت ${cardsCountAr(r.copied)} إلى مراجعتك.` : 'بطاقات هذا الشرح في مراجعتك من قبل.', description: 'جدول مراجعتها لك وحدك.' });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const update = async (skip: boolean) => {
    if (!copy?.update) return;
    setBusy(skip ? 'skip' : 'apply');
    setError(null);
    try {
      const r = await copiesApi.applyDeckUpdate(publicationId, { version_no: copy.update.to_version_no, ...(skip ? { skip: true } : {}) });
      setCopy(r.deck);
      if (!skip) pullCopyChanges();
      toast.show({ tone: 'success', title: skip ? 'تخطّيت هذا الإصدار من البطاقات.' : 'طُبّق التحديث على بطاقاتك.', description: skip ? undefined : 'سجل مراجعاتك كما هو.' });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="pb-tab" aria-labelledby="publication-deck">
      <h2 id="publication-deck" className="pb-page__h2">
        بطاقات الشرح
      </h2>
      <p className="cp-sheet__line">{deck.viewer.is_author ? `نُشرت ${cardsCountAr(deck.card_count)} مع هذا الشرح.` : `مع هذا الشرح ${cardsCountAr(deck.card_count)} كتبها صاحبه.`}</p>
      {deck.viewer.can_study && (
        <div className="pb-tab__actions">
          <Button icon={<Layers size={18} />} onClick={study} loading={busy === 'study'} disabled={!online || busy !== null} aria-describedby="publication-deck-note">
            ادرس هذه البطاقات
          </Button>
          <p id="publication-deck-note" className="pb-meta">
            {online ? 'تُنسخ البطاقات إلى مراجعتك: جدولها وسجل مراجعاتها لك وحدك.' : 'أنت غير متصل: نسخ البطاقات يحتاج الخادم مرة واحدة.'}
          </p>
        </div>
      )}
      {copy && (
        <>
          <p className="cp-sheet__line">{`تدرس ${cardsCountAr(copy.cards)} من هذا الشرح (الإصدار ${copy.applied_version_no}).`}</p>
          <p className="pb-meta">
            <Link className="cp-bar__link" to="/review">
              افتح المراجعة
            </Link>
          </p>
          {copy.status_note_ar && (
            <p className="pb-notice" role="note">
              {copy.status_note_ar}
            </p>
          )}
          {copy.update && (
            <div className="pb-update" role="status">
              <p className="pb-update__text">{`تحديث للبطاقات من ${copy.author.display_name} (الإصدار ${copy.update.to_version_no}): ${copy.update.summary_ar}`}</p>
              <Button size="sm" icon={<RefreshCw size={16} />} onClick={() => update(false)} loading={busy === 'apply'} disabled={!online || busy !== null}>
                طبّق التحديث
              </Button>
              <Button size="sm" variant="secondary" onClick={() => update(true)} loading={busy === 'skip'} disabled={!online || busy !== null}>
                تخطَّ هذا الإصدار
              </Button>
            </div>
          )}
        </>
      )}
      {error && (
        <p className="cp-sheet__error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
