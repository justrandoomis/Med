// PLACEHOLDER — owned by another track; replace this file's contents when the feature is built.
// Shows honestly that the screen is not built yet (§61) and what it will contain.
import { House } from 'lucide-react';
import type { FeatureRoutes } from '../../app/routeTypes';
import { PlaceholderScreen } from '../shell/PlaceholderScreen';

function HomePlaceholder() {
  return (
    <PlaceholderScreen
      title="الرئيسية"
      purpose="نقطة البداية: تستأنف الدراسة من حيث توقفت."
      spec="§45, §23"
      icon={<House size={22} />}
      willContain={[
      '«متابعة الدراسة» أولًا: الكتاب الذي تركته مفتوحًا، في الموضع نفسه.',
      'خطة اليوم من مخطط الدراسة.',
      'البطاقات المستحقة للمراجعة اليوم.',
      'الأسئلة المهمة المرتبطة بما تدرسه، وموعد الامتحان.',
      'أبرز نقطة ضعف تحتاج انتباهك.',
      'مكتبة مختصرة: آخر الدفاتر والمصادر التي فتحتها.',
      ]}
    />
  );
}

export const routes: FeatureRoutes = {
  shell: [{ index: true, element: <HomePlaceholder /> }],
};
