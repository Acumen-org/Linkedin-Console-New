# Deploying to Nomad (worker-7)

`main` is deployed to the Nomad job **linkedin-console-new** by GitHub Actions (`.github/workflows/deploy.yml`) after CI passed:

1. The images are built on GitHub's runners and pushed to Harbor (`linkedin-outreach/worker`, `frontend`, `sidecar`, `chrome`, `pod-agent`), tagged with the commit.
2. `nomad job run -var tag=<commit> deploy/nomad/linkedin-console-new.nomad.hcl` replaces the app. Nomad waits until `/api/health` answers; if it doesn't, it **goes back to the previous version by itself** (`auto_revert`).
3. The account browsers then move to the new Chrome and bridge images by themselves, two per minute, keeping their LinkedIn sessions. The new image is downloaded before an old browser is removed, so a failed download leaves the account running as it was (the Accounts page shows "Update failed: …", retried every 15 minutes).

It can also be started by hand: GitHub → Actions → Deploy → Run workflow.

## One-time setup

### 1. Harbor robot accounts

In Harbor → project `linkedin-outreach` → Robot accounts:

- **ci-deploy**: push and pull. For GitHub.
- **worker-7**: pull only. For the node.

### 2. worker-7 pulls from Harbor

As root on worker-7 (the password is typed, not stored in any file of this repo):

```bash
sudo docker login h4rb0r.acm.acumen-strategy.com -u 'robot$linkedin-outreach+worker-7'
```

This writes `/root/.docker/config.json`. Check it has an `"auth"` entry for the registry and no `"credsStore"` (a credential helper keeps the password elsewhere, where neither Nomad nor the pod-agent can read it).

Then let Nomad's Docker driver use that login, in the Nomad **client** configuration of worker-7 (e.g. `/etc/nomad.d/client.hcl`), and restart the Nomad client:

```hcl
plugin "docker" {
  config {
    auth {
      config = "/root/.docker/config.json"
    }
    volumes {
      enabled = true # already needed for the Docker socket mount
    }
  }
}
```

The job also mounts that file read-only into the pod-agent (`REGISTRY_AUTH_FILE`), which uses it to pull the browser images for new and updated account pods. A different path: `-var registry_auth_file=/path` (and in the plugin config).

### 3. A Nomad token for CI

With a management token:

```bash
nomad acl policy apply -description "LinkedIn Console CI deploy" linkedin-console-deploy deploy/nomad/ci-deploy-policy.hcl
nomad acl token create -name "github-linkedin-console-deploy" -policy linkedin-console-deploy -type client
```

The policy allows planning, running and watching jobs in the default namespace, nothing else: no ACL, node, operator or variable access.

### 4. GitHub secrets

