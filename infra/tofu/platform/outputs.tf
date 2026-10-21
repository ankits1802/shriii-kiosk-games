output "alb_dns_name" {
  description = "Point the public hostname (CNAME/alias) here."
  value       = module.ecs.alb_dns_name
}

output "ecr_repository_urls" {
  value = module.ecr.repository_urls
}

output "ecs_cluster_name" {
  value = module.ecs.cluster_name
}

output "migrate_task_definition_arn" {
  value = module.ecs.migrate_task_definition_arn
}

output "private_subnet_ids" {
  value = module.network.private_subnet_ids
}

output "tasks_security_group_id" {
  value = module.ecs.tasks_security_group_id
}

output "backend_secret_arn" {
  description = "Populate with DATABASE_URL, IDENTITY_DATABASE_URL and the 32-byte keys before the first rollout."
  value       = module.ecs.backend_secret_arn
}

output "rds_endpoint" {
  value = module.rds.endpoint
}

output "rds_master_secret_arn" {
  value = module.rds.master_user_secret_arn
}

output "buckets" {
  value = module.s3.bucket_names
}

output "cognito_user_pool_id" {
  value = module.cognito.user_pool_id
}

output "cognito_issuer_url" {
  value = module.cognito.issuer_url
}

output "kms_key_arns" {
  value = module.kms.key_arns
}

output "alarm_topic_arn" {
  value = module.observability.alarm_topic_arn
}
