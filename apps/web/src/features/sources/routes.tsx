// PLACEHOLDER — owned by the library & sources track; replace this file's contents when the feature is built.
import { FileText } from 'lucide-react';
import type { FeatureRoutes } from '../../app/routeTypes';
import { PlaceholderScreen } from '../shell/PlaceholderScreen';

function SourcePlaceholder() {
  return (
    <PlaceholderScreen
      title="تفاصيل المصدر"
      purpose="بيانات المصدر ونسخه وحالة معالجة صفحاته."
      spec="§06, §07, §13, §18"
      icon={<FileText size={22} />}
      willContain={['البيانات الوصفية القابلة للتصحيح.', 'النسخ وتثبيت النسخة (Source Freeze).', 'حالة كل صفحة وأسباب التعثر وإعادة المعالجة.']}
    />
  );
}

export const routes: FeatureRoutes = {
  shell: [{ path: 'sources/:sourceId', element: <SourcePlaceholder /> }],
};
