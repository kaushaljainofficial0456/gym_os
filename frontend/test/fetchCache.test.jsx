import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { useFetch } from '../src/utils.js';
import { setSession, clearStoredUser, readCachedResponse, writeCachedResponse, clearResponseCache } from '../src/api.js';

// A screen revisited in the same tab renders the last response it saw at
// once and refreshes it in the background -- only when it opts in with a
// key, only for the same signed-in user and gym, and never across a
// sign-out. See api.js's response cache and useFetch's `opts.key`.

function Probe({ fn, opts, deps = [], onReload }) {
  const { data, loading, reload } = useFetch(fn, deps, opts);
  if (onReload) onReload.current = reload;
  return <div data-testid="out">{loading ? 'loading' : `data:${data?.v ?? 'none'}`}</div>;
}

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

describe('useFetch with a cache key', () => {
  beforeEach(() => {
    localStorage.clear();
    clearResponseCache();
    setSession({ user: { id: 'u1', orgId: 'o1' } });
  });

  it('first visit shows loading; a revisit shows the last response at once, then the fresh one', async () => {
    const first = render(<Probe fn={() => Promise.resolve({ v: 1 })} opts={{ key: 'k' }} />);
    expect(screen.getByTestId('out').textContent).toBe('loading');
    await waitFor(() => expect(screen.getByTestId('out').textContent).toBe('data:1'));
    first.unmount();

    const fresh = deferred();
    render(<Probe fn={() => fresh.promise} opts={{ key: 'k' }} />);
    expect(screen.getByTestId('out').textContent).toBe('data:1'); // no loading flash on the revisit
    await act(async () => { fresh.resolve({ v: 2 }); });
    expect(screen.getByTestId('out').textContent).toBe('data:2');
    expect(readCachedResponse('k')).toEqual({ v: 2 });
  });

  it('without a key, behaviour is unchanged: every mount loads from nothing', async () => {
    const a = render(<Probe fn={() => Promise.resolve({ v: 1 })} />);
    await waitFor(() => expect(screen.getByTestId('out').textContent).toBe('data:1'));
    a.unmount();
    render(<Probe fn={() => new Promise(() => {})} />);
    expect(screen.getByTestId('out').textContent).toBe('loading');
  });

  it('is scoped to the signed-in user and gym', () => {
    writeCachedResponse('k', { v: 'mine' });
    setSession({ user: { id: 'u2', orgId: 'o1' } });
    expect(readCachedResponse('k')).toBeUndefined(); // another person
    setSession({ user: { id: 'u1', orgId: 'o2' } });
    expect(readCachedResponse('k')).toBeUndefined(); // same person, another gym
    setSession({ user: { id: 'u1', orgId: 'o1' } });
    expect(readCachedResponse('k')).toEqual({ v: 'mine' });
  });

  it('is emptied on sign-out, and nothing is cached while signed out', () => {
    writeCachedResponse('k', { v: 1 });
    clearStoredUser();
    setSession({ user: { id: 'u1', orgId: 'o1' } });
    expect(readCachedResponse('k')).toBeUndefined();
    clearStoredUser();
    writeCachedResponse('k', { v: 1 });
    expect(readCachedResponse('k')).toBeUndefined();
  });

  it('an explicit reload() is never answered from the cache', async () => {
    writeCachedResponse('k', { v: 1 });
    const reload = { current: null };
    let next = Promise.resolve({ v: 1 });
    render(<Probe fn={() => next} opts={{ key: 'k' }} onReload={reload} />);
    await waitFor(() => expect(screen.getByTestId('out').textContent).toBe('data:1'));
    const pending = deferred();
    next = pending.promise;
    act(() => reload.current());
    expect(screen.getByTestId('out').textContent).toBe('loading');
    await act(async () => { pending.resolve({ v: 3 }); });
    expect(screen.getByTestId('out').textContent).toBe('data:3');
  });

  it('a dependency change uses the cache for the new key when it has one', async () => {
    writeCachedResponse('p:30', { v: 30 });
    const { rerender } = render(<Probe fn={() => Promise.resolve({ v: 7 })} deps={[7]} opts={{ key: 'p:7' }} />);
    await waitFor(() => expect(screen.getByTestId('out').textContent).toBe('data:7'));
    const never = new Promise(() => {});
    rerender(<Probe fn={() => never} deps={[30]} opts={{ key: 'p:30' }} />);
    expect(screen.getByTestId('out').textContent).toBe('data:30');
  });
});
