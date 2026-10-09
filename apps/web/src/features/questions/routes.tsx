// PLACEHOLDER — owned by another track; replace this file's contents when the feature is built.
// Shows honestly that the screen is not built yet (§61) and what it will contain.
import { ListChecks } from 'lucide-react';
import type { FeatureRoutes } from '../../app/routeTypes';
import { PlaceholderScreen } from '../shell/PlaceholderScreen';

function QuestionsPlaceholder() {
  return (
    <PlaceholderScreen
      title="الأسئلة"
      purpose="خزنة أسئلتي: أسئلة مصادري، والأسئلة المولدة المسموحة بوضوح أنها مولدة."
      spec="§33–§38"
      icon={<ListChecks size={22} />}
      willContain={[
      'أسئلة مصادرك كما وردت، مع موضعها الأصلي ومفتاح الإجابة إن وُجد.',
      'ربط الأسئلة بالمحاضرات مع سبب الربط وصفحاته.',
      'أسئلة مولدة تظهر بوضوح أنها مولدة، ولكل منها أدلتها.',
      'ورقة سؤال نظيفة، ومراجعة مستندة إلى المصدر بعد الحل.',
      ]}
    />
  );
}

export const routes: FeatureRoutes = {
  shell: [{ path: 'questions/*', element: <QuestionsPlaceholder /> }],
};
