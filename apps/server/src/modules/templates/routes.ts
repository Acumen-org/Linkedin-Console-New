import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../../core/auth.ts';
import { sql } from '../../lib/db.ts';
import { forbidden, notFound } from '../../lib/errors.ts';
import { newId } from '../../lib/ids.ts';

const Template = z.object({
  title: z.string().trim().min(1).max(80),
  body: z.string().min(1).max(8000),
  shared: z.boolean().default(true),
});

/**
 * Saved replies. Shared templates are visible to the whole team; private ones only to their author.
 * Variables like {firstName}, {name}, {myName}, {myFirstName} are filled in by the web app.
 */
export default async function templateRoutes(app: FastifyInstance) {
  app.get('/api/templates', async (req) => {
    const user = requireUser(req);
    return sql`
      SELECT t.id, t.title, t.body, t.shared, t.user_id, u.name AS user_name
      FROM templates t JOIN users u ON u.id = t.user_id
      WHERE t.shared OR t.user_id = ${user.id}
      ORDER BY t.title`;
  });

  app.post('/api/templates', async (req) => {
    const user = requireUser(req);
    const body = Template.parse(req.body);
    const id = newId('tpl');
    await sql`INSERT INTO templates (id, user_id, title, body, shared) VALUES (${id}, ${user.id}, ${body.title}, ${body.body}, ${body.shared})`;
    return { id, userId: user.id, userName: user.name, ...body };
  });

  app.put<{ Params: { id: string } }>('/api/templates/:id', async (req) => {
    const user = requireUser(req);
    const [t] = await sql`SELECT user_id FROM templates WHERE id = ${req.params.id}`;
    if (!t) throw notFound();
    if (t.userId !== user.id && user.role === 'MEMBER') throw forbidden('Only the author or an admin can edit this template');
    const body = Template.parse(req.body);
    await sql`UPDATE templates SET title = ${body.title}, body = ${body.body}, shared = ${body.shared} WHERE id = ${req.params.id}`;
    return { id: req.params.id, ...body };
  });

  app.delete<{ Params: { id: string } }>('/api/templates/:id', async (req) => {
    const user = requireUser(req);
    const [t] = await sql`SELECT user_id FROM templates WHERE id = ${req.params.id}`;
    if (!t) throw notFound();
    if (t.userId !== user.id && user.role === 'MEMBER') throw forbidden('Only the author or an admin can delete this template');
    await sql`DELETE FROM templates WHERE id = ${req.params.id}`;
    return { ok: true };
  });
}
