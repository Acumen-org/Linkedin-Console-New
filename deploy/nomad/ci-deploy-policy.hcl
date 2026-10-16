# Nomad ACL policy for the CI deploy token (GitHub Actions): enough to plan, run and watch jobs in the default
# namespace, nothing else (no ACL, node, operator or variable access; the job reads its own variable itself).
#   nomad acl policy apply -description "LinkedIn Console CI deploy" linkedin-console-deploy deploy/nomad/ci-deploy-policy.hcl
#   nomad acl token create -name "github-linkedin-console-deploy" -policy linkedin-console-deploy -type client
namespace "default" {
  capabilities = ["list-jobs", "read-job", "submit-job", "read-logs"]
}

# "nomad job plan / run" check the node pool.
node_pool "linkunify" {
  policy = "read"
}
