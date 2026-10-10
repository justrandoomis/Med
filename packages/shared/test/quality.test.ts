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

  it('(review F5) «Authorization: Bearer <token>» loses the token; curly-quoted document text goes too', () => {
    const s = redactText('request failed: Authorization: Bearer abc.def.ghi1234 (retry)');
    expect(s).not.toContain('abc.def');
    expect(s).toContain('Authorization=[redacted]');
    const curly = redactText(`Unexpected value “${'The appendix is a blind-ended tube connected to the cecum'}” in ‘${'Pain usually begins in the periumbilical region and migrates'}’`);
    expect(curly).not.toContain('cecum');
    expect(curly).not.toContain('periumbilical');
    expect(curly.match(/\[quoted-text\]/g)).toHaveLength(2);
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

  it('(review F5) is linear on hostile stacks (the server redacts untrusted bodies) and keeps a code location short', () => {
    // a 15 000-space «frame» took ~28 s with the earlier pattern (catastrophic backtracking on the server's event loop)
    const hostile = [`at ${' '.repeat(15_000)}x`, `at ${' '.repeat(590)}(x`, `at a${' a'.repeat(8000)}`, `at ${'\t'.repeat(15_000)}x`].join('\n');
    const t0 = performance.now();
    expect(redactStack(hostile)).toBeNull();
    expect(performance.now() - t0).toBeLessThan(500);
    // the frames real browsers print still parse (async / new / [as alias] / Firefox)
    expect(redactStack(['    at async load (https://h/a.js:1:2)', '    at new Foo (https://h/b.js:3:4)', '    at fn [as alias] (https://h/c.js:5:6)', 'render@https://h/d.js:7:8'].join('\n'))!.split('\n')).toEqual([
      'async load (/a.js:1:2)',
      'new Foo (/b.js:3:4)',
      'fn [as alias] (/c.js:5:6)',
      'render (/d.js:7:8)',
    ]);
    // an absurdly long path keeps only its end (the file name)
    const long = redactStack(`at f (https://h/${'a'.repeat(400)}/app.js:1:2)`)!;
    expect(long.length).toBeLessThan(260);
    expect(long.endsWith('/app.js:1:2)')).toBe(true);
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
