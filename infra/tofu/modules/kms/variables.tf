variable "name" {
  description = "Name prefix."
  type        = string
}

variable "region" {
  description = "AWS region (used for the CloudWatch Logs service principal)."
  type        = string
}

variable "deletion_window_in_days" {
  description = "Waiting period before a scheduled key deletion completes."
  type        = number
  default     = 30
}

variable "tags" {
  type    = map(string)
  default = {}
}
