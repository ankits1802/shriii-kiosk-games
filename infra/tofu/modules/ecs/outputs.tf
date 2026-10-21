output "cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "service_names" {
  value = { for k, v in aws_ecs_service.this : k => v.name }
}

output "migrate_task_definition_arn" {
  description = "Run before each rollout: aws ecs run-task --task-definition <arn> ..."
  value       = aws_ecs_task_definition.this["migrate"].arn
}

output "tasks_security_group_id" {
  value = aws_security_group.tasks.id
}

output "alb_dns_name" {
  value = aws_lb.this.dns_name
}

output "alb_arn_suffix" {
  value = aws_lb.this.arn_suffix
}

output "target_group_arn_suffixes" {
  value = { for k, v in aws_lb_target_group.this : k => v.arn_suffix }
}

output "backend_secret_arn" {
  value = aws_secretsmanager_secret.backend.arn
}
