output "key_arns" {
  description = "Key ARN per domain (data, sessions, identity, logs, secrets)."
  value       = { for k, v in aws_kms_key.this : k => v.arn }
}

output "key_ids" {
  value = { for k, v in aws_kms_key.this : k => v.key_id }
}
