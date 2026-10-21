variable "name" {
  type = string
}

variable "region" {
  type = string
}

variable "alarm_emails" {
  type    = list(string)
  default = []
}

variable "sns_kms_key_id" {
  description = "KMS key for the alarm topic."
  type        = string
}

variable "alb_arn_suffix" {
  type = string
}

variable "target_group_arn_suffixes" {
  type = map(string)
}

variable "ecs_cluster_name" {
  type = string
}

variable "ecs_services" {
  description = "Service name -> minimum running task count."
  type        = map(number)
}

variable "rds_instance_id" {
  type = string
}

variable "alb_5xx_threshold" {
  type    = number
  default = 10
}

variable "api_p99_seconds" {
  type    = number
  default = 2
}

variable "rds_min_free_storage_bytes" {
  type    = number
  default = 10737418240 # 10 GiB
}

variable "tags" {
  type    = map(string)
  default = {}
}
