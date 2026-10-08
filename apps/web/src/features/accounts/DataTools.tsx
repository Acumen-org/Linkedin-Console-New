import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Upload } from 'lucide-react';
import { useState } from 'react';
import { Modal, Popover } from '../../components/ui';
import { api, qs } from '../../lib/api';
import { toast } from '../../lib/toast';
import type { Account } from '../../types';

type ImportStatus = {
  state: 'none' | 'running' | 'done' | 'failed';
  kind?: 'connections' | 'messages' | null;
  processed?: number;
  added?: number;
  skipped?: number;
  error?: string;
};

/** Import LinkedIn's "Download my data" archive files (Connections.csv, messages.csv) into one account. */
export function ImportModal({ a, onClose }: { a: Account; onClose: () => void }) {
  const qc = useQueryClient();
  const [uploading, setUploading] = useState(false);
  const status = useQuery({
    queryKey: ['import', a.id],
    queryFn: () => api.get<ImportStatus>(`/api/accounts/${a.id}/import`),
    refetchInterval: (q) => (q.state.data?.state === 'running' || uploading ? 1500 : false),
  });
  const s = status.data;
  const upload = async (file: File) => {
    setUploading(true);
    try {
      await api.upload(`/api/accounts/${a.id}/import`, file);
      await status.refetch();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setUploading(false);
      qc.invalidateQueries({ queryKey: ['connections'] });
      qc.invalidateQueries({ queryKey: ['conversations'] });
    }
  };
  const running = uploading || s?.state === 'running';
  return (
    <Modal title={`Import LinkedIn data · ${a.label}`} onClose={onClose}>
      <div className="space-y-3 text-sm">
        <p className="text-slate-600">
          Brings in what the live sync can't see: every connection (with the date you connected) and older chat history. Nothing is
          duplicated, and importing the same file again adds nothing.
        </p>
        <ol className="list-decimal space-y-1 pl-5 text-slate-600">
          <li>
            In <b>Live LinkedIn</b>, open <b>Settings → Data privacy → Download your data</b>, choose the larger archive and request it.
          </li>
          <li>LinkedIn emails when it's ready (often within a day). Download the ZIP there and unzip it on your computer.</li>
          <li>
            Upload <b>Connections.csv</b> and <b>messages.csv</b> here, one after the other.
          </li>
        </ol>
        <label className={`btn-primary w-full justify-center ${running ? 'pointer-events-none opacity-60' : 'cursor-pointer'}`}>
          <Upload size={16} /> {running ? 'Importing…' : 'Choose Connections.csv or messages.csv'}
          <input
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            disabled={running}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) upload(f);
            }}
          />
        </label>
        {s && s.state !== 'none' && (
          <div className={`rounded-md p-3 ${s.state === 'failed' ? 'bg-red-50 text-red-700' : 'bg-slate-50 text-slate-700'}`}>
            {s.state === 'failed'
              ? s.error
              : `${s.kind === 'messages' ? 'Messages' : 'Connections'}: ${s.processed ?? 0} read · ${s.added ?? 0} added · ${s.skipped ?? 0} already there or unusable${s.state === 'done' ? ' · done' : '…'}`}
          </div>
        )}
      </div>
    </Modal>
  );
}

/** Admins: download the latest N chats (with all their stored messages) as CSV or JSON. */
export function ExportChatsMenu({ accounts }: { accounts: Account[] }) {
  const [accountId, setAccountId] = useState('');
  const [limit, setLimit] = useState(100);
  const go = (format: 'csv' | 'json') => {
    window.location.href = `/api/conversations/export${qs({ accountId, limit, format })}`;
  };
  return (
    <Popover
      width={300}
      trigger={({ toggle }) => (
        <button type="button" onClick={toggle} className="btn-outline">
          <Download size={16} /> Export chats
        </button>
      )}
    >
      {(close) => (
        <div className="space-y-3 p-3 text-sm">
          <label className="block">
            <span className="label">LinkedIn account</span>
            <select className="input" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">All accounts</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">Latest chats</span>
            <input
              className="input"
              type="number"
              min={1}
              max={5000}
              value={limit}
              onChange={(e) => setLimit(Math.max(1, Math.min(5000, Number(e.target.value) || 1)))}
            />
          </label>
          <p className="text-xs text-slate-500">
            Each chat with every message stored here. For history older than the live sync, import the account's LinkedIn data archive
            first. Exports are recorded in the audit log.
          </p>
          <div className="flex gap-2">
            {(['csv', 'json'] as const).map((f) => (
              <button
                key={f}
                type="button"
                className="btn-primary flex-1 justify-center"
                onClick={() => {
                  go(f);
                  close();
                }}
              >
                {f === 'csv' ? 'CSV (Excel)' : 'JSON'}
              </button>
            ))}
          </div>
        </div>
      )}
    </Popover>
  );
}
