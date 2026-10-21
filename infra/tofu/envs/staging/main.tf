# Staging environment (ap-south-1). State lives in S3 with native lockfiles; bucket and region are passed at init:
#   tofu init -backend-config="bucket=<state bucket>" -backend-config="region=ap-south-1"
terraform {
  required_version = ">= 1.10.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
  backend "s3" {
    key          = "shriii/staging/platform.tfstate"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region              = var.region
  allowed_account_ids = var.allowed_account_ids
  default_tags {
    tags = {
      Project     = "shriii-behavioural-games"
      Environment = "staging"
      ManagedBy   = "opentofu"
    }
  }
}

module "platform" {
  source = "../../platform"

  environment     = "staging"
  image_tag       = var.image_tag
  certificate_arn = var.certificate_arn
  public_base_url = var.public_base_url
  alarm_emails    = var.alarm_emails

  # Staging is cheaper and rebuildable from zero (PLT-04 AC: < 30 minutes).
  vpc_cidr             = "10.40.0.0/16"
  az_count             = 2
  single_nat_gateway   = true
  rds_instance_class   = "db.t4g.medium"
  rds_multi_az         = false
  deletion_protection  = false
  allow_destroy        = true
  api_desired_count    = 1
  worker_desired_count = 1
  web_desired_count    = 1
}
