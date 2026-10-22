// The scope line every «إدارة القنوات» screen shows (IA §4.10 «نطاقك: …»), with a subject chooser when the viewer
// manages official content in more than one subject.
import type { ReactNode } from 'react';
import { EmptyState, ErrorState, LoadingState, Select } from '../../../design';
import type { AdminSubjectsState } from './useAdminSubjects';

export function SubjectScope({ state, children }: { state: AdminSubjectsState; children: (s: NonNullable<AdminSubjectsState['current']>) => ReactNode }) {
  if (state.status === 'loading') return <LoadingState stage="جارٍ تحميل موادك…" inline />;
  if (state.status === 'error') return <ErrorState message={state.error ?? ''} onRetry={state.reload} inline />;
  const current = state.current;
  if (!current) {
    return (
      <EmptyState
        headingLevel={2}
        title="لا توجد مادة تدير محتواها الرسمي"
        description="يظهر هنا محتوى المواد التي لك فيها دور «مشرف المادة» أو «مساهم» أو «مدير القناة»."
      />
    );
  }
  return (
    <>
      <div className="lec-admin__scope">
        {state.subjects.length > 1 ? (
          <Select
            label="المادة"
            value={current.id}
            onValueChange={(v) => state.choose(v)}
            options={state.subjects.map((s) => ({ value: s.id, label: s.title }))}
          />
        ) : (
          <p className="lec-admin__scope-line">
            نطاقك: <strong>{current.title}</strong>
          </p>
        )}
      </div>
      {children(current)}
    </>
  );
}
