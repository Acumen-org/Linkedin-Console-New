// Follow-up reminders ⇄ Twenty CRM tasks (with CRM_SYNC=on). Each reminder is a task on the prospect's person,
// assigned to the teammate it is for (their Twenty workspace member, from the Twenty staff list). Both ways:
//  - here → Twenty: new reminders become tasks; a moved date, new note or new responsible teammate updates
//    the task; Done or Closed here marks it done there.
//  - Twenty → here: a task marked done (or deleted) there closes the reminder; a new due date there moves it.
import { accountRoom } from '@linkedin-console/contracts';
import { closeReminder } from '../core/reminders.ts';
import { RESPONSIBLE } from '../core/reminders-sql.ts';
import { config } from '../lib/config.ts';
import { sql } from '../lib/db.ts';
import { logger } from '../lib/logger.ts';
import { publish, redis } from '../lib/redis.ts';
import { createPersonTask, findOrCreatePerson, PersonGoneError, tasksByIds, updateTask } from '../lib/twenty.ts';
import { loadConversation } from '../modules/conversations/queries.ts';
import { prospectOf } from './crm-sync.ts';

const MAX_ATTEMPTS = 6;

/** The responsible teammate's Twenty workspace member (staff linked through STAFF_SOURCE=twenty). */
const ASSIGNEE = sql`(SELECT substring(u.staff_id FROM 8) FROM users u WHERE u.id = ${RESPONSIBLE} AND u.staff_id LIKE 'twenty:%')`;

async function pushChanges() {
  const due = await sql`
    SELECT r.id, r.status, r.due_at, r.note, r.updated_at::text AS version, r.twenty_task_id, r.twenty_attempts, r.conversation_id, r.account_id,
           c.twenty_person_id, c.participants, ${ASSIGNEE} AS assignee
    FROM reminders r JOIN conversations c ON c.id = r.conversation_id
    WHERE r.twenty_attempts < ${MAX_ATTEMPTS} AND (
      (r.status = 'OPEN' AND (r.twenty_task_id IS NULL OR r.twenty_synced_at IS NULL OR r.twenty_synced_at < r.updated_at
                              OR r.twenty_assignee IS DISTINCT FROM ${ASSIGNEE}))
      OR (r.status <> 'OPEN' AND r.twenty_task_id IS NOT NULL AND (r.twenty_synced_at IS NULL OR r.twenty_synced_at < r.updated_at)))
    ORDER BY r.updated_at LIMIT 10`;
  for (const r of due) {
    try {
      const prospect = await prospectOf(r.accountId, r.participants ?? []);
      const task = {
        title: `Follow up with ${prospect.name} on LinkedIn`,
        markdown: [
          r.note || 'Follow-up reminder from LinkedIn Console.',
          config.appUrl ? `Open the conversation: ${config.appUrl}/inbox/${r.conversationId}` : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
        dueAt: r.dueAt as Date,
        assigneeId: (r.assignee as string | null) ?? null,
      };
      let taskId = r.twentyTaskId as string | null;
      if (r.status === 'OPEN') {
        if (!taskId || !(await updateTask(taskId, task))) {
          let personId = r.twentyPersonId as string | null;
          if (!personId) {
            personId = (await findOrCreatePerson(prospect)).id;
            await sql`UPDATE conversations SET twenty_person_id = ${personId} WHERE id = ${r.conversationId}`;
          }
          taskId = await createPersonTask(personId, task);
        }
      } else if (taskId) {
        await updateTask(taskId, { done: true }); // deleted there already: nothing to close
      }
      // Synced as of the version read, kept as text all the way into the database (a JS date, also the driver's own
      // conversion of a timestamp parameter, drops the microseconds: the reminder would look changed forever). A change
      // made meanwhile is picked up next time.
      await sql`
        UPDATE reminders SET twenty_task_id = ${taskId}, twenty_synced_at = (${r.version}::text)::timestamptz, twenty_assignee = ${task.assigneeId},
          twenty_attempts = 0, twenty_error = NULL
        WHERE id = ${r.id}`;
    } catch (err) {
      if (err instanceof PersonGoneError) await sql`UPDATE conversations SET twenty_person_id = NULL WHERE id = ${r.conversationId}`;
      await sql`
        UPDATE reminders SET twenty_attempts = twenty_attempts + 1, twenty_error = ${(err as Error).message.slice(0, 500)}
        WHERE id = ${r.id}`;
      if (/answered (429|5\d\d)/.test((err as Error).message)) break;
    }
  }
}

/** Done, deleted or moved in Twenty: follow it here (only reminders without a change still on its way there). */
async function pullChanges() {
  const open = await sql`
    SELECT id, twenty_task_id, due_at, conversation_id, account_id FROM reminders
    WHERE status = 'OPEN' AND twenty_task_id IS NOT NULL AND twenty_synced_at >= updated_at
    ORDER BY due_at LIMIT 500`;
  for (let i = 0; i < open.length; i += 50) {
    const batch = open.slice(i, i + 50);
    const tasks = await tasksByIds(batch.map((r) => r.twentyTaskId as string));
    for (const r of batch) {
      const t = tasks.get(r.twentyTaskId);
      if (!t || t.status === 'DONE') {
        await closeReminder({ reminderId: r.id }, 'DONE', null);
        // Already done (or gone) there: nothing to send back.
        await sql`UPDATE reminders SET twenty_synced_at = updated_at WHERE id = ${r.id}`;
        continue;
      }
      if (t.dueAt && Math.abs(Date.parse(t.dueAt) - (r.dueAt as Date).getTime()) > 60_000) {
        await sql`
          UPDATE reminders SET due_at = ${new Date(t.dueAt)}, notified_at = NULL, updated_at = now(), twenty_synced_at = now()
          WHERE id = ${r.id} AND status = 'OPEN'`;
        await publish(accountRoom(r.accountId), 'conversation.updated', await loadConversation(r.conversationId));
      }
    }
  }
}

let lastPull = 0;
/** `forcePull` reads Twenty now instead of once a minute (tests). */
export async function reminderSyncTick(opts: { forcePull?: boolean } = {}) {
  if (!config.crmSync) return;
  if (!(await redis.set('lu:remindersync:lock', '1', 'EX', 120, 'NX'))) return;
  try {
    await pushChanges();
    if (opts.forcePull || Date.now() - lastPull > 60_000) {
      lastPull = Date.now();
      await pullChanges();
    }
  } catch (err) {
    logger.error({ err }, 'reminder sync failed');
  } finally {
    await redis.del('lu:remindersync:lock');
  }
}
