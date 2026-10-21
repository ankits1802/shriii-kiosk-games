variable "repositories" {
  description = "Image names (repository = shriii-<name>)."
  type        = list(string)
  default     = ["api", "worker", "web", "kiosk"]
}

variable "kms_key_arn" {
  type = string
}

variable "keep_images" {
  type    = number
  default = 100
}

variable "tags" {
  type    = map(string)
  default = {}
}
