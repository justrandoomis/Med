// Round 7 (§58, react-hooks `recommended` lint): the shared hooks whose resets used to run in an effect after a
// commit now adjust while rendering (or keep a value with the key it belongs to). These tests pin their contracts on
// COMMITTED renders (recorded in a layout effect): the end states are the ones the screens always relied on, and no
// commit shows the stale value that the old after-commit effects left in between.
import { useLayoutEffect, useRef } from 'react';
import { act, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePresence } from '../src/design/components/presence';
import { useResizablePanel } from '../src/design/components/Sheet';
import { useLoad } from '../src/features/control/shared';
import { useQuery } from '../src/features/library/data';
import type { PaperTone } from '../src/features/workspace/ink/palette';
import { usePaperTone } from '../src/features/workspace/ink/usePaperTone';
import { setFetchImpl } from '../src/lib/api';
import { getDb } from '../src/lib/localdb';
import { useFileSrc } from '../src/lib/offline';

afterEach(async () => {
  setFetchImpl(null);
  vi.useRealTimers();
  await getDb().blobs.clear();
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('useLoad (Control Center sections)', () => {
  it('a reload shows «loading» without the old error in the very first commit, then the data', async () => {
    let fail = true;
    const fn = vi.fn(() => (fail ? Promise.reject(new Error('boom')) : Promise.resolve('ok')));
    const commits: Array<{ loading: boolean; error: string | null; data: string | null }> = [];
    const { result } = renderHook(() => {
      const r = useLoad(fn, []);
      useLayoutEffect(() => {
        commits.push({ loading: r.loading, error: r.error, data: r.data });
      });
      return r;
    });
    expect(commits[0]).toEqual({ loading: true, error: null, data: null });
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.loading).toBe(false);

    fail = false;
    commits.length = 0;
    act(() => result.current.reload());
    expect(commits[0]).toEqual({ loading: true, error: null, data: null });
    await waitFor(() => expect(result.current.data).toBe('ok'));
    expect(result.current).toMatchObject({ loading: false, error: null });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('new dependencies show «loading» at once and load again', async () => {
    const fn = vi.fn((k: string) => Promise.resolve(`data:${k}`));
    const commits: boolean[] = [];
    const { result, rerender } = renderHook(
      ({ k }) => {
        const r = useLoad(() => fn(k), [k]);
        useLayoutEffect(() => {
          commits.push(r.loading);
        });
        return r;
      },
      { initialProps: { k: 'a' } },
    );
    await waitFor(() => expect(result.current.data).toBe('data:a'));
    commits.length = 0;
    rerender({ k: 'b' });
    expect(commits[0]).toBe(true);
    await waitFor(() => expect(result.current.data).toBe('data:b'));
    expect(fn).toHaveBeenLastCalledWith('b');
  });
});

describe('useQuery (library data)', () => {
  it('a refresh shows «loading» at once and keeps the data; another path too; refresh returns a promise', async () => {
    let n = 0;
    setFetchImpl(async () => json({ n: ++n }));
    const commits: Array<{ loading: boolean; n: number | null }> = [];
    const { result, rerender } = renderHook(
      ({ path }) => {
        const q = useQuery<{ n: number }>(path);
        useLayoutEffect(() => {
          commits.push({ loading: q.loading, n: q.data?.n ?? null });
        });
        return q;
      },
      { initialProps: { path: '/library/a' as string | null } },
    );
    expect(commits[0]).toEqual({ loading: true, n: null });
    await waitFor(() => expect(result.current.data?.n).toBe(1));

    commits.length = 0;
    let done!: Promise<void>;
    act(() => {
      done = result.current.refresh();
    });
    expect(commits[0]).toEqual({ loading: true, n: 1 });
    await act(() => done);
    expect(result.current).toMatchObject({ loading: false, data: { n: 2 }, error: null });

    commits.length = 0;
    rerender({ path: '/library/b' });
    expect(commits[0]).toEqual({ loading: true, n: 2 });
    await waitFor(() => expect(result.current.data?.n).toBe(3));

    // no path: idle, and a refresh is a resolved no-op
    rerender({ path: null });
    await act(() => result.current.refresh());
    expect(n).toBe(3);
  });
});

describe('useFileSrc (stored page images)', () => {
  it('switching files never commits the previous file’s (revoked) object URL', async () => {
    let k = 0;
    const revoked: string[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:test/${++k}`);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u: string) => {
      revoked.push(u);
    });
    await getDb().blobs.put({ id: 'file:F-A', kind: 'file', mime: 'image/png', size: 3, data: new Blob([new Uint8Array([1, 2, 3])]), storedAt: Date.now() });
    const commits: Array<{ id: string; src: string | null }> = [];
    const { result, rerender } = renderHook(
      ({ id }) => {
        const src = useFileSrc(id);
        useLayoutEffect(() => {
          commits.push({ id, src });
        });
        return src;
      },
      { initialProps: { id: 'F-A' } },
    );
    await waitFor(() => expect(result.current).toBe('blob:test/1'));

    rerender({ id: 'F-B' });
    await waitFor(() => expect(result.current).toBe('/api/files/F-B'));
    expect(revoked).toEqual(['blob:test/1']);
    rerender({ id: 'F-A' });
    await waitFor(() => expect(result.current).toBe('blob:test/2'));

    const afterSwitch = commits.slice(commits.findIndex((c) => c.id === 'F-B'));
    // file B never shows A's picture; back on A the revoked first URL is never shown again
    expect(afterSwitch.filter((c) => c.id === 'F-B').every((c) => c.src === null || c.src === '/api/files/F-B')).toBe(true);
    expect(afterSwitch.some((c) => c.src === 'blob:test/1')).toBe(false);
  });
});

describe('design primitives', () => {
  it('usePresence: opening mounts in the same commit; closing keeps it mounted for the exit, then unmounts', () => {
    vi.useFakeTimers();
    const commits: Array<{ mounted: boolean; state: string }> = [];
    const { rerender } = renderHook(
      ({ open }) => {
        const p = usePresence(open, 100);
        useLayoutEffect(() => {
          commits.push(p);
        });
        return p;
      },
      { initialProps: { open: false } },
    );
    expect(commits.at(-1)).toEqual({ mounted: false, state: 'closed' });
    rerender({ open: true });
    expect(commits.at(-1)).toEqual({ mounted: true, state: 'open' });
    rerender({ open: false });
    expect(commits.at(-1)).toEqual({ mounted: true, state: 'closed' });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(commits.at(-1)).toEqual({ mounted: false, state: 'closed' });
  });

  it('useResizablePanel: a new initial width or new bounds re-clamp in the same commit', () => {
    const commits: number[] = [];
    const { result, rerender } = renderHook(
      ({ initial, max }) => {
        const p = useResizablePanel({ initial, min: 200, max, side: 'start' });
        useLayoutEffect(() => {
          commits.push(p.width);
        });
        return p;
      },
      { initialProps: { initial: 300, max: 400 } },
    );
    expect(result.current.width).toBe(300);
    commits.length = 0;
    rerender({ initial: 520, max: 400 });
    expect(commits).toEqual([400]);
    commits.length = 0;
    rerender({ initial: 520, max: 600 });
    expect(commits).toEqual([520]);
  });
});

describe('usePaperTone (ink colours on light / dark paper)', () => {
  function Probe({ onTone }: { onTone: (t: PaperTone) => void }) {
    const ref = useRef<HTMLSpanElement>(null);
    const tone = usePaperTone(ref);
    useLayoutEffect(() => {
      onTone(tone);
    });
    return <span ref={ref} />;
  }

  it('measures the paper behind the element before the first paint (it used to wait for a later render)', () => {
    const tones: PaperTone[] = [];
    render(
      <div data-ink-paper="dark">
        <Probe onTone={(t) => tones.push(t)} />
      </div>,
    );
    expect(tones.at(-1)).toBe('dark');
  });

  it('follows the theme until there is an element, like paperToneOf(null)', () => {
    const tones: PaperTone[] = [];
    render(<Probe onTone={(t) => tones.push(t)} />);
    expect(tones.at(-1)).toBe('light');
  });
});
