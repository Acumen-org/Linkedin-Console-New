/** Socket.IO events between the api and browsers. */
import type { Account, Conversation, Message, Note } from './api.js';

export interface ServerToClientEvents {
  'conversation.updated': (c: Conversation) => void;
  'message.created': (m: Message) => void;
  'message.updated': (m: Message) => void;
  'note.created': (n: Note & { conversationId: string }) => void;
  'account.updated': (a: Partial<Account> & { id: string }) => void;
  'account.deleted': (a: { id: string }) => void;
  'connections.updated': (d: { accountId: string; count: number }) => void;
  'linkedin.typing': (d: { conversationId: string; name: string }) => void;
  'team.composing': (d: { conversationId: string; userId: string; name: string; active: boolean }) => void;
  'command.failed': (d: { type: string; error?: string; accountId: string }) => void;
  'command.ok': (d: { type: string; accountId: string }) => void;
  'grants.changed': (d: Record<string, never>) => void;
  'labels.changed': (d: Record<string, never>) => void;
}

export interface ClientToServerEvents {
  composing: (d: { conversationId: string; active: boolean }) => void;
}

export type RealtimeEvent = keyof ServerToClientEvents;
export const REALTIME_CHANNEL = 'lu:emit';
export const accountRoom = (accountId: string) => `acc:${accountId}`;
export const userRoom = (userId: string) => `user:${userId}`;
export const ADMINS_ROOM = 'admins';
export const EVERYONE_ROOM = 'everyone';
