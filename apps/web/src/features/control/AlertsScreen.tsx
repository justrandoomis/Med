// تنبيهات المحتوى (§18, AC-26): what changed in a source, what is still valid, what needs regeneration or review —
// the evidence feature's panel, with the choice between new alerts and the full history.
import { useState } from 'react';
import { SegmentedControl } from '../../design';
import { ContentAlertsPanel } from '../evidence';
import { SectionHeader } from './shared';

export function AlertsScreen() {
  const [status, setStatus] = useState<'active' | 'all'>('active');
  return (
    <div className="cc-section">
      <SectionHeader
        title="تنبيهات المحتوى"
        lede="عند تصحيح نص أو مفتاح أو رفع نسخة جديدة من مصدر، يظهر هنا ما تأثر: ما زال صالحًا، أو يحتاج إعادة توليد، أو يحتاج مراجعتك. لا يتغير شيء درسته بصمت، ومحاولاتك السابقة تبقى مرتبطة بالنسخة التي أجبت عليها."
      />
      <div className="cc-filters">
        <SegmentedControl
          label="التنبيهات المعروضة"
          value={status}
          onValueChange={setStatus}
          options={[
            { value: 'active', label: 'المفتوحة' },
            { value: 'all', label: 'الكل' },
          ]}
        />
      </div>
      <ContentAlertsPanel key={status} status={status} className="cc-alerts" />
    </div>
  );
}
