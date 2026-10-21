variable "name" {
  type = string
}

variable "environment" {
  description = "Backend ENV value (staging or prod)."
  type        = string
  validation {
    condition     = contains(["staging", "prod"], var.environment)
    error_message = "environment must be staging or prod (dev/test settings are never deployed)."
  }
}

variable "vpc_id" {
  type = string
}

variable "public_subnet_ids" {
  type = list(string)
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "repository_urls" {
  description = "ECR repository URL per image (api, worker, web)."
  type        = map(string)
}

variable "image_tag" {
  description = "Image tag to run (the commit SHA pushed by deploy.yml)."
  type        = string
}

variable "certificate_arn" {
  description = "ACM certificate (ap-south-1) for the HTTPS listener."
  type        = string
}

variable "oidc_issuer" {
  type = string
}

variable "oidc_jwks_url" {
  type = string
}

variable "oidc_audience" {
  description = "Expected JWT audience (Cognito app client id)."
  type        = string
}

variable "cors_origins" {
  type = list(string)
}

variable "public_base_url" {
  type = string
}

variable "internal_api_url" {
  description = "API origin (no path) the web server uses for server-side calls and /api/v1 rewrites; the ALB routes /api/v1/* on it to the api service."
  type        = string
}

variable "bucket_arns" {
  type = list(string)
}

variable "task_kms_key_arns" {
  description = "KMS keys the tasks may use for envelope encryption (data, sessions, identity)."
  type        = list(string)
}

variable "secrets_kms_key_arn" {
  type = string
}

variable "logs_kms_key_arn" {
  type = string
}

variable "log_retention_days" {
  type    = number
  default = 90
}

variable "extra_backend_env" {
  type    = map(string)
  default = {}
}

variable "extra_web_env" {
  type    = map(string)
  default = {}
}

variable "deletion_protection" {
  type    = bool
  default = true
}

variable "api_cpu" {
  type    = number
  default = 1024
}

variable "api_memory" {
  type    = number
  default = 2048
}

variable "api_desired_count" {
  type    = number
  default = 2
}

variable "api_max_count" {
  type    = number
  default = 6
}

variable "worker_cpu" {
  type    = number
  default = 1024
}

variable "worker_memory" {
  type    = number
  default = 4096
}

variable "worker_desired_count" {
  type    = number
  default = 1
}

variable "web_cpu" {
  type    = number
  default = 512
}

variable "web_memory" {
  type    = number
  default = 1024
}

variable "web_desired_count" {
  type    = number
  default = 2
}

variable "tags" {
  type    = map(string)
  default = {}
}
