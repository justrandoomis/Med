// The five primary destinations of the app shell (IA_AND_JOURNEYS §3.1; P1-T4 step 3). Phones show them in the bottom
// tab bar, wider screens in the slim top bar. «الإعدادات» moved into «أنا» (IA decision 1): the Settings URL stays
// `/settings`, and while it is open the «أنا» destination is the current one. The study workspace (/study/…) has no
// shell at all.
import { CircleUserRound, GraduationCap, House, Layers, Library, type LucideIcon } from 'lucide-react';

export interface Destination {
  to: string;
  label: string;
  icon: LucideIcon;
  /** path prefixes (whole segments) of the screens that belong to this destination; '/' matches only itself */
  owns: readonly string[];
}

export const PRIMARY_DESTINATIONS: readonly Destination[] = [
  { to: '/', label: 'الرئيسية', icon: House, owns: ['/'] },
  { to: '/library', label: 'المكتبة', icon: Library, owns: ['/library'] },
  // channels home and browse, subject pages and the official lecture pages under them, publication pages (P1-T5)
  { to: '/channels', label: 'القنوات', icon: GraduationCap, owns: ['/channels', '/subjects', '/p'] },
  // the review hub and everything IA §3.2 places under it (review of P1-T4 step 3, R9)
  {
    to: '/review',
    label: 'المراجعة',
    icon: Layers,
    owns: ['/review', '/questions', '/exams', '/practice', '/cases', '/planner', '/weakness', '/concepts', '/knowledge', '/terms', '/explanation-rules'],
  },
  // «أنا»: my account, settings, the Personal Control Center, downloads, channel administration (with a role)
  { to: '/me', label: 'أنا', icon: CircleUserRound, owns: ['/me', '/settings', '/control', '/offline', '/admin'] },
];

function owns(prefix: string, pathname: string): boolean {
  if (prefix === '/') return pathname === '/';
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** The destination the screen at `pathname` belongs to (marked `aria-current="page"`), or null. */
export function activeDestination(pathname: string): Destination | null {
  return PRIMARY_DESTINATIONS.find((d) => d.owns.some((p) => owns(p, pathname))) ?? null;
}
