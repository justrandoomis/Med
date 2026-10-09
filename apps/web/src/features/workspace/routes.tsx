// PLACEHOLDER — owned by another track; replace this file's contents when the feature is built.
// Shows honestly that the screen is not built yet (§61) and what it will contain.
import { BookOpenText } from 'lucide-react';
import { Term } from '../../design';
import type { FeatureRoutes } from '../../app/routeTypes';
import { PlaceholderScreen } from '../shell/PlaceholderScreen';

function WorkspacePlaceholder() {
  return (
    <PlaceholderScreen
      title="مساحة الدراسة"
      purpose="الكتاب والتدوين والشرح السياقي في مساحة واحدة بملء الشاشة."
      spec="§23–§26"
      icon={<BookOpenText size={22} />}
      willContain={[
      <>الكتاب في الوسط: المحاضرة الأصلية أو <Term>MedLevo Study Book</Term>.</>,
      'الكتابة بالقلم والتظليل والملاحظات، مع حفظ محلي فوري لا ينتظر الشبكة.',
      'لوحة الدراسة السياقية قابلة للإخفاء وتغيير العرض.',
      'الصفحات المصغّرة والفهرس والبحث داخل المصدر.',
      <>مصدر كل معلومة عبر <Term>Source Chips</Term> تفتح الصفحة الأصلية.</>,
      ]}
      showHomeLink
    />
  );
}

export const routes: FeatureRoutes = {
  fullBleed: [{ path: 'study/*', element: <WorkspacePlaceholder /> }],
};
