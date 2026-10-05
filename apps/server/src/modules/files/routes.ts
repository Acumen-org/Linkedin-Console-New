import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { accessibleAccountIds, conversationForUser } from '../../core/access.ts';
import { requireUser } from '../../core/auth.ts';
import { requestCommand } from '../../core/bridge.ts';
import { config } from '../../lib/config.ts';
import { sql } from '../../lib/db.ts';
import { HttpError } from '../../lib/errors.ts';
import { newId } from '../../lib/ids.ts';

const MAX_UPLOAD = 20 * 1024 * 1024;
const uploadsDir = () => path.join(config.filesDir, 'uploads');

function sendFile(reply: FastifyReply, file: string, mime: string, name?: string, download = false) {
  reply.header('Content-Type', mime);
  reply.header('Cache-Control', 'private, max-age=86400');
  reply.header('X-Content-Type-Options', 'nosniff');
  // Never let user-supplied HTML/SVG render inline on our origin.
  const inline = !download && /^(image\/(png|jpe?g|gif|webp)|audio\/|video\/|application\/pdf)/.test(mime);
  const safeName = (name ?? 'file').replace(/["\r\n]/g, '_');
  reply.header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${safeName}"`);
  return reply.send(fs.createReadStream(file));
}

export default async function fileRoutes(app: FastifyInstance) {
  // Upload an attachment to send later with a message.
  app.post('/api/uploads', async (req) => {
    const user = requireUser(req);
    const part = await req.file({ limits: { fileSize: MAX_UPLOAD } });
    if (!part) throw new HttpError(400, 'No file');
    await fsp.mkdir(uploadsDir(), { recursive: true });
    const id = newId('upl');
    const safe =
      path
        .basename(part.filename || 'file')
        .replace(/[^\w.\- ]/g, '_')
        .slice(0, 120) || 'file';
    const file = path.join(uploadsDir(), `${id}-${safe}`);
    await pipeline(part.file, fs.createWriteStream(file));
    if (part.file.truncated) {
      await fsp.rm(file, { force: true });
      throw new HttpError(413, 'File too large (max 20 MB)');
    }
    const { size } = await fsp.stat(file);
    const mime = part.mimetype || 'application/octet-stream';
    await sql`INSERT INTO uploads (id, user_id, path, name, mime, size) VALUES (${id}, ${user.id}, ${file}, ${safe}, ${mime}, ${size})`;
    return { id, name: safe, mime, size };
  });

  // Our own uploaded attachments (shown in sent messages).
  app.get('/api/uploads/:id', async (req, reply) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const [u] = await sql`SELECT * FROM uploads WHERE id = ${id}`;
    if (!u) throw new HttpError(404, 'Not found');
    if (u.userId !== user.id) {
      const ids = await accessibleAccountIds(user);
      const [m] = ids.length
        ? await sql`
        SELECT 1 FROM messages WHERE account_id IN ${sql(ids)} AND attachments @> ${sql.json([{ uploadId: id }] as never)} LIMIT 1`
        : [];
      if (!m) throw new HttpError(404, 'Not found');
    }
    return sendFile(reply, u.path, u.mime, u.name);
  });

  // LinkedIn attachments: downloaded once through the account's browser session, then cached.
  app.get('/api/media/:messageId/:index', async (req, reply) => {
    const user = requireUser(req);
    const { messageId, index } = req.params as { messageId: string; index: string };
    const download = (req.query as { download?: string }).download === '1';
    const [m] = await sql`SELECT id, conversation_id, account_id, attachments FROM messages WHERE id = ${messageId}`;
    if (!m) throw new HttpError(404, 'Not found');
    await conversationForUser(user, m.conversationId, 'READ');
    const i = Number(index);
    const att = m.attachments?.[i];
    if (!att) throw new HttpError(404, 'Not found');
    if (att.uploadId) return reply.redirect(`/api/uploads/${att.uploadId}`);

    if (att.cachedPath && fs.existsSync(att.cachedPath))
      return sendFile(reply, att.cachedPath, att.cachedMime ?? att.mime ?? 'application/octet-stream', att.name, download);
    if (!att.url) throw new HttpError(404, 'This attachment has no downloadable file');

    const res = await requestCommand<{ ok: boolean; path?: string; mime?: string; error?: string }>(
      m.accountId,
      { type: 'fetch_media', url: att.url },
      90,
    );
    if (!res.ok || !res.path) throw new HttpError(502, res.error ?? 'Download failed');
    if (!path.resolve(res.path).startsWith(path.resolve(config.filesDir))) throw new HttpError(500, 'Bad media path');
    await sql`
      UPDATE messages SET attachments = jsonb_set(jsonb_set(attachments, ${[String(i), 'cachedPath']}::text[], ${sql.json(res.path as never)}), ${[String(i), 'cachedMime']}::text[], ${sql.json((res.mime ?? 'application/octet-stream') as never)})
      WHERE id = ${messageId}`;
    return sendFile(reply, res.path, res.mime ?? 'application/octet-stream', att.name, download);
  });
}
