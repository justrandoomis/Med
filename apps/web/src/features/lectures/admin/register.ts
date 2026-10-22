// P1-T5's sections of «إدارة القنوات», registered through P1-T4's registry (features/admin/sections.ts; BUILD_PLAN §3.2).
// Each screen loads lazily; the registry decides title, order, path and who sees the entry — the server decides every
// action. «الملفات والمواعيد» (subject attachments) is not registered: its screen is not built yet (AOS-23.3).
import { adminSections, registerAdminSection } from '../../admin/sections';

export function registerLectureAdminSections(): void {
  const have = new Set(adminSections().map((s) => s.id));
  if (!have.has('official')) {
    registerAdminSection({
      id: 'official',
      owner: 'P1-T5',
      description_ar: 'المحاضرات بانتظار الموافقة والنشر، والإصدارات، والتصحيحات المقترحة، والسحب',
      lazy: () => import('./OfficialContentSection'),
    });
  }
  if (!have.has('duplicates')) {
    registerAdminSection({
      id: 'duplicates',
      owner: 'P1-T5',
      description_ar: 'الملفات المتطابقة والمتشابهة داخل المادة',
      lazy: () => import('./DuplicatesSection'),
    });
  }
}

registerLectureAdminSections();
