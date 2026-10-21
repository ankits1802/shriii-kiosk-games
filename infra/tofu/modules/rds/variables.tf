variable "name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  description = "Isolated database subnets (at least two AZs)."
  type        = list(string)
}

variable "allowed_security_group_ids" {
  description = "Security groups (ECS tasks) allowed to connect on 5432."
  type        = list(string)
}

variable "engine_major" {
  description = "PostgreSQL major version (BUILD_DECISIONS: PostgreSQL 18)."
  type        = string
  default     = "18"
}

variable "engine_version" {
  description = "Exact RDS engine version; pin the latest RDS minor (PLT-08 docs/VERSIONS.md)."
  type        = string
  default     = "18"
  validation {
    condition     = startswith(var.engine_version, "18")
    error_message = "The platform runs PostgreSQL 18 (BUILD_DECISIONS)."
  }
}

variable "instance_class" {
  type    = string
  default = "db.m7g.large"
}

variable "database_name" {
  type    = string
  default = "shriii"
}

variable "master_username" {
  type    = string
  default = "shriii_admin"
}

variable "allocated_storage_gb" {
  type    = number
  default = 100
}

variable "max_allocated_storage_gb" {
  type    = number
  default = 1000
}

variable "multi_az" {
  type    = bool
  default = true
}

variable "backup_retention_days" {
  type    = number
  default = 35
}

variable "deletion_protection" {
  type    = bool
  default = true
}

variable "kms_key_arn" {
  description = "KMS key for storage and Performance Insights."
  type        = string
}

variable "secrets_kms_key_arn" {
  description = "KMS key for the managed master-user secret."
  type        = string
}

variable "tags" {
  type    = map(string)
  default = {}
}
