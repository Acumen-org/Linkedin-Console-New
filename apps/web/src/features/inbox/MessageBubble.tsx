import { AlertCircle, Check, CheckCheck, Clock, CornerUpLeft, Download, FileText, Link2 } from 'lucide-react';
import { useState } from 'react';
import { Avatar } from '../../components/ui';
import { formatBytes, fullTime } from '../../lib/format';
import type { Attachment, Message } from '../../types';

const mediaUrl = (m: Message, i: number, download = false) => `/api/media/${m.id}/${i}${download ? '?download=1' : ''}`;

function ImageAttachment({ m, i, a }: { m: Message; i: number; a: Attachment }) {
  // Try LinkedIn's CDN URL directly; fall back to downloading through the account's session.
  const [src, setSrc] = useState(a.uploadId ? `/api/uploads/${a.uploadId}` : (a.url ?? mediaUrl(m, i)));
  return (
    <a href={mediaUrl(m, i)} target="_blank" rel="noreferrer">
      <img
        src={src}
        onError={() => src !== mediaUrl(m, i) && setSrc(mediaUrl(m, i))}
        referrerPolicy="no-referrer"
        alt={a.name ?? 'image'}
        className="max-h-72 max-w-full rounded-lg border border-slate-200 object-contain"
        loading="lazy"
      />
    </a>
  );
}

function AttachmentView({ m, i, a, mine }: { m: Message; i: number; a: Attachment; mine: boolean }) {
  switch (a.kind) {
    case 'image':
    case 'gif':
      return <ImageAttachment m={m} i={i} a={a} />;
    case 'audio':
      return <audio controls preload="none" src={mediaUrl(m, i)} className="max-w-full" />;
    case 'video':
      return <video controls preload="none" src={mediaUrl(m, i)} className="max-h-72 max-w-full rounded-lg" />;
    case 'file':
      return (
        <a
          href={a.uploadId ? `/api/uploads/${a.uploadId}` : mediaUrl(m, i, true)}
          className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${mine ? 'border-blue-300 bg-blue-600/30 text-white' : 'border-slate-200 bg-white'}`}
        >
          <FileText size={22} />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{a.name ?? 'File'}</div>
            <div className="text-xs opacity-70">{formatBytes(a.size)}</div>
          </div>
          <Download size={16} className="ml-2" />
        </a>
      );
    case 'reply':
      return (
        <div className={`border-l-2 pl-2 text-xs italic ${mine ? 'border-blue-200 text-blue-50' : 'border-slate-300 text-slate-500'}`}>
          <CornerUpLeft size={11} className="mr-1 inline" />
          {a.text || 'Reply'}
        </div>
      );
    case 'forward':
      return <div className="text-xs italic opacity-80">Forwarded: {a.text}</div>;
    case 'link':
      return (
        <div className="flex items-center gap-1 text-xs italic opacity-80">
          <Link2 size={12} /> Shared{' '}
          {String((a as { type?: string }).type ?? 'content')
            .toLowerCase()
            .replace(/_/g, ' ')}
        </div>
      );
    case 'unavailable':
      return <div className="text-xs italic opacity-70">This content isn't available</div>;
    default:
      return null;
  }
}

export function MessageBubble({ m, showSender, isLastOutbound }: { m: Message; showSender: boolean; isLastOutbound: boolean }) {
  const mine = m.direction === 'OUTBOUND';
  const time = new Date(m.sentAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return (
    <div className={`flex gap-2 ${mine ? 'flex-row-reverse' : ''} ${showSender ? 'mt-3' : 'mt-0.5'}`}>
      <div className="w-8 shrink-0">{!mine && showSender && <Avatar name={m.senderName ?? '?'} src={m.senderAvatarUrl} size={32} />}</div>
      <div className={`flex max-w-[75%] flex-col ${mine ? 'items-end' : 'items-start'}`}>
        {showSender && !mine && <div className="mb-0.5 text-xs font-semibold text-slate-700">{m.senderName}</div>}
        <div
          title={fullTime(m.sentAt)}
          className={`flex flex-col gap-2 rounded-2xl px-3.5 py-2 text-sm ${mine ? 'rounded-tr-sm bg-brand text-white' : 'rounded-tl-sm bg-slate-100 text-slate-900'} ${m.status === 'FAILED' ? 'opacity-70 ring-2 ring-red-400' : ''}`}
        >
          {m.attachments?.map((a, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: attachments have no id and never reorder
            <AttachmentView key={i} m={m} i={i} a={a} mine={mine} />
          ))}
          {m.deleted ? (
            <span className="italic opacity-70">This message was deleted</span>
          ) : (
            m.text && <span className="whitespace-pre-wrap break-words">{m.text}</span>
          )}
        </div>
        {m.reactions?.length > 0 && (
          <div className="-mt-1 flex gap-1">
            {m.reactions.map((r) => (
              <span key={r.emoji} className="rounded-full border border-slate-200 bg-white px-1.5 text-xs shadow-sm">
                {r.emoji}
                {r.count > 1 ? ` ${r.count}` : ''}
              </span>
            ))}
          </div>
        )}
        <div className="mt-0.5 flex items-center gap-1 text-[11px] text-slate-500">
          <span>{time}</span>
          {mine && m.sentByName && <span>· sent by {m.sentByName}</span>}
          {mine && (m.status === 'QUEUED' || m.status === 'SENDING') && (
            <span className="flex items-center gap-0.5">
              <Clock size={11} /> sending
            </span>
          )}
          {mine && m.status === 'SENT' && !m.seenAt && <Check size={12} />}
          {mine && m.seenAt && isLastOutbound && (
            <span className="flex items-center gap-0.5 text-brand">
              <CheckCheck size={12} /> Seen
            </span>
          )}
          {m.status === 'FAILED' && (
            <span className="flex items-center gap-0.5 text-red-600">
              <AlertCircle size={11} /> {m.error ?? 'Failed'}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
