// «سياسة استخدام البيانات» — /me/privacy/policy (AOS-21.42; PRD NFR-PR1; IA §4.14). The written data-use policy, in
// Arabic, from the shared contract (one text for the server's consent records and this page), with its version. Linked
// from «أنا» and from «الخصوصية والبيانات». Static: it never asks the server and works offline.
import { DATA_POLICY_VERSION, DATA_USE_POLICY_AR } from '@medlevo/shared';
import { Link } from 'react-router-dom';
import { Breadcrumbs } from '../../design';
import { usePageTitle } from '../../lib/usePageTitle';
import './me.css';

export function DataPolicyScreen() {
  usePageTitle('سياسة استخدام البيانات');
  return (
    <div className="ml-page ml-page--narrow me-screen">
      <Breadcrumbs items={[{ label: 'أنا', to: '/me' }, { label: 'الخصوصية والبيانات', to: '/me/privacy' }, { label: 'سياسة استخدام البيانات' }]} />
      <header className="ml-page__header">
        <h1 className="ml-page__title">سياسة استخدام البيانات</h1>
      </header>
      <p className="me-note">
        ما يحفظه MedLevo من بياناتك، ومن يراها، ومتى يُرسل شيء منها إلى الذكاء الاصطناعي. الإصدار <bdi dir="ltr">{DATA_POLICY_VERSION}</bdi>.
      </p>
      {DATA_USE_POLICY_AR.map((s, i) => (
        <section key={s.title} className="me-section" aria-labelledby={`me-policy-${i}`}>
          <h2 id={`me-policy-${i}`} className="me-section__title">
            {s.title}
          </h2>
          <ul className="me-bullets">
            {s.body.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </section>
      ))}
      <p className="ml-group-footer">
        موافقتك على معالجة الذكاء الاصطناعي وسحبها، ونسخة من بياناتك وحذف حسابك: <Link to="/me/privacy">الخصوصية والبيانات</Link>.
      </p>
    </div>
  );
}
