// AOS-20.3 / AC-20 (track C3): a title or a short note a PERSON typed (a channel / subject / lecture / explanation
// title, a change note), drawn in a heading, a row or a list. Its paragraph direction is the direction of its first
// letter (what <bdi> / HTML dir=auto does), and every English expression — the brackets, numbers and units around it
// included — is isolated by BidiText (shared segmentRuns), so «… البطن (CT abdomen)» never draws its «(» on the
// wrong side. No bidi control character is inserted; DOM order stays the logical order.
import type { Dir } from '@medlevo/shared';
import { BidiText } from '../features/evidence/BidiText';

const RTL_LETTER = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u;
const LETTER = /\p{L}/u;

/** the direction of the first strong letter; text without any letter follows the Arabic-first UI */
export function firstStrongDir(text: string): Dir {
  for (const ch of text) {
    if (RTL_LETTER.test(ch)) return 'rtl';
    if (LETTER.test(ch)) return 'ltr';
  }
  return 'rtl';
}

export function MixedText({ text, as = 'span', className }: { text: string; as?: 'span' | 'p' | 'div'; className?: string }) {
  return <BidiText as={as} text={text} dir={firstStrongDir(text)} className={className} />;
}
