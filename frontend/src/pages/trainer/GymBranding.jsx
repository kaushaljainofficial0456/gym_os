/**
 * BRANDING -- the owner's page for their gym's own look: two colours, a
 * logo, and the gym's join link, which opens a sign-up screen already in
 * the gym's colours with its code filled in. The same studio the owner
 * met during setup (brand/BrandStudio.jsx).
 */
import { useState } from 'react';
import { Copy, Link2, Share2 } from 'lucide-react';
import { useAuth } from '../../auth.jsx';
import { useBrand } from '../../brand/BrandProvider.jsx';
import BrandStudio from '../../brand/BrandStudio.jsx';
import GymLockup from '../../brand/GymLockup.jsx';
import { Card, PageHeader, Toast } from '../../components/UI.jsx';

export default function GymBranding() {
  const { user } = useAuth();
  const { brand } = useBrand();
  const [toast, setToast] = useState('');
  const code = brand?.code || user?.orgSlug || user?.org_slug || null;
  const link = code ? `${window.location.origin}/g/${encodeURIComponent(code)}` : null;
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  const copy = async () => {
    try { await navigator.clipboard.writeText(link); setToast('Link copied'); } catch { setToast('Could not copy — press and hold the link to copy it'); }
  };
  const share = async () => {
    try {
      await navigator.share({ title: `${brand?.gymName || 'Our gym'} × Barbell`, text: `Join ${brand?.gymName || 'our gym'} on the app`, url: link });
    } catch { /* closed the share sheet */ }
  };

  return (
    <div className="space-y-6 pb-6">
      <PageHeader eyebrow="Your gym" title="Branding"
        sub="Your gym’s colours and logo. Your members, trainers and you see the app in them, with your gym’s name on top." />

      <Card className="p-5 sm:p-7">
        {/* Remounted on save (a new version), so it starts from what was saved. */}
        <BrandStudio key={brand?.version || 'none'} initial={brand} gymName={user?.orgName} layout="split" saveLabel="Save"
          onSaved={() => setToast('Saved. Your gym’s app is updated.')} />
      </Card>

      {link && (
        <Card className="p-5 sm:p-6">
          <div className="flex items-start gap-4 flex-wrap">
            <div className="min-w-0 flex-1">
              <h2 className="ws-section-title flex items-center gap-2"><Link2 size={17} strokeWidth={2} aria-hidden="true" />Your gym’s join link</h2>
              <p className="text-[13.5px] mt-1.5" style={{ color: 'var(--mute)' }}>
                Send it on WhatsApp or put it in your bio. It opens sign-up in your gym’s colours with your gym code already filled in.
              </p>
              <div className="mt-3 flex items-center gap-2 flex-wrap">
                <code className="text-[14px] font-semibold px-3 py-2 rounded-xl break-all" style={{ background: 'rgb(var(--tint-rgb) / .06)', color: 'var(--ink)', border: '1px solid var(--line)' }}>{link}</code>
              </div>
              <div className="mt-3 flex gap-2 flex-wrap">
                <button type="button" className="btn btn-sm" onClick={copy}><Copy size={15} strokeWidth={2} aria-hidden="true" />Copy link</button>
                {canShare && <button type="button" className="btn btn-sm" onClick={share}><Share2 size={15} strokeWidth={2} aria-hidden="true" />Share</button>}
              </div>
            </div>
            {brand && (
              <div className="hidden sm:flex flex-col items-center gap-2 px-5 py-4 rounded-2xl" style={{ background: 'var(--bg2)', border: '1px solid var(--line)' }}>
                <GymLockup brand={brand} variant="stack" markSize={40} />
                <span className="text-[11.5px]" style={{ color: 'var(--faint)' }}>Gym code · {code}</span>
              </div>
            )}
          </div>
        </Card>
      )}

      <Toast message={toast} onDone={() => setToast('')} tone={toast.startsWith('Could not') ? 'error' : 'success'} />
    </div>
  );
}
