import { useState } from 'react';
import { useAuth } from '../../auth.jsx';
import { api } from '../../api.js';

const SETTINGS_SECTIONS = [
  {
    id: 'account',
    label: 'Account Information',
    icon: '👤',
    fields: [
      { key: 'name', label: 'Name', type: 'text', placeholder: 'Your full name' },
      { key: 'email', label: 'Email', type: 'email', placeholder: 'your@email.com', readOnly: true },
      { key: 'phone', label: 'Phone Number', type: 'tel', placeholder: '+91 XXXXX XXXXX' },
    ]
  },
  {
    id: 'security',
    label: 'Security',
    icon: '🔒',
    fields: [
      { key: 'current_password', label: 'Current Password', type: 'password', placeholder: '••••••••' },
      { key: 'new_password', label: 'New Password', type: 'password', placeholder: '••••••••' },
      { key: 'confirm_password', label: 'Confirm New Password', type: 'password', placeholder: '••••••••' },
    ]
  }
];

export default function Settings() {
  const { user } = useAuth();
  const [toast, setToast] = useState('');
  const [formState, setFormState] = useState({
    name: user?.name || '',
    email: user?.email || '',
    phone: '',
  });

  const [busy, setBusy] = useState(false);

  const handleSave = async (section) => {
    if (section === 'Account Information') {
      setBusy(true);
      try {
        await api('/me/profile', { method: 'PUT', body: JSON.stringify({ name: formState.name }) });
        setToast('Account information saved ✓');
      } catch (e) { setToast(e.message || 'Save failed'); }
      setBusy(false);
    } else {
      setToast(`${section} settings saved ✓`);
    }
    setTimeout(() => setToast(''), 2400);
  };

  const handlePassword = async () => {
    if (!formState.current_password || !formState.new_password) {
      setToast('Please fill in both password fields');
      return;
    }
    if (formState.new_password !== formState.confirm_password) {
      setToast('New passwords do not match');
      return;
    }
    if (formState.new_password.length < 6) {
      setToast('New password must be at least 6 characters');
      return;
    }
    setBusy(true);
    try {
      await api('/auth/change-password', { method: 'POST', body: JSON.stringify({ current_password: formState.current_password, new_password: formState.new_password }) });
      setToast('Password changed successfully ✓');
      setFormState(s => ({ ...s, current_password: '', new_password: '', confirm_password: '' }));
    } catch (e) { setToast(e.message || 'Password change failed'); }
    setBusy(false);
    setTimeout(() => setToast(''), 2400);
  };

  return (
    <div className="space-y-5">
      {toast && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 rounded-xl border border-gold/40 px-4 py-2 text-sm shadow-card anim-fadeUp"
          style={{ background: 'var(--panel)', color: 'var(--ink)' }}>
          {toast}
        </div>
      )}

      <div>
        <h1 className="font-display font-bold text-2xl tracking-tight" style={{ color: 'var(--ink)' }}>Settings</h1>
        <div className="text-xs mt-0.5" style={{ color: 'var(--mute)' }}>Manage your account and preferences</div>
      </div>

      {SETTINGS_SECTIONS.map((section) => (
        <div key={section.id} className="card p-5">
          <div className="flex items-center gap-2.5 mb-4">
            <span className="text-lg">{section.icon}</span>
            <span className="font-grotesk font-bold text-sm" style={{ color: 'var(--ink)' }}>{section.label}</span>
          </div>

          <div className="space-y-3">
            {section.fields.map((field) => (
              <label key={field.key} className="block">
                <span className="text-[10.5px] font-grotesk uppercase tracking-wider font-medium" style={{ color: 'var(--faint)' }}>{field.label}</span>
                <input
                  type={field.type}
                  className="input mt-1"
                  placeholder={field.placeholder}
                  value={formState[field.key] || ''}
                  readOnly={field.readOnly}
                  onChange={(e) => setFormState((s) => ({ ...s, [field.key]: e.target.value }))}
                />
                {field.readOnly && (
                  <span className="text-[9px] mt-0.5 block" style={{ color: 'var(--faint)' }}>This field cannot be changed here</span>
                )}
              </label>
            ))}
          </div>

          {section.id !== 'security' && (
            <button
              className="btn-primary w-full mt-4"
              onClick={() => handleSave(section.label)}
            >
              Save {section.label}
            </button>
          )}
        </div>
      ))}

      <div className="card p-5">
        <button
          className="btn-primary w-full"
          onClick={handlePassword}
          disabled={busy}
        >
          {busy ? 'Saving...' : 'Change Password'}
        </button>
        <div className="text-[9px] mt-2 text-center" style={{ color: 'var(--faint)' }}>
          Password changes require your current password for verification
        </div>
      </div>

      <div className="card p-5">
        <div className="font-grotesk text-[10.5px] uppercase tracking-[.14em] font-medium mb-3" style={{ color: 'var(--mute)' }}>Account Details</div>
        <div className="space-y-2.5">
          <div className="flex justify-between items-center text-sm">
            <span style={{ color: 'var(--mute)' }}>Account type</span>
            <span className="font-grotesk font-semibold" style={{ color: 'var(--ink)' }}>Client</span>
          </div>
          <div className="flex justify-between items-center text-sm">
            <span style={{ color: 'var(--mute)' }}>Status</span>
            <span className="chip border-good/40 text-good !text-[10px]">Active</span>
          </div>
        </div>
      </div>
    </div>
  );
}
