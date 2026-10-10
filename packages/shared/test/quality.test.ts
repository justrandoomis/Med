// Client error redaction (§56): the one function the browser applies before sending and the server applies again
// before storing. No document / owner text, no query strings, no tokens or keys; stack frames reduced to code locations.
import { describe, expect, it } from 'vitest';
import { CLIENT_ERROR_MESSAGE_MAX, redactClientError, redactRoute, redactStack, redactText } from '../src/quality-api';

describe('redactText', () => {
  it('removes keys, bearer tokens, JWTs, long hex / base64, emails and key=value secrets', () => {
    const s = redactText(
      'failed with sk-ant-api03-AbCdEf_123 Bearer abc.def.ghi token=xyz123 password: hunter2 eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig ' +
        'a'.repeat(10) + ' ' + 'f'.repeat(40) + ' owner@example.com',
    );
    for (const leaked of ['sk-ant', 'abc.def.ghi', 'xyz123', 'hunter2', 'eyJhbGci', 'f'.repeat(40), 'owner@example.com']) expect(s).not.toContain(leaked);
    expect(s).toContain('[redacted]');
    expect(s).toContain('[email]');
    expect(s).toContain('token=[redacted]');
  });

  it('keeps a URL path but never its query (search terms) or hash; data / blob URLs go entirely', () => {
    const s = redactText('GET https://medlevo.example/api/search?q=الزائدة%20الدودية#x failed; img data:image/png;base64,AAAA blob:https://x/123');
    expect(s).toContain('/api/search');
    expect(s).not.toContain('q=');
    expect(s).not.toContain('الزائدة');
    expect(s).not.toContain('AAAA');
    expect(s).toContain('[data-url]');
  });

  it('removes long quoted segments and long Arabic runs (document / note text), keeps short code messages', () => {
    const quoted = redactText(`Unexpected token in "${'The appendix is a blind-ended tube connected to the cecum'}"`);
    expect(quoted).toContain('[quoted-text]');
    expect(quoted).not.toContain('cecum');
    const arabic = redactText('خطأ: يبدأ الألم عادة حول السرة ثم ينتقل إلى الحفرة الحرقفية اليمنى عند نقطة');
    expect(arabic).toContain('[نص محذوف]');
    expect(arabic).not.toContain('الحفرة');
    expect(redactText("Cannot read properties of undefined (reading 'map')")).toBe("Cannot read properties of undefined (reading 'map')");
  });

  it('strips bidi controls and control characters, collapses whitespace and caps the length', () => {
    expect(redactText('a\u202eb\u0000c\n\n d')).toBe('ab c d');
    const long = redactText('x '.repeat(1000));
    expect(long.length).toBeLessThanOrEqual(CLIENT_ERROR_MESSAGE_MAX);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('redactStack / redactRoute / redactClientError', () => {
  it('keeps only code locations (V8 and Firefox / Safari formats), without origin or query', () => {
    const stack = [
      'TypeError: Cannot read properties of undefined (reading \'map\') — note text «سر المريض»',
      '    at QuestionList (https://medlevo.example/assets/index-abc123.js?v=2:12:345)',
      '    at https://medlevo.example/assets/vendor.js:1:2',
      'render@https://medlevo.example/assets/app.js:3:4',
      '    some random line with owner text',
    ].join('\n');
    const r = redactStack(stack)!;
    expect(r.split('\n')).toEqual(['QuestionList (/assets/index-abc123.js:12:345)', '/assets/vendor.js:1:2', 'render (/assets/app.js:3:4)']);
    expect(r).not.toContain('medlevo.example');
    expect(r).not.toContain('سر المريض');
    expect(redactStack('no frames here')).toBeNull();
    expect(redactStack(null)).toBeNull();
  });

  it('routes lose their query and hash', () => {
    expect(redactRoute('/search?q=secret#frag')).toBe('/search');
    expect(redactRoute('https://x.example/study/01ABC?page=3')).toBe('/study/01ABC');
    expect(redactRoute(null)).toBeNull();
  });

  it('normalizes an untrusted report (unknown kind → error, count clamped, app version sanitized)', () => {
    const r = redactClientError({ kind: 'weird' as never, message: '', stack: undefined, route: '/x?y=1', app_version: '0.1.0<script>', count: 99999 });
    expect(r).toEqual({ kind: 'error', message: '(no message)', stack: null, route: '/x', app_version: '0.1.0script', count: 1000 });
  });
});