Repository → Settings → Environments → **production** (add required reviewers there if a deploy should wait for someone's approval) → secrets:

| Secret | Value |
|---|---|
| `HARBOR_USERNAME` / `HARBOR_PASSWORD` | the **ci-deploy** robot account |
| `NOMAD_ADDR` | `https://n0m4d.pmx.acumen-strategy.com` |
| `NOMAD_TOKEN` | the token's **Secret ID** from step 3 |

Optional repository variable `NOMAD_VERSION`: the Nomad CLI version to use (default 1.10.5; close to the cluster's is best).

### 5. Settings of the app

The app's settings are the Nomad variable `nomad/jobs/linkedin-console-new` (every key becomes an environment variable of the api and the worker). Settings added since the LinkUnify days, when used:

| Key | For |
|---|---|
| `APP_URL` | the public https address (Microsoft sign-in, links in Twenty and emails) |
| `MICROSOFT_TENANT_ID`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `PASSWORD_SIGNIN=owner` | Microsoft 365 sign-in |
| `STAFF_SYNC=provision`, `STAFF_SOURCE=twenty` | staff from the Twenty workspace |
| `TWENTY_API_URL`, `TWENTY_API_KEY`, `TWENTY_WEB_URL`, `CRM_SYNC=on` | Twenty CRM |
| `TWENTY_PERSON_OWNER_FIELD`, `TWENTY_PERSON_POD_FIELD` | only if not `assignedTo` / `pod` |
| `AUTO_RECOVERY` | leave unset (on) |

After changing the variable, re-run the deploy (or `nomad job restart linkedin-console-new`).

## Going back

A failed deploy reverts by itself. To go back to an earlier good version on purpose:

```bash
nomad job history linkedin-console-new
nomad job revert linkedin-console-new <version>
```

The account browsers follow the images of the version that runs.

## Database backups

The Nomad stack keeps Postgres in the Docker volume `linkedin-console_pgdata` on worker-7 and, unlike the
Compose setup, the `scripts/backup.sh` cron does **not** run against it. `deploy/nomad/linkedin-console-backup.nomad.hcl`
is a **periodic batch job** that fills that gap: every night at 03:30 UTC it runs
`pg_dump -U linkedin_console -Fc linkedin_console` against the running `postgres` container and writes a
timestamped `auto-<ts>.dump` into worker-7's `/var/backups/linkedin-console`, keeping the newest 14 (older
`auto-*.dump` files are pruned; hand-made dumps like `db-postreset.dump` are left alone).

### One-time setup

1. Create the backup directory on worker-7 (root-owned, 700 — the dumps hold private messages and the DB password):

   ```bash
   sudo mkdir -p /var/backups/linkedin-console && sudo chmod 700 /var/backups/linkedin-console
   ```

2. Grant the backup job's workload identity read access to the **main** job's variable (where the DB password
   lives). With a management token:

   ```bash
   nomad acl policy apply -namespace default -job linkedin-console-backup \
     linkedin-console-backup deploy/nomad/backup-policy.hcl
   ```

3. Install the schedule (this is a manual `nomad job run`, not part of CI):

   ```bash
   nomad job run deploy/nomad/linkedin-console-backup.nomad.hcl
   ```

### Verify / operate

```bash
nomad job periodic force linkedin-console-backup     # run one now
nomad job status linkedin-console-backup             # last runs (each launch is a child job)
sudo ls -l /var/backups/linkedin-console             # the auto-*.dump files
```

The dump/restore cycle was verified end-to-end (a `pg_dump -Fc` of a seeded `linkedin_console` DB restored
cleanly into a fresh scratch Postgres with all rows intact). Retention keeps `keep` (default 14) dumps; change
it with `-var keep=N` or `-var backup_dir=/path` on `nomad job run`.

### Restore

`pg_restore` a dump into an empty `linkedin_console` database (scratch instance first, then production only after
the app is stopped). Password is `POSTGRES_PASSWORD` from the Nomad variable.

```bash
# into a throwaway container, to check a dump restores:
docker run -d --name pgcheck -e POSTGRES_USER=linkedin_console -e POSTGRES_DB=linkedin_console \
  -e POSTGRES_PASSWORD=scratch postgres:17
docker cp /var/backups/linkedin-console/auto-<ts>.dump pgcheck:/tmp/d.dump
docker exec -e PGPASSWORD=scratch pgcheck \
  pg_restore -U linkedin_console -d linkedin_console --no-owner /tmp/d.dump
docker exec -e PGPASSWORD=scratch pgcheck \
  psql -U linkedin_console -d linkedin_console -c '\dt'   # sanity-check the tables
docker rm -f pgcheck
```

To restore into the live volume, stop the app first (`nomad job stop linkedin-console-new`, or scale the group
to 0) so nothing writes during the restore, then run `pg_restore` against the `postgres` container (restore into
a freshly-recreated DB, or use `--clean --if-exists`), and start the job again.

### Off-box copies (important)

The dumps sit on the same node as the database, so they do **not** survive worker-7 dying. Copy
`/var/backups/linkedin-console` off the box regularly (Proxmox Backup Server / NAS / S3) and keep the copies
**encrypted** — they contain private LinkedIn messages and the database password.

## Good to know

- Database migrations run by themselves when the new version starts (the api and the worker take turns through a database lock; all pending ones in one transaction).
- The Twenty fields and object (see docs/rbac.md): on Nomad, from the api task:

  ```bash
  nomad alloc exec -task api <alloc-id> node src/cli/twenty-fields.ts                 # what is missing (changes nothing)
  nomad alloc exec -task api <alloc-id> env APPLY=1 node src/cli/twenty-fields.ts     # add it
  ```
