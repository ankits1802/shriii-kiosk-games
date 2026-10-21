# Production environment (ap-south-1; DR restores go to ap-south-2). Promotions are manual and approved through
# the `production` GitHub environment (deploy.yml, workflow_dispatch with an existing image tag).
terraform {
  required_version = ">= 1.10.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
  backend "s3" {
    key          = "shriii/production/platform.tfstate"
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
      Environment = "production"
      ManagedBy   = "opentofu"
    }
  }
}

module "platform" {
  source = "../../platform"

  environment     = "production"
  image_tag       = var.image_tag
  certificate_arn = var.certificate_arn
  public_base_url = var.public_base_url
  alarm_emails    = var.alarm_emails

  vpc_cidr             = "10.41.0.0/16"
  az_count             = 3
  single_nat_gateway   = false
  rds_instance_class   = "db.m7g.large"
  rds_multi_az         = true
  deletion_protection  = true
  allow_destroy        = false
  api_desired_count    = 2
  worker_desired_count = 1
  web_desired_count    = 2
}
