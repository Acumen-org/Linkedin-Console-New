# LinkedIn Console on Nomad (worker-7): the renamed LinkUnify, same "lift-and-shift" layout as the linkunify job.
# Deployed by CI (.github/workflows/deploy.yml) after the tests pass on main:
#   nomad job run -var tag=<commit> deploy/nomad/linkedin-console-new.nomad.hcl
# See deploy/nomad/README.md for the one-time setup (Harbor login on worker-7, the CI token, GitHub secrets).
#
# Account browser pods (pod-<id>, pod-<id>-sidecar) are created by the pod-agent through worker-7's Docker; after a
# deploy the app moves them to the new images by itself, two at a time, keeping their LinkedIn sessions.
# Volumes, database and images use the repo's new names (linkedin-console_*, linkedin_console).
# Secrets come from the Nomad variable nomad/jobs/linkedin-console-new (copied from nomad/jobs/linkunify + REDIS_PASSWORD).
# Job name is "linkedin-console-new" because "linkedin-console" (job + variable) belongs to the old noVNC console
# and is kept for its rollback.
#
# Differences from the Compose setup in the repo:
#   - One Docker network (linkedin-console) for everything, pods included. Nomad's docker driver attaches a task
#     to a single network, so the repo's separate pods network (linkedin-console-pods) is not used yet. Pods can
#     reach the api/database network exactly as they could under the linkunify job; their Redis access is still
#     limited by the per-pod ACL user.
#   - Postgres runs with default settings (no 1 GB shared_buffers tuning) to fit its 512 MB allocation.
#   - The Consul service keeps the name "linkunify" so the APISIX route keeps working; rename it together
#     with the route later.

variable "tag" {
  type        = string
  description = "Git commit the images were built from (Acumen-org/Linkedin-Console-New), as pushed to Harbor"
}

variable "registry" {
  type        = string
  default     = "h4rb0r.acm.acumen-strategy.com/linkedin-outreach"
  description = "Harbor project with the images (server is 'worker', caddy is 'frontend')"
}

variable "registry_auth_file" {
  type        = string
  default     = "/root/.docker/config.json"
  description = "worker-7's Docker login file (docker login to Harbor as root); the pod-agent reads it to pull browser images"
}

