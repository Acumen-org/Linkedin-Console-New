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

## Good to know

- Database migrations run by themselves when the new version starts (the api and the worker take turns through a database lock; all pending ones in one transaction).
- The Twenty fields and object (see docs/rbac.md): on Nomad, from the api task:

  ```bash
  nomad alloc exec -task api <alloc-id> node src/cli/twenty-fields.ts                 # what is missing (changes nothing)
  nomad alloc exec -task api <alloc-id> env APPLY=1 node src/cli/twenty-fields.ts     # add it
  ```
