variable "environment" {
  description = "staging or production."
  type        = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}

variable "allowed_regions" {
  description = "Regions resources may live in (data residency: India only; DR in ap-south-2)."
  type        = list(string)
  default     = ["ap-south-1", "ap-south-2"]
  validation {
    condition     = alltrue([for r in var.allowed_regions : contains(["ap-south-1", "ap-south-2"], r)])
    error_message = "Only the India regions ap-south-1 (Mumbai) and ap-south-2 (Hyderabad) are allowed."
  }
}

variable "image_tag" {
  description = "Image tag (commit SHA) deployed to every service."
  type        = string
}

variable "certificate_arn" {
  description = "ACM certificate for the public hostname."
  type        = string
}

variable "public_base_url" {
  description = "Public HTTPS origin of the web app (e.g. https://staging.shriii.example)."
  type        = string
  validation {
    condition     = startswith(var.public_base_url, "https://")
    error_message = "public_base_url must be https."
  }
}

variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}

variable "az_count" {
  type    = number
  default = 3
}

variable "single_nat_gateway" {
  type    = bool
  default = false
}

variable "rds_engine_version" {
  description = "Exact RDS PostgreSQL 18 version (pinned in docs/VERSIONS.md)."
  type        = string
  default     = "18"
}

variable "rds_instance_class" {
  type    = string
  default = "db.m7g.large"
}

variable "rds_multi_az" {
  type    = bool
  default = true
}

variable "deletion_protection" {
  type    = bool
  default = true
}

variable "allow_destroy" {
  description = "Staging only: allow destroying non-empty buckets for rebuild drills."
  type        = bool
  default     = false
}

variable "api_desired_count" {
  type    = number
  default = 2
}

variable "worker_desired_count" {
  type    = number
  default = 1
}

variable "web_desired_count" {
  type    = number
  default = 2
}

variable "alarm_emails" {
  type    = list(string)
  default = []
}

variable "tags" {
  type    = map(string)
  default = {}
}
