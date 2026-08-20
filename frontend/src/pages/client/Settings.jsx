import { useState } from 'react';
import { useAuth } from '../../auth.jsx';
import { api } from '../../api.js';
import Icon from '../../components/Icon.jsx';

const SETTINGS_SECTIONS = [
  {
    id: 'account',
    label: 'Account Information',
    icon: 'user',
    fields: [
      { key: 'name', label: 'Name', type: 'text', placeholder: 'Your full name' },
      { key: 'email', label: 'Email', type: 'email', placeholder: 'your@email.com', readOnly: true },
      { key: 'phone', label: 'Phone Number', type: 'tel', placeholder: '+91 XXXXX XXXXX' },
    ]
  },
  {
    id: 'security',
    label: 'Security',
    icon: 'lock',
    fields: [
      { key: 'current_password', label: 'Current Password', type: 'password', placeholder: '••••••••' },
      { key: 'new_password', label: 'New Password', type: 'password', placeholder: '••••••••' },
      { key: 'confirm_password', label: 'Confirm New Password', type: 'password', placeholder: '••••••••' },
    ]
  }
];

export default function Settings() {
  const { user, logout } = useAuth();
  const [toast, setToast] = useState('');
  const [formState, setFormState] = useState({
    name: user?.name || '',
    email: user?.email || '',
    phone: '',
  });
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [deleting, setDeleting] = useState(false);

  const handleSave = (section) => {
    setToast(`${section} settings saved ✓`);
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
            <span style={{ color: 'var(--accent)' }}><Icon name={section.icon} size={18} /></span>
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
          onClick={() => handleSave('Password')}
        >
          Change Password
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

      {/* DANGER ZONE */}
      <div className="card p-5" style={{ borderColor: 'rgba(248,113,113,.2)' }}>
        <div className="font-grotesk text-[10.5px] uppercase tracking-[.14em] font-semibold mb-3" style={{ color: '#FF6B6B' }}>Danger Zone</div>
        <p className="text-xs mb-4" style={{ color: 'var(--mute)' }}>Permanently delete your account and all associated data. This action cannot be undone.</p>
        <button
          onClick={() => setDeleteOpen(true)}
          className="w-full py-2.5 rounded-xl font-grotesk text-xs font-bold transition-all active:scale-[.97]"
          style={{ background: 'rgba(248,113,113,.08)', border: '1px solid rgba(248,113,113,.25)', color: '#FF6B6B' }}
        >
          Delete Account
        </button>
      </div>

      {/* Delete Account Modal */}
      {deleteOpen && (
        <div className="fixed inset-0 z-50 grid place-items-center p-4 anim-fadeIn" onClick={(e) => { if (e.target === e.currentTarget) { setDeleteOpen(false); setDeleteConfirm(''); } }} style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(12px)' }}>
          <div className="w-full max-w-sm rounded-2xl p-6 anim-scaleIn" style={{ background: 'var(--panel)', border: '1px solid var(--line)', boxShadow: 'var(--card-shadow)' }}>
            <div className="text-center mb-4">
              <div className="w-12 h-12 mx-auto rounded-full grid place-items-center text-xl mb-3" style={{ background: 'rgba(248,113,113,.1)', border: '1px solid rgba(248,113,113,.25)' }}>⚠️</div>
              <h3 className="font-grotesk font-bold text-lg" style={{ color: 'var(--ink)' }}>Delete your account?</h3>
              <p className="text-xs mt-2" style={{ color: 'var(--mute)' }}>This will permanently delete:</p>
              <ul className="text-[11px] mt-2 space-y-1 text-left max-w-xs mx-auto" style={{ color: 'var(--mute)' }}>
                <li>• Your profile and personal information</li>
                <li>• Your workout data and history</li>
                <li>• Your nutrition data and meal logs</li>
                <li>• Your progress photos and measurements</li>
                <li>• Your supplements and preferences</li>
                <li>• All other data associated with your account</li>
              </ul>
              <p className="text-[11px] mt-3 font-semibold" style={{ color: '#FF6B6B' }}>This action cannot be undone.</p>
            </div>

            <div className="mb-4">
              <label className="text-[10px] uppercase tracking-wider font-grotesk font-semibold block mb-1" style={{ color: 'var(--mute)' }}>Type DELETE to confirm</label>
              <input
                className="input"
                placeholder="DELETE"
                value={deleteConfirm}
                onChange={(e) => setDeleteConfirm(e.target.value)}
                autoFocus
              />
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => { setDeleteOpen(false); setDeleteConfirm(''); }}
                className="flex-1 py-2.5 rounded-xl font-grotesk text-xs font-semibold transition-all active:scale-95"
                style={{ background: 'var(--bg2)', border: '1px solid var(--line)', color: 'var(--mute)' }}
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  if (deleteConfirm !== 'DELETE') return;
                  setDeleting(true);
                  try {
                    await api('/me/account', { method: 'DELETE' });
                    logout();
                  } catch (e) {
                    setToast('Account deletion could not be completed. No changes were made.');
                    setDeleting(false);
                  }
                }}
                disabled={deleteConfirm !== 'DELETE' || deleting}
                className="flex-1 py-2.5 rounded-xl font-grotesk text-xs font-bold transition-all active:scale-[.97]"
                style={{
                  background: deleteConfirm === 'DELETE' && !deleting ? '#FF6B6B' : 'var(--bg2)',
                  color: deleteConfirm === 'DELETE' && !deleting ? '#fff' : 'var(--mute)',
                  opacity: deleteConfirm === 'DELETE' && !deleting ? 1 : 0.5,
                  cursor: deleteConfirm === 'DELETE' && !deleting ? 'pointer' : 'not-allowed',
                }}
              >
                {deleting ? 'Deleting…' : 'Permanently Delete Account'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
