import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import { io, type Socket } from 'socket.io-client';
import type { Conversation, Message, Note } from '../types';
import { toast } from './toast';

let socket: Socket | null = null;
export const getSocket = () => socket;

type Listener = (e: { type: string; data: any }) => void;
const listeners = new Set<Listener>();
export function onRealtime(fn: Listener) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function upsertMessage(list: Message[] | undefined, m: Message) {
  if (!list) return list;
  const i = list.findIndex((x) => x.id === m.id || (m.clientId && x.clientId === m.clientId));
  if (i === -1) return [...list, m].sort((a, b) => a.sentAt.localeCompare(b.sentAt));
  const copy = [...list];
  copy[i] = { ...copy[i], ...m };
  return copy;
}

/**
 * Collects list refreshes for a moment and runs them once: a sync touching 40 conversations, or a teammate
 * typing, must not make every open browser refetch its lists 40 times.
 */
function batchedInvalidate(qc: QueryClient, delayMs = 1500) {
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (key: string) => {
    pending.add(key);
    if (timer) return; // a refresh is already scheduled and will include this key
    timer = setTimeout(() => {
      for (const k of pending) qc.invalidateQueries({ queryKey: [k] }, { cancelRefetch: false });
      pending.clear();
      timer = null;
    }, delayMs);
  };
}

export function connectRealtime(qc: QueryClient, onSignedOut: () => void) {
  if (socket) return socket;
  socket = io({ path: '/socket.io', transports: ['websocket', 'polling'] });
  const refresh = batchedInvalidate(qc);
  let connectedBefore = false;
  const emit = (type: string, data: any) => {
    for (const l of listeners) l({ type, data });
  };

  socket.on('disconnect', (reason) => {
    // Server kicks us when our permissions change; reconnect to join the right rooms.
    if (reason === 'io server disconnect') setTimeout(() => socket?.connect(), 800);
  });
  socket.on('connect', () => {
    qc.invalidateQueries({ queryKey: ['accounts'] });
    // Back after a restart, deploy or network drop: events sent meanwhile were missed, so reload what's open.
    if (connectedBefore) for (const k of ['conversations', 'conversation', 'messages', 'notes']) qc.invalidateQueries({ queryKey: [k] });
    connectedBefore = true;
  });
  // The session expired or was revoked: show the sign-in page instead of a silently dead app.
  socket.on('connect_error', (err) => {
    if (err.message === 'unauthorized') onSignedOut();
  });

  socket.on('conversation.updated', (c: Conversation) => {
    // Conversation lists are paged (infinite queries): patch in place, refetch if it moved to the top.
    let movedOrNew = true;
    qc.setQueriesData<InfiniteData<Conversation[]>>({ queryKey: ['conversations'] }, (data) => {
      if (!data) return data;
      const pages = data.pages.map((page) =>
        page.map((x) => {
          if (x.id !== c.id) return x;
          if (x.lastMessageAt === c.lastMessageAt) movedOrNew = false;
          return { ...x, ...c };
        }),
      );
      return { ...data, pages };
    });
    if (movedOrNew) refresh('conversations');
    qc.setQueryData<Conversation>(['conversation', c.id], (old) => (old ? { ...old, ...c } : old));
    refresh('accounts'); // unread badges
  });

  const onMessage = (m: Message) => {
    qc.setQueryData<Message[]>(['messages', m.conversationId], (list) => upsertMessage(list, m));
    emit('message', m);
  };
  socket.on('message.created', onMessage);
  socket.on('message.updated', onMessage);
  socket.on('message.deleted', (m: { id: string; conversationId: string }) => {
    qc.setQueryData<Message[]>(['messages', m.conversationId], (list) => list?.filter((x) => x.id !== m.id));
  });

  socket.on('note.created', (n: Note & { conversationId: string }) => {
    qc.setQueryData<Note[]>(['notes', n.conversationId], (list) => (list && !list.some((x) => x.id === n.id) ? [...list, n] : list));
  });
  socket.on('account.updated', () => qc.invalidateQueries({ queryKey: ['accounts'] }));
  socket.on('account.deleted', () => {
    qc.invalidateQueries({ queryKey: ['accounts'] });
    qc.invalidateQueries({ queryKey: ['conversations'] });
  });
  socket.on('labels.changed', () => qc.invalidateQueries({ queryKey: ['labels'] }));
  socket.on('connections.updated', (d) => qc.invalidateQueries({ queryKey: ['connections', d.accountId] }));
  socket.on('linkedin.typing', (d) => emit('linkedin.typing', d));
  socket.on('team.composing', (d) => emit('team.composing', d));
  socket.on('command.failed', (d) => toast(`LinkedIn action failed: ${d.error ?? 'unknown error'}`, 'error'));
  socket.on('command.ok', (d) => {
    if (d.type === 'start_chat') toast('Message sent', 'success');
  });
  return socket;
}

export function disconnectRealtime() {
  socket?.disconnect();
  socket = null;
}
