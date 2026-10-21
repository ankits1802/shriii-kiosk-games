# OpenTofu: AWS ap-south-1 (PLT-05)

```
bootstrap/          one-time per account: state bucket + GitHub OIDC deploy role (local state)
platform/           composition used by every environment (+ India-regions `check` block)
modules/
  network/          VPC, public / private / isolated database subnets over 2-3 AZs, NAT, S3 endpoint, flow logs
  kms/              customer-managed keys per domain: data, sessions, identity, logs, secrets (yearly rotation)
  rds/              PostgreSQL 18 (Multi-AZ in production), KMS, TLS-only, IAM auth, managed master secret, PI
  s3/               raw-events, snapshots, releases buckets: versioning, SSE-KMS, TLS-only, public access blocked
  ecr/              shriii-{api,worker,web,kiosk}: immutable tags, scan on push, KMS, lifecycle
  ecs/              Fargate cluster, ALB (TLS 1.3 policy), api / worker / web services, migrate task, IAM, secrets
  cognito/          staff user pool (MFA on, admin-created users), RBAC groups, web OIDC client
  observability/    SNS alarm topic, ALB / ECS / RDS alarms, CloudWatch dashboard
envs/staging        cheap, rebuildable from zero (single NAT, single-AZ RDS, no deletion protection)
envs/production     Multi-AZ RDS, NAT per AZ, deletion protection
```

## Use

```bash
# once per account (administrator credentials)
tofu -chdir=infra/tofu/bootstrap init && tofu -chdir=infra/tofu/bootstrap apply -var github_repository=<owner>/<repo>

# per environment
cp infra/tofu/envs/staging/terraform.tfvars.example infra/tofu/envs/staging/terraform.tfvars   # edit
tofu -chdir=infra/tofu/envs/staging init -backend-config="bucket=<state bucket>" -backend-config="region=ap-south-1"
tofu -chdir=infra/tofu/envs/staging plan -var image_tag=<commit sha>
```

Before the first rollout, put the backend secrets into the Secrets Manager secret named by the `backend_secret_arn`
output: a JSON object with `DATABASE_URL`, `IDENTITY_DATABASE_URL`, `PID_HMAC_PEPPER`, `SESSION_KEY_KEK`,
`BACKEND_X25519_PRIVATE_KEY`, `RELEASE_PACK_SIGNING_KEY` and `IDENTITY_VAULT_KEY` (base64, 32 bytes each; generated in
a KMS-backed ceremony, never in OpenTofu state). Then run the `migrate_task_definition_arn` task once per release
(`aws ecs run-task`) before the services roll.

## Validation

`tofu fmt -check` and `tofu validate` run in CI (`infra` job in `.github/workflows/ci.yml`) for both environments and
the bootstrap root. They pass locally with OpenTofu 1.10 (`ghcr.io/opentofu/opentofu:1.10`) and the AWS provider
6.x. Region policy: variable validations, a `check` block in `platform/` and a CI grep allow only `ap-south-1` and
`ap-south-2`.

## Not yet covered (documented gaps)

- **S3 MFA delete** cannot be enabled by OpenTofu (it needs the root user's MFA device). Enable it manually on the
  raw-events bucket: `aws s3api put-bucket-versioning --bucket <b> --versioning-configuration Status=Enabled,MFADelete=Enabled --mfa "<serial> <code>"`.
- **DR in ap-south-2** (cross-region RDS snapshot copy, S3 replication) and the quarterly restore drill.
- **Plan services not built in iteration 1**: Dagster, Metabase, Grafana and ODK Central (BUILD_DECISIONS replaced
  them with the Postgres job worker, custom dashboards and in-app criterion capture).
- **Web to API traffic** goes through the public ALB (`internal_api_url`); switch to ECS Service Connect when the
  web app's server-side calls are known.
- The deploy role uses `PowerUserAccess` plus scoped IAM; add a permissions boundary once the resource set settles.
