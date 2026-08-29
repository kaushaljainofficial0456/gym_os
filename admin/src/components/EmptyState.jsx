import Icon from './Icon.jsx';

export default function EmptyState({ icon = 'inbox', title, description }) {
  return (
    <div className="empty-block anim-fadeIn">
      <div className="empty-icon"><Icon name={icon} size={30} strokeWidth={1.4} /></div>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
    </div>
  );
}
