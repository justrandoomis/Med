// PLACEHOLDER — owned by another track; replace this file's contents when the feature is built.
// Shows honestly that the screen is not built yet (§61) and what it will contain.
import { GraduationCap } from 'lucide-react';
import { Term } from '../../design';
import type { FeatureRoutes } from '../../app/routeTypes';
import { PlaceholderScreen } from '../shell/PlaceholderScreen';

function ExamsPlaceholder() {
  return (
    <PlaceholderScreen
      title="التدريب والامتحانات"
      purpose="التدريب ومحاكي الامتحان والحالات السريرية."
      spec="§39, §41, §42"
      icon={<GraduationCap size={22} />}
      willContain={[
      'أوضاع الدراسة: تعلّم، فهم، تدريب، مراجعة، امتحان.',
      'محاكي امتحان بمؤقت، دون كشف الحل قبل الإنهاء.',
      <>الأسئلة المقالية والحالات السريرية و<Term>OSCE</Term>.</>,
      'نتائج مفصلة مع الأدلة بعد الحل.',
      ]}
    />
  );
}

export const routes: FeatureRoutes = {
  shell: [{ path: 'exams/*', element: <ExamsPlaceholder /> }],
};
