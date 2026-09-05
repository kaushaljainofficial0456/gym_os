import { Component } from 'react';

// React error boundaries MUST be class components -- there is no hook
// equivalent for componentDidCatch/getDerivedStateFromError as of React 18.
//
// Without one anywhere in this app, an unexpected render error in ANY
// component (a null pointer on an unexpected API response shape, an edge
// case nobody hit in testing) white-screens the ENTIRE React tree for that
// user, with nothing but a blank page and no way back except a manual
// browser refresh. This catches it at whatever level it's mounted and
// shows a real, on-brand recovery screen instead.
//
// Deliberately minimal dependencies: this is the one component in the app
// that must keep working when something else has already gone wrong, so
// it avoids routing through api.js (whatever broke the page might also be
// upstream of that) and talks to the backend directly with a raw fetch,
// best-effort, never blocking the fallback UI on it succeeding.
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Server-side observability (see backend/src/routes/clientError.js) --
    // best-effort, fire-and-forget. Never lets a reporting failure become
    // a SECOND unhandled error on top of the one already being displayed.
    try {
      // F-05: no token to read from localStorage anymore -- the httpOnly
      // sk_token cookie (if a session exists) rides along automatically
      // via credentials: 'include', and the backend route now checks
      // that cookie too (see clientError.js's tryDecodeUser), so this
      // still enriches the report with org/user context exactly as
      // before, without ever touching localStorage.
      fetch('/api/client-error', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: String(error?.message || error).slice(0, 1000),
          path: typeof location !== 'undefined' ? location.pathname : undefined,
          component_stack: String(info?.componentStack || '').slice(0, 2000),
        }),
      }).catch(() => {});
    } catch { /* reporting must never throw on top of an already-thrown error */ }
    // Also console.error -- the one thing guaranteed to work in every
    // environment (dev tools, Vercel function logs are irrelevant here
    // since this runs in the browser, but a local dev console still helps).
    console.error('[ErrorBoundary]', error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(this.state.error, () => this.setState({ error: null }));
    return (
      <div className="min-h-[50vh] grid place-items-center px-6 py-16">
        <div className="text-center max-w-sm mx-auto">
          <div className="text-3xl mb-3" style={{ color: 'rgb(var(--warn-rgb))' }}><svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'inline-block', verticalAlign: '-0.125em' }}><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 17h.01" /></svg></div>
          <div className="font-grotesk text-sm font-bold" style={{ color: 'var(--ink)' }}>
            {this.props.title || 'Something went wrong'}
          </div>
          <div className="text-xs mt-2 leading-relaxed" style={{ color: 'var(--mute)' }}>
            {this.props.message || "This part of the page hit an unexpected error. It's been reported — try reloading."}
          </div>
          <button
            className="btn mt-5"
            onClick={() => {
              // A render crash often means something in this subtree's
              // state is genuinely broken -- a full reload is the only
              // recovery that's actually reliable, not just "try
              // re-rendering with the same bad state again".
              if (typeof location !== 'undefined') location.reload();
              else this.setState({ error: null });
            }}
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
