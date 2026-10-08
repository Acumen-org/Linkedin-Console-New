// Turns any JSON that LinkedIn's web app loads (Voyager REST, messaging GraphQL,
// realtime events) into normalized conversations / messages / profiles.
//
// We don't depend on endpoint names: we walk every object, recognise entities by
// their `$type` / `_type` / URN shape, and resolve normalized references
// (`"*sender": "urn:..."` → the object with that entityUrn in `included`).
// If LinkedIn renames an endpoint, extraction keeps working as long as the
// entity shapes stay similar. Shapes are adjusted in one place: this file.
/* LinkedIn's payloads are untyped external data, so `any` is used deliberately for inputs. */
import type {
  Folder,
  LiAttachment,
  LiConversation,
  LiMessage,
  LiParticipant,
  LiProfile,
  LiSeenReceipt,
  LiTyping,
} from '@linkedin-console/contracts';

type Json = any;
type Ref = (obj: Json, key: string) => Json;

const typeOf = (o: Json): string => o?.$type ?? o?._type ?? '';
const isObj = (v: unknown): v is Record<string, Json> => !!v && typeof v === 'object' && !Array.isArray(v);
const txt = (v: Json): string => (typeof v === 'string' ? v : (v?.text ?? ''));
const arr = (v: Json): Json[] => (Array.isArray(v) ? v : v == null ? [] : Array.isArray(v.elements) ? v.elements : [v]);

const PROFILE_URN_RE = /urn:li:fsd_profile:[A-Za-z0-9_-]+/;

export function profileUrnFrom(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  return v.match(PROFILE_URN_RE)?.[0] ?? null;
}

export function threadIdFromUrn(urn: unknown): string | null {
  // urn:li:msg_conversation:(urn:li:fsd_profile:SELF,2-XXXX)  →  2-XXXX
  return typeof urn === 'string' ? (urn.match(/,([^,()]+)\)$/)?.[1] ?? null) : null;
}

