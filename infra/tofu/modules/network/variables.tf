variable "name" {
  description = "Name prefix (e.g. shriii-staging)."
  type        = string
}

variable "region" {
  description = "AWS region (India regions only; validated in the root module)."
  type        = string
}

variable "cidr_block" {
  description = "VPC CIDR (/16 recommended)."
  type        = string
  default     = "10.40.0.0/16"
  validation {
    condition     = can(cidrhost(var.cidr_block, 0))
    error_message = "cidr_block must be a valid CIDR."
  }
}

variable "az_count" {
  description = "Number of availability zones (ap-south-1 has three)."
  type        = number
  default     = 3
  validation {
    condition     = var.az_count >= 2 && var.az_count <= 3
    error_message = "Use 2 or 3 AZs (RDS Multi-AZ needs at least 2)."
  }
}

variable "single_nat_gateway" {
  description = "One shared NAT gateway (cheaper, staging) instead of one per AZ (production)."
  type        = bool
  default     = false
}

variable "flow_log_retention_days" {
  description = "Retention for VPC flow logs."
  type        = number
  default     = 90
}

variable "logs_kms_key_arn" {
  description = "KMS key for CloudWatch log encryption."
  type        = string
}

variable "tags" {
  description = "Tags applied to every resource."
  type        = map(string)
  default     = {}
}
