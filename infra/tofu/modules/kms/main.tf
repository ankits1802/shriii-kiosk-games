# Customer-managed KMS keys (envelope encryption, PRV-07 / ING-08): one key per data domain so access can be
# granted and audited separately. All keys rotate yearly.

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  account_root = "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"
  keys = {
    data     = "Research data at rest: RDS, raw-event and snapshot buckets"
    sessions = "Per-session DEK wrapping (session key KEK) and release-pack signing material"
    identity = "Identity vault (contact details), separate from research data"
    logs     = "CloudWatch Logs and VPC flow logs"
    secrets  = "Secrets Manager secrets (DB credentials, app keys)"
  }
}

data "aws_iam_policy_document" "key" {
  for_each = local.keys

  statement {
    sid       = "AccountAdministration"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = [local.account_root]
    }
  }

  dynamic "statement" {
    for_each = each.key == "logs" ? [1] : []
    content {
      sid = "CloudWatchLogs"
      actions = [
        "kms:Encrypt*",
        "kms:Decrypt*",
        "kms:ReEncrypt*",
        "kms:GenerateDataKey*",
        "kms:Describe*",
      ]
      resources = ["*"]
      principals {
        type        = "Service"
        identifiers = ["logs.${var.region}.amazonaws.com"]
      }
      condition {
        test     = "ArnLike"
        variable = "kms:EncryptionContext:aws:logs:arn"
        values   = ["arn:${data.aws_partition.current.partition}:logs:${var.region}:${data.aws_caller_identity.current.account_id}:*"]
      }
    }
  }

  # CloudWatch alarms publish to the KMS-encrypted alarm SNS topic.
  dynamic "statement" {
    for_each = each.key == "logs" ? [1] : []
    content {
      sid       = "CloudWatchAlarmsToEncryptedSns"
      actions   = ["kms:Decrypt", "kms:GenerateDataKey*"]
      resources = ["*"]
      principals {
        type        = "Service"
        identifiers = ["cloudwatch.amazonaws.com"]
      }
    }
  }
}

resource "aws_kms_key" "this" {
  for_each                = local.keys
  description             = "${var.name}: ${each.value}"
  enable_key_rotation     = true
  rotation_period_in_days = 365
  deletion_window_in_days = var.deletion_window_in_days
  multi_region            = false
  policy                  = data.aws_iam_policy_document.key[each.key].json
  tags                    = merge(var.tags, { Name = "${var.name}-${each.key}", Domain = each.key })
}

resource "aws_kms_alias" "this" {
  for_each      = local.keys
  name          = "alias/${var.name}-${each.key}"
  target_key_id = aws_kms_key.this[each.key].key_id
}
