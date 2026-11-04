import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { api } from '../src/api.js';
import { AuthProvider, useAuth } from '../src/auth.jsx';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('api(): a server that does not answer cleanly', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('sends a read once more after a host hiccup, and returns the answer', async () => {
    fetch.mockResolvedValueOnce(json(503, {})).mockResolvedValueOnce(json(200, { ok: 1 }));
    await expect(api('/thing')).resolves.toEqual({ ok: 1 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('never sends a write twice: the first may have landed', async () => {
    fetch.mockResolvedValue(json(503, { error: 'Service unavailable' }));
    await expect(api('/thing', { method: 'POST', body: '{}' })).rejects.toMatchObject({ status: 503 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('gives up on a request that never answers, instead of loading forever', async () => {
    fetch.mockImplementation((_url, { signal }) => new Promise((_res, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const err = await api('/slow', { timeoutMs: 20 }).catch((e) => e);
    expect(err.network).toBe(true);
    expect(err.message).toMatch(/taking too long/);
    expect(fetch).toHaveBeenCalledTimes(2); // a read gets its one retry first
  });

  it('leaves a caller that cancelled alone', async () => {
    const ctrl = new AbortController();
    fetch.mockImplementation((_url, { signal }) => new Promise((_res, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const pending = api('/slow', { signal: ctrl.signal }).catch((e) => e);
    ctrl.abort();
    const err = await pending;
    expect(err.name).toBe('AbortError');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('opening the app: who is signed in', () => {
  const user = { id: 'usr_1', role: 'CLIENT', name: 'Asha' };
  function Who() {
    const { user: u, ready } = useAuth();
    return <div>{ready ? (u ? `in:${u.name}` : 'out') : 'checking'}</div>;
  }
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    localStorage.setItem('pos_user', JSON.stringify(user));
  });
  afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

  it('keeps a signed-in person in when the server is only failing', async () => {
    fetch.mockResolvedValue(json(500, { error: 'Internal server error' }));
    render(<AuthProvider><Who /></AuthProvider>);
    await waitFor(() => expect(screen.getByText('in:Asha')).toBeTruthy(), { timeout: 6000 });
    expect(fetch.mock.calls.filter(([u]) => u === '/api/auth/me')).toHaveLength(3);
  }, 10000);

  it('signs out only when the server says there is no session', async () => {
    fetch.mockImplementation((url) => Promise.resolve(url === '/api/auth/me' ? json(401, { error: 'Authentication required' }) : json(200, {})));
    render(<AuthProvider><Who /></AuthProvider>);
    await waitFor(() => expect(screen.getByText('out')).toBeTruthy());
    expect(localStorage.getItem('pos_user')).toBeNull();
  });

  it('lets the person in once a retry gets through', async () => {
    fetch.mockResolvedValueOnce(json(500, {})).mockResolvedValue(json(200, { user: { ...user, name: 'Asha K' } }));
    render(<AuthProvider><Who /></AuthProvider>);
    await waitFor(() => expect(screen.getByText('in:Asha K')).toBeTruthy(), { timeout: 4000 });
  }, 8000);
});