export function selfFromConversationUrn(urn: unknown): string | null {
  return typeof urn === 'string' ? (urn.match(/msg_conversation:\((urn:li:fsd_profile:[^,]+),/)?.[1] ?? null) : null;
}

/** Index every object that looks like an entity, merging duplicates by entityUrn. */
export function indexEntities(root: Json) {
  const byUrn = new Map<string, Json>();
  const all: Json[] = [];
  const seen = new Set<object>();
  (function walk(v: Json, depth: number) {
    if (!v || typeof v !== 'object' || depth > 60 || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    const urn = v.entityUrn;
    if (typeOf(v) || typeof urn === 'string') {
      all.push(v);
      if (typeof urn === 'string') byUrn.set(urn, byUrn.has(urn) ? { ...byUrn.get(urn), ...v } : v);
    }
    for (const k in v) walk(v[k], depth + 1);
  })(root, 0);
  return { byUrn, all };
}

function makeRef(byUrn: Map<string, Json>): Ref {
  const deref = (v: Json) => (typeof v === 'string' ? (byUrn.get(v) ?? v) : v);
  /** obj.key, or the entity referenced by obj['*key'] */
  return function ref(obj: Json, key: string) {
    if (!isObj(obj)) return undefined;
    if (obj[key] != null) return Array.isArray(obj[key]) ? obj[key].map(deref) : deref(obj[key]);
    const r = obj[`*${key}`];
    if (r == null) return undefined;
    return Array.isArray(r) ? r.map(deref) : deref(r);
  };
}

/** Best URL from a LinkedIn VectorImage-like structure anywhere inside `v`. */
export function imageUrl(v: Json, depth = 0): string | null {
  if (!v || typeof v !== 'object' || depth > 6) return null;
  if (typeof v.rootUrl === 'string' && Array.isArray(v.artifacts) && v.artifacts.length) {
    const best = [...v.artifacts].sort((a: Json, b: Json) => (b.width ?? 0) - (a.width ?? 0))[0];
    return v.rootUrl + (best.fileIdentifyingUrlPathSegment ?? '');
  }
  if (typeof v.url === 'string' && /^https?:/.test(v.url) && /image|licdn/.test(v.url)) return v.url;
  for (const k of [
    'vectorImage',
    'displayImageReference',
    'image',
    'profilePicture',
    'logo',
    'displayImage',
    'attributes',
    'detailData',
    'nonEntityProfilePicture',
    'imageReference',
  ]) {
    const r = v[k] && imageUrl(v[k], depth + 1);
    if (r) return r;
  }
  if (Array.isArray(v))
    for (const x of v) {
      const r = imageUrl(x, depth + 1);
      if (r) return r;
    }
  return null;
}

function mapParticipant(p: Json, ref: Ref): LiParticipant | null {
  if (!isObj(p)) return null;
  const pt = ref(p, 'participantType') ?? {};
  const mem = pt.member ?? pt.memberParticipantInfo;
  const org = pt.organization;
  const custom = pt.custom;
  let name = '';
  let headline = '';
  let profileUrl: string | null = null;
  let avatarUrl: string | null = null;
  if (mem) {
    name = [txt(mem.firstName), txt(mem.lastName)].filter(Boolean).join(' ');
    headline = txt(mem.headline);
    profileUrl = mem.profileUrl ?? null;
    avatarUrl = imageUrl(mem.profilePicture);
  } else if (org) {
    name = txt(org.name);
    profileUrl = org.pageUrl ?? null;
    avatarUrl = imageUrl(org.logo);
  } else if (custom) {
    name = txt(custom.name);
    avatarUrl = imageUrl(custom.image);
  }
  const urn = profileUrnFrom(p.hostIdentityUrn) ?? profileUrnFrom(p.entityUrn) ?? p.hostIdentityUrn ?? p.entityUrn ?? null;
  if (!urn) return null;
  return { urn, name: name || 'LinkedIn Member', headline, profileUrl, avatarUrl };
}

function mapRenderContent(rc: Json): LiAttachment | null {
  if (!isObj(rc)) return null;
  if (rc.vectorImage) {
    const best = [...(rc.vectorImage.artifacts ?? [])].sort((a: Json, b: Json) => (b.width ?? 0) - (a.width ?? 0))[0];
    return { kind: 'image', url: imageUrl(rc.vectorImage), width: best?.width ?? null, height: best?.height ?? null };
  }
  if (rc.file)
    return {
      kind: 'file',
      name: rc.file.name ?? 'file',
      size: rc.file.byteSize ?? null,
      mime: rc.file.mediaType ?? null,
      url: rc.file.url ?? null,
    };
  if (rc.audio) return { kind: 'audio', url: rc.audio.url ?? null, duration: rc.audio.duration ?? null };
  if (rc.video) {
    const stream = rc.video.progressiveStreams?.[0]?.streamingLocations?.[0]?.url ?? null;
    return { kind: 'video', url: stream, thumbUrl: imageUrl(rc.video.thumbnail), duration: rc.video.duration ?? null };
  }
  if (rc.externalMedia) {
    const media = rc.externalMedia.media ?? rc.externalMedia.previewMedia ?? {};
    return {
      kind: 'gif',
      url: media.url ?? null,
      title: rc.externalMedia.title ?? null,
      width: media.originalWidth ?? null,
      height: media.originalHeight ?? null,
    };
  }
  if (rc.repliedMessageContent) {
    const orig = rc.repliedMessageContent.originalMessage ?? {};
    return { kind: 'reply', text: txt(orig.body) || txt(rc.repliedMessageContent.messageBody) };
  }
  if (rc.forwardedMessageContent) return { kind: 'forward', text: txt(rc.forwardedMessageContent.forwardedBody) };
  if (rc.hostUrnData) return { kind: 'link', urn: rc.hostUrnData.hostUrn ?? null, type: rc.hostUrnData.type ?? null };
  if (rc.unavailableContent) return { kind: 'unavailable' };
  const key = Object.keys(rc).find((k) => !k.startsWith('$') && !k.startsWith('_') && rc[k] != null);
  return key ? { kind: 'unknown', key } : null;
}

function mapMessage(m: Json, ref: Ref, selfUrn: string | null): LiMessage | null {
  const urn = m.entityUrn ?? m.backendUrn;
  if (!urn) return null;
  const conv = ref(m, 'conversation');
  const conversationUrn = typeof conv === 'string' ? conv : (conv?.entityUrn ?? m.conversationUrn ?? null);
  const senderRef = ref(m, 'sender') ?? ref(m, 'actor');
  const sender = mapParticipant(senderRef, ref);
  // A reference LinkedIn didn't include ("urn:li:msg_messagingParticipant:urn:li:fsd_profile:…") still says who sent it.
  const senderUrn = sender?.urn ?? profileUrnFrom(senderRef);
  const self = selfUrn ?? selfFromConversationUrn(conversationUrn);
  return {
    urn,
    conversationUrn,
    text: txt(m.body),
    sentAt: m.deliveredAt ?? m.createdAt ?? null,
    senderUrn,
    senderName: sender?.name ?? null,
    senderAvatarUrl: sender?.avatarUrl ?? null,
    senderProfileUrl: sender?.profileUrl ?? null,
    fromSelf: !!(self && senderUrn === self),
    attachments: arr(m.renderContent)
      .map(mapRenderContent)
      .filter((a): a is LiAttachment => !!a),
    reactions: arr(m.reactionSummaries).map((r: Json) => ({ emoji: r.emoji, count: r.count ?? 1, viewerReacted: !!r.viewerReacted })),
    edited: !!m.messageBodyRenderFormat?.includes?.('EDITED'),
    deleted: m.messageBodyRenderFormat === 'RECALLED',
  };
}

function folderFromCategories(cats: string[] | undefined): Folder {
  const c = new Set(cats ?? []);
  if (c.has('ARCHIVE')) return 'archived';
  if (c.has('SPAM')) return 'spam';
  if (c.has('MESSAGE_REQUEST_PENDING') || c.has('PENDING_INVITATION')) return 'requests';
  if (c.has('INMAIL')) return 'inmail';
  if (c.has('SECONDARY_INBOX') || c.has('OTHER')) return 'other';
  return 'focused';
}

/** A real conversation entity (from the conversation list or a thread), not a reference stub. */
const isFullConversation = (c: Json) =>
  isObj(c) &&
  ['categories', 'unreadCount', 'lastActivityAt', 'read', 'conversationParticipants', '*conversationParticipants'].some((k) => k in c);

function mapConversation(c: Json, ref: Ref, selfUrn: string | null): LiConversation & { messages: LiMessage[] } {
  const urn = c.entityUrn;
  const self = selfUrn ?? selfFromConversationUrn(urn);
  const participants = arr(ref(c, 'conversationParticipants'))
    .map((p) => mapParticipant(p, ref))
    .filter((p): p is LiParticipant => !!p);
  const msgs = arr(ref(c, 'messages'))
    .filter(isObj)
    .map((m) => mapMessage(m, ref, self))
    .filter((m): m is LiMessage => !!m);
  for (const m of msgs) m.conversationUrn ??= urn;
  return {
    urn,
    threadId: threadIdFromUrn(urn),
    title: txt(c.title) || null,
    isGroup: typeof c.groupChat === 'boolean' ? c.groupChat : null,
    unreadCount: c.unreadCount == null ? null : Number(c.unreadCount),
    read: c.read ?? null,
    lastActivityAt: c.lastActivityAt ?? null,
    categories: c.categories ?? [],
    folder: Array.isArray(c.categories) ? folderFromCategories(c.categories) : null,
    participants: participants.filter((p) => p.urn !== self),
    messages: msgs,
  };
}

function mapProfile(p: Json): LiProfile | null {
  const pub = p.publicIdentifier;
  const urn = profileUrnFrom(p.entityUrn) ?? profileUrnFrom(p.dashEntityUrn) ?? profileUrnFrom(p.objectUrn);
  const name = [txt(p.firstName), txt(p.lastName)].filter(Boolean).join(' ');
  if (!urn || !pub || !name) return null;
  return {
    urn,
    publicId: pub,
    name,
    headline: txt(p.headline) || txt(p.occupation) || '',
    avatarUrl: imageUrl(p.profilePicture) ?? imageUrl(p.picture),
    profileUrl: `https://www.linkedin.com/in/${pub}/`,
  };
}

export interface Extracted {
  conversations: (LiConversation & { messages: LiMessage[] })[];
  messages: LiMessage[];
  profiles: LiProfile[];
  seen: LiSeenReceipt[];
  typing: LiTyping[];
  selfUrn: string | null;
}

export function extract(json: Json, selfUrn: string | null = null): Extracted {
  const { byUrn, all } = indexEntities(json);
  const ref = makeRef(byUrn);
  const out: Extracted = { conversations: [], messages: [], profiles: [], seen: [], typing: [], selfUrn: null };
  const msgSeen = new Set<string>();
  const convSeen = new Set<string>();
  const profSeen = new Set<string>();

  for (const o of all) {
    const t = typeOf(o);
    const urn = typeof o.entityUrn === 'string' ? o.entityUrn : '';
    if (/messenger\.Conversation$/.test(t) || (urn.startsWith('urn:li:msg_conversation:') && !t)) {
      const key = urn || JSON.stringify(o).slice(0, 200);
      if (convSeen.has(key)) continue;
      convSeen.add(key);
      const full = byUrn.get(urn) ?? o;
      // Messages carry a stub of their conversation (just the URN): that is no conversation update, and
      // mapping it would reset folder, unread count and group flag to defaults.
      if (!isFullConversation(full)) continue;
      const c = mapConversation(full, ref, selfUrn);
      if (c.urn) {
        out.conversations.push(c);
        out.selfUrn ??= selfFromConversationUrn(c.urn);
      }
    } else if (/messenger\.Message$/.test(t) || (urn.startsWith('urn:li:msg_message:') && !t)) {
      const m = mapMessage(byUrn.get(urn) ?? o, ref, selfUrn);
      if (m && !msgSeen.has(m.urn)) {
        msgSeen.add(m.urn);
        out.messages.push(m);
      }
    } else if (/SeenReceipt$/.test(t)) {
      const msg = ref(o, 'message');
      out.seen.push({
        messageUrn: typeof msg === 'string' ? msg : (msg?.entityUrn ?? null),
        seenAt: o.seenAt ?? null,
        participantUrn: profileUrnFrom(JSON.stringify(ref(o, 'seenByParticipant') ?? o.seenByParticipant ?? '')),
      });
    } else if (/TypingIndicator$/.test(t)) {
      const conv = ref(o, 'conversation');
      out.typing.push({
        conversationUrn: typeof conv === 'string' ? conv : (conv?.entityUrn ?? null),
        participantUrn: profileUrnFrom(JSON.stringify(ref(o, 'typingParticipant') ?? '')),
      });
    } else if (o.publicIdentifier && (o.firstName || o.lastName)) {
      const p = mapProfile(o);
      if (p && !profSeen.has(p.urn)) {
        profSeen.add(p.urn);
        out.profiles.push(p);
      }
    }
  }

  // Messages embedded in conversations count as messages too.
  for (const c of out.conversations)
    for (const m of c.messages)
      if (!msgSeen.has(m.urn)) {
        msgSeen.add(m.urn);
        out.messages.push(m);
      }
  return out;
}

/** Parse a Server-Sent-Events text chunk into JSON payloads. Returns [payloads, remainder]. */
export function parseSse(buffer: string): [Json[], string] {
  const payloads: Json[] = [];
  const blocks = buffer.split(/\r?\n\r?\n/);
  const rest = blocks.pop() ?? '';
  for (const block of blocks) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('\n');
    if (!data) continue;
    try {
      payloads.push(JSON.parse(data));
    } catch {}
  }
  return [payloads, rest];
}
