variable "name" {
  description = "Bucket name prefix (globally unique, e.g. shriii-staging-<account>)."
  type        = string
}

variable "buckets" {
  description = "Buckets keyed by suffix."
  type = map(object({
    purpose         = string
    noncurrent_days = number
  }))
  default = {
    raw-events = { purpose = "Encrypted raw event chunks (layer 1, append-only)", noncurrent_days = 30 }
    snapshots  = { purpose = "Analysis snapshots (Parquet) and validation artefacts", noncurrent_days = 90 }
    releases   = { purpose = "Signed release packs, content packs and kiosk artefacts", noncurrent_days = 365 }
  }
}

variable "kms_key_arn" {
  type = string
}

variable "force_destroy" {
  description = "Allow destroying non-empty buckets (never in production)."
  type        = bool
  default     = false
}

variable "tags" {
  type    = map(string)
  default = {}
}
