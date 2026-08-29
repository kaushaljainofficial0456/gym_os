const TONE = { LOW: 'priority-low', MEDIUM: 'priority-medium', HIGH: 'priority-high', URGENT: 'priority-urgent' };

export default function PriorityBadge({ priority }) {
  return <span className={`badge ${TONE[priority] || 'mute'}`}>{priority || 'UNKNOWN'}</span>;
}
