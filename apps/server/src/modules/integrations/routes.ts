// Admin-only settings for the Twenty CRM + staff-sync integration (Settings → Integrations in the console). Reads
// and writes the DB-backed overrides in lib/integrations.ts (secrets encrypted), plus actions: test the Twenty
// connection, set up/verify the Twenty data model, and sync now. Everything here requires an admin.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../core/audit.ts';
import { requireAdmin } from '../../core/auth.ts';
import { lastStaffSync, runStaffSync } from '../../core/staff-sync.ts';
import { HttpError } from '../../lib/errors.ts';
import { currentIntegrations, IntegrationError, type IntegrationUpdate, saveIntegrations } from '../../lib/integrations.ts';
import { workspaceMembers } from '../../lib/twenty.ts';
import { syncTwentyFields } from '../../lib/twenty-fields.ts';
import { crmSyncStatus, crmSyncTick } from '../../worker/crm-sync.ts';

const Update = z.object({
  crmSync: z.boolean().optional(),
  crmAutoCreate: z.boolean().optional(),
  crmFuzzyBind: z.boolean().optional(),
  twenty: z
    .object({
      url: z.string().optional(),
      apiKey: z.string().optional(),
      webUrl: z.string().optional(),
      ownerField: z.string().optional(),
      podField: z.string().optional(),
      disable: z.boolean().optional(),
    })
    .optional(),
  microsoft: z
    .object({
      tenantId: z.string().optional(),
      clientId: z.string().optional(),
      clientSecret: z.string().optional(),
      disable: z.boolean().optional(),
    })
    .optional(),
  staffSync: z
    .object({
      mode: z.enum(['off', 'disable', 'provision']).optional(),
      source: z.enum(['twilio', 'twenty']).optional(),
    })
    .optional(),
});

export default async function integrationRoutes(app: FastifyInstance) {
  // Current settings (secrets masked) plus CRM and staff-sync status.
  app.get('/api/integrations', async (req) => {
    requireAdmin(req);
    const [crm, staff] = await Promise.all([crmSyncStatus(), lastStaffSync()]);
    return { settings: currentIntegrations(), crm, staff };
  });

  // Save a change. IntegrationError (e.g. a bad URL, or a secret without CREDENTIALS_KEY) becomes a 400.
  app.put('/api/integrations', async (req) => {
    const admin = requireAdmin(req);
    const update = Update.parse(req.body ?? {}) as IntegrationUpdate;
    try {
      const settings = await saveIntegrations(update);
      await audit({
        action: 'integrations.updated',
        meta: {
          by: admin.id,
          // Never log secret values: only which parts of the config were touched.
          changed: Object.keys(update),
          crmSync: settings.crmSync,
          crmAutoCreate: settings.crmAutoCreate,
          twenty: !!settings.twenty,
          staffMode: settings.staffSync.mode,
        },
      });
      return settings;
    } catch (err) {
      if (err instanceof IntegrationError) throw new HttpError(400, err.message);
      throw err;
    }
  });

  // Test the Twenty connection by reading the workspace members.
  app.post('/api/integrations/test', async (req) => {
    requireAdmin(req);
    try {
      const members = await workspaceMembers();
      return { ok: true, members: members.length };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // Check (apply=false) or add (apply=true) the Twenty Person fields + LinkedIn conversation object.
  app.post('/api/integrations/fields', async (req) => {
    requireAdmin(req);
    const { apply } = z.object({ apply: z.boolean().default(false) }).parse(req.body ?? {});
    try {
      const report = await syncTwentyFields(apply);
      if (apply)
        await audit({ action: 'integrations.fields_applied', meta: { added: report.items.filter((i) => i.status === 'added').length } });
      return { ok: true, ...report };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // Run the CRM and staff syncs now instead of waiting for the schedule.
  app.post('/api/integrations/sync', async (req) => {
    requireAdmin(req);
    const crm = await crmSyncTick().catch((e: Error) => ({ ok: false, error: e.message }));
    const staff = await runStaffSync().catch((e: Error) => ({ ok: false, error: e.message }));
    return { crm, staff };
  });
}
