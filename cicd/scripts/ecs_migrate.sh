#!/usr/bin/env bash
# Run the one-off `migrate` ECS task (shriii-api migrate && shriii-api seed) and fail unless it exits 0.
#
#   ecs_migrate.sh <platform-outputs.json>
#
# The JSON is `tofu output -json platform` from an environment root (envs/<env>): it must carry
# ecs_cluster_name, migrate_task_definition_arn, private_subnet_ids and tasks_security_group_id.
# Needs the AWS CLI with credentials for the target account and jq. MIGRATE_TIMEOUT_S (default 1800) bounds the wait.
set -euo pipefail

outputs="${1:?usage: ecs_migrate.sh <platform-outputs.json>}"
timeout_s="${MIGRATE_TIMEOUT_S:-1800}"

cluster=$(jq -er '.ecs_cluster_name' "$outputs")
task_def=$(jq -er '.migrate_task_definition_arn' "$outputs")
subnets=$(jq -er '.private_subnet_ids | join(",")' "$outputs")
sg=$(jq -er '.tasks_security_group_id' "$outputs")

echo "Running ${task_def} on ${cluster}"
task_arn=$(aws ecs run-task \
  --cluster "$cluster" \
  --task-definition "$task_def" \
  --launch-type FARGATE \
  --count 1 \
  --started-by "github-deploy-${GITHUB_RUN_ID:-manual}" \
  --network-configuration "awsvpcConfiguration={subnets=[${subnets}],securityGroups=[${sg}],assignPublicIp=DISABLED}" \
  --query 'tasks[0].taskArn' --output text)

if [ -z "$task_arn" ] || [ "$task_arn" = "None" ]; then
  echo "::error title=Migration::run-task did not start a task" >&2
  exit 1
fi
echo "Started ${task_arn}"

deadline=$((SECONDS + timeout_s))
while :; do
  status=$(aws ecs describe-tasks --cluster "$cluster" --tasks "$task_arn" --query 'tasks[0].lastStatus' --output text)
  [ "$status" = "STOPPED" ] && break
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "::error title=Migration::task still ${status} after ${timeout_s}s; stopping it" >&2
    aws ecs stop-task --cluster "$cluster" --task "$task_arn" --reason "migration timeout" > /dev/null || true
    exit 1
  fi
  sleep 10
done

exit_code=$(aws ecs describe-tasks --cluster "$cluster" --tasks "$task_arn" \
  --query "tasks[0].containers[?name=='migrate'].exitCode | [0]" --output text)
reason=$(aws ecs describe-tasks --cluster "$cluster" --tasks "$task_arn" --query 'tasks[0].stoppedReason' --output text)
echo "Migration task stopped: exit=${exit_code} reason=${reason}"
if [ "$exit_code" != "0" ]; then
  echo "::error title=Migration failed::exit code ${exit_code} (${reason}); see the CloudWatch log group for the migrate task" >&2
  exit 1
fi
