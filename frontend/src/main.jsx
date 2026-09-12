import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from './auth.jsx';
import { ThemeProvider } from './themeContext.jsx';
import { UnitsProvider } from './unitsContext.jsx';
import { CookieConsentProvider } from './components/CookieConsent.jsx';
import { ErrorBoundary } from './components/ErrorBoundary.jsx';
import App from './App.jsx';
import './theme.css';

// Apply dark class immediately to prevent flash
const stored = localStorage.getItem('sk-os-theme');
document.documentElement.classList.add(stored === 'light' ? 'light' : 'dark');

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <ThemeProvider>
          {/* Inside AuthProvider because it reads the signed-in user's own
              profile; outside the router so one fetch serves every page
              and no two screens can disagree about which unit they are
              in. */}
          <UnitsProvider>
          {/* Outermost safety net -- catches a crash anywhere App.jsx's own
              routing/layout logic hits, on top of the per-page boundaries
              inside it (see App.jsx's page() helper) which handle the far
              more common case of one page's own render logic breaking. */}
          <CookieConsentProvider>
          <ErrorBoundary title="Barbell hit an unexpected error" message="The app ran into a problem it couldn't recover from on its own. It's been reported — try reloading.">
            <App />
          </ErrorBoundary>
          </CookieConsentProvider>
          </UnitsProvider>
        </ThemeProvider>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
);
