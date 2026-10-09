// PLACEHOLDER — owned by another track; replace this file's contents when the feature is built.
// Shows honestly that the screen is not built yet (§61) and what it will contain.
import { Target } from 'lucide-react';
import type { FeatureRoutes } from '../../app/routeTypes';
import { PlaceholderScreen } from '../shell/PlaceholderScreen';

function WeaknessPlaceholder() {
  return (
    <PlaceholderScreen
      title="نقاط الضعف"
      purpose="أين تخطئ ولماذا، وما الذي يستحق المراجعة الآن."
      spec="§44"
      icon={<Target size={22} />}
      willContain={[
      'أنماط أخطائك: نقص معرفة، خلط بين مفهومين، خطأ قراءة، ترتيب الخطوات…',
      'سبب كل توصية، مع إمكانية تعديل تصنيف الخطأ.',
      'المواضيع التي تحتاج مراجعة، مع روابطها في مصادرك.',
      ]}
    />
  );
}

export const routes: FeatureRoutes = {
  shell: [{ path: 'weakness/*', element: <WeaknessPlaceholder /> }],
};
