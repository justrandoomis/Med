// P1-T4's sections of «إدارة القنوات», registered through the area's own registry (sections.ts; IA §4.10). Each loads
// lazily; the registry decides title, order, path and who sees the entry — the server decides every action.
import type { ComponentType } from 'react';
import { adminSections, registerAdminSection } from './sections';

export function registerChannelAdminSections(): void {
  const have = new Set(adminSections().map((s) => s.id));
  const add = (id: 'tree' | 'members' | 'codes' | 'roles' | 'moderation' | 'audit', description_ar: string, lazy: () => Promise<{ Component: ComponentType }>) => {
    if (!have.has(id)) registerAdminSection({ id, owner: 'P1-T4', description_ar, lazy });
  };
  add('tree', 'الجامعات والكليات والمراحل والمواد: إنشاء وتعديل ونقل وأرشفة مع معاينة الأثر', () => import('./TreeSection'));
  add('members', 'طلبات الانضمام بانتظار الموافقة، والأعضاء، والموافقة على عدة طلبات معًا', () => import('./MembersSection'));
  add('codes', 'رموز الصف وروابط الدعوة و QR: الصلاحية وعدد الاستخدام والإلغاء', () => import('./CodesSection'));
  add('roles', 'المديرون والمساعدون ومشرفو المواد والمساهمون، مع ما يُورث من الأعلى', () => import('./RolesSection'));
  add('moderation', 'البلاغات على الشروح المنشورة: أبقِ أو أخفِ مع السبب أو أعِد الإظهار', () => import('./ModerationSection'));
  add('audit', 'من فعل ماذا وبأي دور ومتى في نطاقك — دون محتوى خاص', () => import('./AuditSection'));
}

registerChannelAdminSections();
