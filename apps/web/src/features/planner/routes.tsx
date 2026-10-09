// PLACEHOLDER — owned by another track; replace this file's contents when the feature is built.
// Shows honestly that the screen is not built yet (§61) and what it will contain.
import { CalendarDays } from 'lucide-react';
import type { FeatureRoutes } from '../../app/routeTypes';
import { PlaceholderScreen } from '../shell/PlaceholderScreen';

function PlannerPlaceholder() {
  return (
    <PlaceholderScreen
      title="مخطط الدراسة"
      purpose="خطة واقعية حتى موعد الامتحان."
      spec="§45"
      icon={<CalendarDays size={22} />}
      willContain={[
      'المدخلات: موعد الامتحان، المواد، الأيام والوقت المتاح يوميًا.',
      'خطة يومية تجمع التعلّم والمراجعة والأسئلة والبطاقات.',
      'إعادة توزيع واقعية عند التأخر، مع إظهار ما تغيّر.',
      ]}
    />
  );
}

export const routes: FeatureRoutes = {
  shell: [{ path: 'planner/*', element: <PlannerPlaceholder /> }],
};
