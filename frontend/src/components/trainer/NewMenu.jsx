/**
 * "+ NEW" -- every quick action an owner has, behind one button.
 *
 * Home used to open with eight large shortcut tiles before a single
 * number, which made the first screen a wall of buttons. They are all
 * still one tap away, here: a sheet that rises from the bottom on a phone
 * (from the "+" beside the tab bar) and opens as a dialog on a computer
 * (from the "New" button on Home). Each lands INSIDE the action -- the
 * form already open -- exactly as the tiles did (workspaceNav.js).
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import Icon from '../Icon.jsx';
import { Sheet } from '../UI.jsx';
import { quickActions, tileStyle } from './workspaceNav.js';

export default function NewMenu({ variant = 'button' }) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  const trigger = variant === 'fab' ? (
    <button type="button" className="ws-fab" onClick={() => setOpen(true)}
      aria-haspopup="dialog" aria-expanded={open} aria-label="New: add a client, record a payment and more">
      <Icon name="plus" size={26} strokeWidth={2.2} />
    </button>
  ) : (
    <button type="button" className="btn-primary ws-new-btn" onClick={() => setOpen(true)}
      aria-haspopup="dialog" aria-expanded={open}>
      <Icon name="plus" size={18} strokeWidth={2.2} />
      New
    </button>
  );

  return (
    <>
      {trigger}
      <Sheet open={open} onClose={close} title="What do you want to do?">
        <div className="ws-new-grid">
          {quickActions(true).map((a) => (
            <Link key={a.to} to={a.to} className="ws-new-item" onClick={close}>
              <span className="ws-tile" style={{ ...tileStyle(a.tint), '--s': '42px' }}>
                <Icon name={a.icon} size={19} strokeWidth={1.8} />
              </span>
              <span className="ws-new-label">{a.label}</span>
            </Link>
          ))}
        </div>
      </Sheet>
    </>
  );
}
