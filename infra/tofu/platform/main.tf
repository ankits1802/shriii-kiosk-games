# SHRIII platform composition (PLT-05): network, KMS, RDS PostgreSQL 18, S3, ECR, ECS Fargate (api, worker,
# web), Cognito and CloudWatch. Each environment root (envs/<env>) instantiates this module once.

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  name = "shriii-${var.environment}"
  tags = merge(var.tags, {
    Project     = "shriii-behavioural-games"
    Environment = var.environment
    ManagedBy   = "opentofu"
    DataRegion  = data.aws_region.current.region
  })
}

# Policy as code (PLT-05 AC): nothing may be created outside the India regions.
check "india_regions_only" {
  assert {
    condition     = contains(var.allowed_regions, data.aws_region.current.region)
    error_message = "Provider region ${data.aws_region.current.region} is outside the allowed India regions ${join(", ", var.allowed_regions)}."
  }
}

module "kms" {
  source = "../modules/kms"
  name   = local.name
  region = data.aws_region.current.region
  tags   = local.tags
}

module "network" {
  source             = "../modules/network"
  name               = local.name
  region             = data.aws_region.current.region
  cidr_block         = var.vpc_cidr
  az_count           = var.az_count
  single_nat_gateway = var.single_nat_gateway
  logs_kms_key_arn   = module.kms.key_arns["logs"]
  tags               = local.tags
}

module "s3" {
  source        = "../modules/s3"
  name          = "${local.name}-${data.aws_caller_identity.current.account_id}"
  kms_key_arn   = module.kms.key_arns["data"]
  force_destroy = var.environment != "production" && var.allow_destroy
  tags          = local.tags
}

module "ecr" {
  source      = "../modules/ecr"
  kms_key_arn = module.kms.key_arns["data"]
  tags        = local.tags
}

module "cognito" {
  source              = "../modules/cognito"
  name                = local.name
  domain_prefix       = "${local.name}-${substr(data.aws_caller_identity.current.account_id, 0, 6)}"
  callback_urls       = ["${var.public_base_url}/api/auth/callback/cognito"]
  logout_urls         = ["${var.public_base_url}/"]
  deletion_protection = var.deletion_protection
  tags                = local.tags
}

module "ecs" {
  source              = "../modules/ecs"
  name                = local.name
  environment         = var.environment == "production" ? "prod" : "staging"
  vpc_id              = module.network.vpc_id
  public_subnet_ids   = module.network.public_subnet_ids
  private_subnet_ids  = module.network.private_subnet_ids
  repository_urls     = module.ecr.repository_urls
  image_tag           = var.image_tag
  certificate_arn     = var.certificate_arn
  oidc_issuer         = module.cognito.issuer_url
  oidc_jwks_url       = module.cognito.jwks_url
  oidc_audience       = module.cognito.web_client_id
  cors_origins        = [var.public_base_url]
  public_base_url     = var.public_base_url
  internal_api_url    = var.public_base_url
  bucket_arns         = values(module.s3.bucket_arns)
  task_kms_key_arns   = [module.kms.key_arns["data"], module.kms.key_arns["sessions"], module.kms.key_arns["identity"]]
  secrets_kms_key_arn = module.kms.key_arns["secrets"]
  logs_kms_key_arn    = module.kms.key_arns["logs"]
  deletion_protection = var.deletion_protection

  api_desired_count    = var.api_desired_count
  worker_desired_count = var.worker_desired_count
  web_desired_count    = var.web_desired_count

  tags = local.tags
}

module "rds" {
  source                     = "../modules/rds"
  name                       = local.name
  vpc_id                     = module.network.vpc_id
  subnet_ids                 = module.network.database_subnet_ids
  allowed_security_group_ids = [module.ecs.tasks_security_group_id]
  engine_version             = var.rds_engine_version
  instance_class             = var.rds_instance_class
  multi_az                   = var.rds_multi_az
  deletion_protection        = var.deletion_protection
  kms_key_arn                = module.kms.key_arns["data"]
  secrets_kms_key_arn        = module.kms.key_arns["secrets"]
  tags                       = local.tags
}

module "observability" {
  source                    = "../modules/observability"
  name                      = local.name
  region                    = data.aws_region.current.region
  alarm_emails              = var.alarm_emails
  sns_kms_key_id            = module.kms.key_ids["logs"]
  alb_arn_suffix            = module.ecs.alb_arn_suffix
  target_group_arn_suffixes = module.ecs.target_group_arn_suffixes
  ecs_cluster_name          = module.ecs.cluster_name
  ecs_services = {
    api    = var.api_desired_count
    worker = var.worker_desired_count
    web    = var.web_desired_count
  }
  rds_instance_id = module.rds.instance_id
  tags            = local.tags
}
