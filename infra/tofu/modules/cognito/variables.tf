variable "name" {
  type = string
}

variable "domain_prefix" {
  description = "Hosted UI domain prefix (<prefix>.auth.<region>.amazoncognito.com)."
  type        = string
}

variable "roles" {
  description = "RBAC roles mirrored as Cognito groups (BUILD_DECISIONS: admin, researcher, administrator, analyst)."
  type        = list(string)
  default     = ["admin", "researcher", "administrator", "analyst"]
}

variable "callback_urls" {
  type = list(string)
}

variable "logout_urls" {
  type = list(string)
}

variable "deletion_protection" {
  type    = bool
  default = true
}

variable "tags" {
  type    = map(string)
  default = {}
}
