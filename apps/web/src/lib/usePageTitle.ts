import { useEffect } from 'react';

/** Sets the document title as «<title> — MedLevo AI» (screen readers announce it on navigation). */
export function usePageTitle(title: string | null | undefined): void {
  useEffect(() => {
    document.title = title ? `${title} — MedLevo AI` : 'MedLevo AI';
  }, [title]);
}
