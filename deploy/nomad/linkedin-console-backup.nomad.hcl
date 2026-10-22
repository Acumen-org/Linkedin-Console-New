# Nightly Postgres backup for the linkedin-console-new job (worker-7).
#
# The main job (linkedin-console-new) runs Postgres as a sidecar task with its data in the Docker volume
# linkedin-console_pgdata; it had NO scheduled backups, which turned a latent WAL corruption into a near-miss
# on 2026-10-21 (recovered with pg_resetwal; the newest dump was 12 days old). This periodic batch job closes
# that gap: every night it runs `pg_dump -Fc` against the running postgres container and keeps the last KEEP
# dumps on worker-7's /var/backups/linkedin-console.
#
#   nomad job run deploy/nomad/linkedin-console-backup.nomad.hcl      # install / update the schedule
#   nomad job periodic force linkedin-console-backup                  # run one now (test)
#   nomad job status linkedin-console-backup                          # see the last runs
#
# One-time ACL step (the backup reads POSTGRES_PASSWORD from the OTHER job's variable, so its workload identity
# needs explicit read on that path — see deploy/nomad/backup-policy.hcl and deploy/nomad/README.md):
#   nomad acl policy apply -namespace default -job linkedin-console-backup \
#     linkedin-console-backup deploy/nomad/backup-policy.hcl
#
# The dumps contain private messages and the DB password: keep /var/backups/linkedin-console 700, copy the
# dumps OFF worker-7 (Proxmox Backup Server / NAS / S3) and keep the copies encrypted. A single node with its
# own backups on it does not survive the node dying.

variable "backup_dir" {
  type        = string
  default     = "/var/backups/linkedin-console"
  description = "Host directory on worker-7 that holds the dumps (bind-mounted into the job)."
}

variable "keep" {
  type        = number
  default     = 14
  description = "How many of the newest auto-*.dump files to keep; older ones are pruned each run."
}

job "linkedin-console-backup" {
  datacenters = ["acumen-dc"]
  node_pool   = "linkunify"
  type        = "batch"

  # The postgres container, its Docker volume and the backup directory all live on worker-7, so the job must
  # run there (same node, same "linkedin-console" Docker network so it can resolve the "postgres" alias).
  constraint {
    attribute = "${node.unique.name}"
    value     = "worker-7"
  }

  periodic {
    # 03:30 UTC nightly (the compose-era backup used 03:15; staggered so they never collide if both ever run).
    crons            = ["30 3 * * *"]
    time_zone        = "UTC"
    prohibit_overlap = true
  }

  group "backup" {
    count = 1

    # A failed dump should surface as a failed allocation, not retry forever or silently reschedule.
    restart {
      attempts = 2
      interval = "15m"
      delay    = "30s"
      mode     = "fail"
    }
    reschedule {
      attempts  = 1
      interval  = "1h"
      unlimited = false
    }

    task "pg-dump" {
      driver = "docker"
      config {
        image        = "postgres:17" # same server version as the postgres task: pg_dump must be >= the server
        network_mode = "linkedin-console"
        command      = "sh"
        # NOTE: use brace-free shell vars ($KEEP, $stamp) only. Nomad runs a second interpolation pass over the
        # task config at runtime and treats any ${...} as a Nomad variable (so "${KEEP:-14}" fails to parse).
        # $(...) / $((...)) are fine — only ${ triggers interpolation.
        args = ["-c", <<-EOS
          set -eu
          stamp="$(date -u +%Y%m%d-%H%M%S)"
          tmp="/backups/.auto-$stamp.dump.tmp"
          dest="/backups/auto-$stamp.dump"
          # Clean up a partial dump if pg_dump fails midway, so a broken file is never left as a "backup".
          trap 'rm -f "$tmp"' EXIT
          echo "$(date -Is) backup: pg_dump linkedin_console -> $dest"
          pg_dump -h postgres -U linkedin_console -Fc linkedin_console > "$tmp"
          chmod 600 "$tmp"
          mv "$tmp" "$dest"
          echo "$(date -Is) backup: wrote $dest ($(du -h "$dest" | cut -f1))"
          # Prune only our own auto-*.dump files by count, so manual dumps (e.g. db-postreset.dump) are untouched.
          echo "$(date -Is) backup: keeping newest $KEEP auto-*.dump, pruning the rest"
          ls -1t /backups/auto-*.dump 2>/dev/null | tail -n +"$((KEEP + 1))" | while IFS= read -r f; do
            echo "$(date -Is) backup: prune $f"
            rm -f "$f"
          done
          echo "$(date -Is) backup: done"
        EOS
        ]
        # Bind-mount the host backup directory (Docker driver needs volumes.enabled, already on for the socket
        # mount in the main job). Create it 700-owned by root on worker-7 before the first run.
        volumes = [
          "${var.backup_dir}:/backups",
        ]
      }

      env {
        KEEP = "${var.keep}"
      }

      # PGPASSWORD for pg_dump, read from the main job's variable. The backup job's workload identity only gets
      # this path through deploy/nomad/backup-policy.hcl (applied with `-job linkedin-console-backup`).
      template {
        destination = "secrets/pg.env"
        env         = true
        data        = <<-EOT
          {{ with nomadVar "nomad/jobs/linkedin-console-new" }}PGPASSWORD={{ .POSTGRES_PASSWORD }}{{ end }}
        EOT
      }

      resources {
        cpu    = 500
        memory = 256
      }
    }
  }
}
