// PLACEHOLDER — owned by another track; replace this file's contents when the feature is built.
// Shows honestly that the screen is not built yet (§61) and what it will contain.
import { Settings2 } from 'lucide-react';
import type { FeatureRoutes } from '../../app/routeTypes';
import { PlaceholderScreen } from '../shell/PlaceholderScreen';

function ControlPlaceholder() {
  return (
    <PlaceholderScreen
      title="مركز التحكم"
      purpose="المصادر والوظائف والنماذج والتكلفة والتخزين وقائمة المراجعة."
      spec="§48"
      icon={<Settings2 size={22} />}
      willContain={[
      'المصادر وحالات المعالجة والوظائف الجارية.',
      'النماذج المستخدمة والتكلفة التقديرية.',
      'التخزين والنسخ الاحتياطي واختبار الاستعادة.',
      'قائمة المراجعة: صفحات غير مقروءة، مفاتيح متعارضة، روابط غير مؤكدة.',
      'تعارضات المزامنة التي تحتاج قرارك.',
      ]}
    />
  );
}

export const routes: FeatureRoutes = {
  shell: [{ path: 'control/*', element: <ControlPlaceholder /> }],
};
