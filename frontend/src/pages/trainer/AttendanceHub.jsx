/**
 * ATTENDANCE (owner) -- members and trainers, one place.
 *
 * "Attendance" used to mean trainers only, while marking MEMBERS in sat in
 * a card on the Payments page. Home's "Check-ins today" tile counted
 * members and then opened the trainer roster. Both now live here, as tabs;
 * ?tab=trainers opens the second (Home's "trainers have not checked in").
 */
import { useState } from 'react';
import { Seg } from '../../components/UI.jsx';
import MemberCheckins from '../../components/trainer/MemberCheckins.jsx';
import { useQueryAction } from '../../components/trainer/useQueryAction.js';
import GymAttendance from './GymAttendance.jsx';

export default function AttendanceHub() {
  const [tab, setTab] = useState('members');
  useQueryAction('tab', (v) => { if (v === 'trainers' || v === 'members') setTab(v); });
  return (
    <div className="space-y-5">
      <h1 className="t-title">Attendance</h1>
      <div className="max-w-sm">
        <Seg options={[{ value: 'members', label: 'Members' }, { value: 'trainers', label: 'Trainers' }]} value={tab} onChange={setTab} />
      </div>
      {tab === 'members' ? <MemberCheckins /> : <GymAttendance embedded />}
    </div>
  );
}
