# Nomad ACL policy for the linkedin-console-backup job's workload identity.
#
# A task can read its own job's variables (nomad/jobs/<job-id>/...) implicitly, but the backup job
# (linkedin-console-backup) needs the DB password that lives under the MAIN job's path
# (nomad/jobs/linkedin-console-new). This policy grants exactly that one variable, read-only, and is bound to
# the backup job's workload identity with the -job flag:
#
#   nomad acl policy apply -namespace default -job linkedin-console-backup \
#     linkedin-console-backup deploy/nomad/backup-policy.hcl
#
# Nothing else: no job, node, ACL or operator capabilities.
namespace "default" {
  variables {
    path "nomad/jobs/linkedin-console-new" {
      capabilities = ["read"]
    }
  }
}
