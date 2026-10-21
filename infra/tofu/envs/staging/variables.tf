variable "region" {
  type    = string
  default = "ap-south-1"
  validation {
    condition     = contains(["ap-south-1", "ap-south-2"], var.region)
    error_message = "SHRIII data stays in India: ap-south-1 or ap-south-2 only."
  }
}

variable "allowed_account_ids" {
  description = "Guard against applying to the wrong AWS account (empty = no guard; set it in tfvars)."
  type        = list(string)
  default     = null
}

variable "image_tag" {
  description = "Commit SHA of the images to deploy (TF_VAR_image_tag from deploy.yml)."
  type        = string
  default     = "main"
}

variable "certificate_arn" {
  type = string
}

variable "public_base_url" {
  type = string
}

variable "alarm_emails" {
  type    = list(string)
  default = []
}