job "linkedin-console-new" {
  datacenters = ["acumen-dc"]
  node_pool   = "linkunify"
  type        = "service"

  # Volumes are local Docker volumes on worker-7: the job must stay on that node.
  constraint {
    attribute = "${node.unique.name}"
    value     = "worker-7"
  }

  # A deploy only succeeds when the app answers /api/health; otherwise Nomad goes back to the previous version.
  update {
    max_parallel      = 1
    health_check      = "checks"
    min_healthy_time  = "30s"
    healthy_deadline  = "10m"
    progress_deadline = "15m"
    auto_revert       = true
  }

  group "app" {
    count          = 1
    shutdown_delay = "5s"

    network {
      port "http" {
        static = 80
        to     = 80
      }
    }

    restart {
      attempts = 10
      interval = "30m"
      delay    = "15s"
      mode     = "delay"
    }

    service {
      name     = "linkunify" # unchanged on purpose: APISIX may discover the app by this name
      port     = "http"
      provider = "consul"
      check {
        type     = "http"
        path     = "/api/health"
        interval = "15s"
        timeout  = "5s"
      }
    }

    task "init-perms" {
      lifecycle {
        hook    = "prestart"
        sidecar = false
      }
      driver = "docker"
      config {
        image        = "alpine:3.22"
        network_mode = "linkedin-console"
        command      = "sh"
        args         = ["-c", "mkdir -p /data/files/uploads /data/files/media /data/files/live && chown -R 1000:1000 /data/files"]
        mount {
          type   = "volume"
          source = "linkedin-console_files"
          target = "/data/files"
        }
      }
      resources {
        cpu    = 100
        memory = 64
      }
    }

    task "postgres" {
      lifecycle {
        hook    = "prestart"
        sidecar = true
      }
      driver = "docker"
      config {
        image           = "postgres:17"
        network_mode    = "linkedin-console"
        network_aliases = ["postgres"]
        mount {
          type   = "volume"
          source = "linkedin-console_pgdata"
          target = "/var/lib/postgresql/data"
        }
      }
      env {
        POSTGRES_USER = "linkedin_console"
        POSTGRES_DB   = "linkedin_console"
      }
      template {
        destination = "secrets/postgres.env"
        env         = true
        data        = <<-EOT
          {{ with nomadVar "nomad/jobs/linkedin-console-new" }}POSTGRES_PASSWORD={{ .POSTGRES_PASSWORD }}{{ end }}
        EOT
      }
      resources {
        cpu    = 500
        memory = 512
      }
    }

    task "redis" {
      lifecycle {
        hook    = "prestart"
        sidecar = true
      }
      driver = "docker"
      config {
        image           = "valkey/valkey:8"
        network_mode    = "linkedin-console"
        network_aliases = ["redis"]
        # Password required (the pod-agent gives each pod its own restricted Redis user).
        command = "sh"
        args    = ["-c", "exec valkey-server --appendonly yes --requirepass \"$REDIS_PASSWORD\""]
        mount {
          type   = "volume"
          source = "linkedin-console_redisdata"
          target = "/data"
        }
      }
      template {
        destination = "secrets/redis.env"
        env         = true
        data        = <<-EOT
          {{ with nomadVar "nomad/jobs/linkedin-console-new" }}REDIS_PASSWORD={{ .REDIS_PASSWORD }}
          REDISCLI_AUTH={{ .REDIS_PASSWORD }}{{ end }}
        EOT
      }
      resources {
        cpu    = 200
        memory = 256
      }
    }

    task "api" {
      driver = "docker"
      config {
        image           = "${var.registry}/worker:${var.tag}"
        network_mode    = "linkedin-console"
        network_aliases = ["api"]
        command         = "node"
        args            = ["src/api.ts"]
        mount {
          type   = "volume"
          source = "linkedin-console_files"
          target = "/data/files"
        }
      }
      env {
        FILES_DIR     = "/data/files"
        POD_AGENT_URL = "http://pod-agent:7070"
      }
      template {
        destination = "secrets/server.env"
        env         = true
        data        = <<-EOT
          {{ with nomadVar "nomad/jobs/linkedin-console-new" }}{{ range $k, $v := . }}{{ $k }}={{ $v }}
          {{ end }}DATABASE_URL=postgres://linkedin_console:{{ .POSTGRES_PASSWORD }}@postgres:5432/linkedin_console
          REDIS_URL=redis://default:{{ .REDIS_PASSWORD }}@redis:6379
          {{ end }}
        EOT
      }
      resources {
        cpu    = 500
        memory = 768
      }
    }

    task "worker" {
      driver = "docker"
      config {
        image        = "${var.registry}/worker:${var.tag}"
        network_mode = "linkedin-console"
        command      = "node"
        args         = ["src/worker.ts"]
        healthchecks {
          disable = true
        }
        mount {
          type   = "volume"
          source = "linkedin-console_files"
          target = "/data/files"
        }
      }
      env {
        SERVICE_NAME  = "worker"
        FILES_DIR     = "/data/files"
        POD_AGENT_URL = "http://pod-agent:7070"
      }
      template {
        destination = "secrets/server.env"
        env         = true
        data        = <<-EOT
          {{ with nomadVar "nomad/jobs/linkedin-console-new" }}{{ range $k, $v := . }}{{ $k }}={{ $v }}
          {{ end }}DATABASE_URL=postgres://linkedin_console:{{ .POSTGRES_PASSWORD }}@postgres:5432/linkedin_console
          REDIS_URL=redis://default:{{ .REDIS_PASSWORD }}@redis:6379
          {{ end }}
        EOT
      }
      resources {
        cpu    = 500
        memory = 768
      }
    }

    task "pod-agent" {
      driver = "docker"
      config {
        image           = "${var.registry}/pod-agent:${var.tag}"
        network_mode    = "linkedin-console"
        network_aliases = ["pod-agent"]
        # Creates the account pods through worker-7's Docker. Root-equivalent on this node, which is why
        # worker-7 is alone in the "linkunify" node pool. The Docker login file (read-only) lets it pull the
        # browser images from Harbor.
        volumes = [
          "/var/run/docker.sock:/var/run/docker.sock",
          "${var.registry_auth_file}:/run/registry/config.json:ro",
        ]
      }
      env {
        POD_NETWORK        = "linkedin-console"
        FILES_VOLUME       = "linkedin-console_files"
        CHROME_IMAGE       = "${var.registry}/chrome:${var.tag}"
        SIDECAR_IMAGE      = "${var.registry}/sidecar:${var.tag}"
        REGISTRY_AUTH_FILE = "/run/registry/config.json"
      }
      template {
        destination = "secrets/pod-agent.env"
        env         = true
        data        = <<-EOT
          {{ with nomadVar "nomad/jobs/linkedin-console-new" }}POD_AGENT_TOKEN={{ .POD_AGENT_TOKEN }}
          LIVE_SECRET={{ .LIVE_SECRET }}
          REDIS_URL=redis://default:{{ .REDIS_PASSWORD }}@redis:6379
          POD_MEMORY_MB={{ .POD_MEMORY_MB }}
          SIDECAR_ENV={{ .SIDECAR_ENV }}
          HEAL_PROVIDER={{ .HEAL_PROVIDER }}
          HEAL_MODEL={{ .HEAL_MODEL }}
          ANTHROPIC_API_KEY={{ .ANTHROPIC_API_KEY }}
          OLLAMA_URL={{ .OLLAMA_URL }}
          PARK_AFTER_MINUTES={{ .PARK_AFTER_MINUTES }}
          SEND_MODE={{ .SEND_MODE }}
          {{ end }}
        EOT
      }
      resources {
        cpu    = 200
        memory = 256
      }
    }

    task "caddy" {
      driver = "docker"
      config {
        image           = "${var.registry}/frontend:${var.tag}"
        network_mode    = "linkedin-console"
        network_aliases = ["caddy"]
        ports           = ["http"]
        mount {
          type   = "volume"
          source = "linkedin-console_caddydata"
          target = "/data"
        }
        mount {
          type   = "volume"
          source = "linkedin-console_caddyconfig"
          target = "/config"
        }
      }
      template {
        destination = "secrets/caddy.env"
        env         = true
        data        = <<-EOT
          {{ with nomadVar "nomad/jobs/linkedin-console-new" }}SITE_ADDRESS={{ .SITE_ADDRESS }}
          LIVE_SECRET={{ .LIVE_SECRET }}
          TRUSTED_PROXIES={{ .TRUSTED_PROXIES }}
          {{ end }}
        EOT
      }
      resources {
        cpu    = 200
        memory = 129
      }
    }
  }
}
