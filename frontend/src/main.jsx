import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from './auth.jsx';
import { ThemeProvider } from './themeContext.jsx';
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
          <App />
        </ThemeProvider>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
);
