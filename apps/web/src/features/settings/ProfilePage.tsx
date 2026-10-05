import { useState } from 'react';
import { useMe } from '../../App';
import { PageScroll } from '../../components/Layout';
import { Avatar, PageHeader } from '../../components/ui';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';

export function ProfilePage() {
  const me = useMe();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const change = async () => {
    try {
      await api.post('/api/me/password', { current, next });
      toast('Password changed', 'success');
      setCurrent('');
      setNext('');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <PageScroll>
      <PageHeader title="Your profile" />
      <div className="card mb-4 flex items-center gap-4 p-5">
        <Avatar name={me.name} size={56} />
        <div>
          <div className="text-lg font-semibold">{me.name}</div>
          <div className="text-sm text-slate-600">
            {me.email} · {me.role.toLowerCase()}
          </div>
        </div>
      </div>
      <div className="card max-w-md space-y-3 p-5">
        <h2 className="font-semibold">Change password</h2>
        <div>
          <label className="label">Current password</label>
          <input className="input" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </div>
        <div>
          <label className="label">New password (min. 10 characters)</label>
          <input className="input" type="password" value={next} onChange={(e) => setNext(e.target.value)} />
        </div>
        <button onClick={change} disabled={!current || next.length < 10} className="btn-primary">
          Change password
        </button>
      </div>
    </PageScroll>
  );
}
