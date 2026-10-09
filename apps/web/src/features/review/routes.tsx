// PLACEHOLDER — owned by another track; replace this file's contents when the feature is built.
// Shows honestly that the screen is not built yet (§61) and what it will contain.
import { Layers } from 'lucide-react';
import { Term } from '../../design';
import type { FeatureRoutes } from '../../app/routeTypes';
import { PlaceholderScreen } from '../shell/PlaceholderScreen';

function ReviewPlaceholder() {
  return (
    <PlaceholderScreen
      title="المراجعة"
      purpose="البطاقات والأخطاء والمواضيع المستحقة للمراجعة."
      spec="§43, §44"
      icon={<Layers size={22} />}
      willContain={[
      <>البطاقات المستحقة اليوم وفق التكرار المتباعد (<Term>FSRS</Term>).</>,
      'بطاقات من أخطائك ومن تحديداتك داخل الكتاب.',
      <>جلسة مراجعة بمدة تحددها (<Term>One-Tap Revision</Term>).</>,
      'كل مراجعة تُحفظ على هذا الجهاز أولًا ثم تُزامَن، ولا تُحتسب مرتين.',
      ]}
    />
  );
}

export const routes: FeatureRoutes = {
  shell: [{ path: 'review/*', element: <ReviewPlaceholder /> }],
};
