// PLACEHOLDER — owned by another track; replace this file's contents when the feature is built.
// Shows honestly that the screen is not built yet (§61) and what it will contain.
import { Upload } from 'lucide-react';
import { Term } from '../../design';
import type { FeatureRoutes } from '../../app/routeTypes';
import { PlaceholderScreen } from '../shell/PlaceholderScreen';

function UploadPlaceholder() {
  return (
    <PlaceholderScreen
      title="رفع المصادر"
      purpose="رفع الملفات وفحصها ومعالجتها لتصبح قابلة للقراءة والاستشهاد."
      spec="§13"
      icon={<Upload size={22} />}
      willContain={[
      <>رفع <Term>PDF</Term> و<Term>DOCX</Term> و<Term>PPTX</Term> والصور وملفات <Term>ZIP</Term>.</>,
      'اختيار نوع المصدر ومكانه في المكتبة.',
      'متابعة مراحل المعالجة بأعداد حقيقية للصفحات، دون نسب مئوية وهمية.',
      'عرض الصفحات التي تعثّرت معالجتها بوضوح، مع بقاء بقية الصفحات قابلة للقراءة.',
      ]}
    />
  );
}

export const routes: FeatureRoutes = {
  shell: [{ path: 'upload', element: <UploadPlaceholder /> }],
};
