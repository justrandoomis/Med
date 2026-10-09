// PLACEHOLDER — owned by another track; replace this file's contents when the feature is built.
// Shows honestly that the screen is not built yet (§61) and what it will contain.
import { Library } from 'lucide-react';
import type { FeatureRoutes } from '../../app/routeTypes';
import { PlaceholderScreen } from '../shell/PlaceholderScreen';

function LibraryPlaceholder() {
  return (
    <PlaceholderScreen
      title="المكتبة"
      purpose="دفاترك وموادك ومصادرك في شجرة واحدة تنظّمها بنفسك."
      spec="§05, §06, §23"
      icon={<Library size={22} />}
      willContain={[
      'دفاتر ومجلدات ومواد وكورسات بترتيب يدوي.',
      'المحاضرات والمراجع ومصادر الأسئلة داخل كل كورس.',
      'بحث وفلاتر حسب نوع المصدر والمادة.',
      'حالة معالجة كل ملف، وما هو محمّل للعمل دون اتصال.',
      'الأرشيف وسلة المحذوفات، مع إظهار أثر الحذف النهائي قبل تنفيذه.',
      ]}
    />
  );
}

export const routes: FeatureRoutes = {
  shell: [{ path: 'library/*', element: <LibraryPlaceholder /> }],
};
