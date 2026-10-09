// PLACEHOLDER — owned by another track; replace this file's contents when the feature is built.
// Shows honestly that the screen is not built yet (§61) and what it will contain.
import { Search } from 'lucide-react';
import type { FeatureRoutes } from '../../app/routeTypes';
import { PlaceholderScreen } from '../shell/PlaceholderScreen';

function SearchPlaceholder() {
  return (
    <PlaceholderScreen
      title="البحث"
      purpose="البحث في كل ما في مكتبتك، مع موضع كل نتيجة ومصدرها."
      spec="§46"
      icon={<Search size={22} />}
      willContain={[
      'بحث دقيق ودلالي داخل المحاضرات والمراجع والملاحظات والأسئلة والبطاقات.',
      'مرادفات عربية وإنجليزية واختصارات طبية.',
      'فلاتر حسب المادة والكورس ونوع المصدر.',
      'كل نتيجة تُظهر المقتطف والموضع، وهل هي من المصدر أم مولدة.',
      ]}
    />
  );
}

export const routes: FeatureRoutes = {
  shell: [{ path: 'search', element: <SearchPlaceholder /> }],
};
