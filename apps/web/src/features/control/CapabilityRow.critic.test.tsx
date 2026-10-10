// Critic round regression (§61 «لا تُعرض ميزة كأنها تعمل وهي لا تعمل»): the Control Center's «القدرات» list hid the
// server's stated limit of every WORKING feature — «الصوت: تعمل» without «التفريغ الآلي غير متاح», «شرح الأشكال:
// تعمل» without «من التعليق فقط، دون رؤية», «التصدير PDF: تعمل» without «عبر الطباعة من المتصفح، دون الحبر».
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Row } from './CapabilitiesScreen';

describe('capability row', () => {
  it('a working feature with a stated limit says «تعمل بحدود» and shows the limit', () => {
    render(
      <ul>
        <Row f={{ key: 'workspace.audio', state: 'available', reason_ar: 'التفريغ الآلي والتسجيل داخل التطبيق غير متاحين في هذا الإصدار.' }} />
      </ul>,
    );
    expect(screen.getByText('تعمل بحدود')).toBeTruthy();
    expect(screen.getByText(/الحدود: التفريغ الآلي والتسجيل داخل التطبيق غير متاحين/)).toBeTruthy();
    expect(screen.queryByText('تعمل')).toBeNull();
  });

  it('a working feature without a limit stays «تعمل» with no note; an unavailable one keeps its reason', () => {
    render(
      <ul>
        <Row f={{ key: 'library', state: 'available' }} />
        <Row f={{ key: 'export.docx', state: 'not_implemented', reason_ar: 'تصدير DOCX غير مبني.' }} />
      </ul>,
    );
    expect(screen.getByText('تعمل')).toBeTruthy();
    expect(screen.queryByText(/^الحدود:/)).toBeNull();
    expect(screen.getByText('لم تُبنَ بعد').closest('li')!.textContent).toContain('تصدير DOCX غير مبني.');
  });
});
