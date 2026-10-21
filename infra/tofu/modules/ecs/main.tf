# ECS Fargate: cluster, ALB, and the api / worker / web services plus a one-off `migrate` task definition
# (run by the deploy pipeline before rolling the services). Secrets are injected from one Secrets Manager secret
# whose JSON keys the backend reads (DATABASE_URL, IDENTITY_DATABASE_URL and the 32-byte keys). Its value is set
# out of band; OpenTofu never sees secret material.

data "aws_region" "current" {}

locals {
  backend_secret_keys = [
    "DATABASE_URL",
    "IDENTITY_DATABASE_URL",
    "PID_HMAC_PEPPER",
    "SESSION_KEY_KEK",
    "BACKEND_X25519_PRIVATE_KEY",
    "RELEASE_PACK_SIGNING_KEY",
    "IDENTITY_VAULT_KEY",
  ]
  backend_env = merge({
    ENV              = var.environment
    AUTH_MODE        = "oidc"
    OIDC_JWKS_URL    = var.oidc_jwks_url
    OIDC_ROLES_CLAIM = "cognito:groups"
    JWT_ISSUER       = var.oidc_issuer
    JWT_AUDIENCE     = var.oidc_audience
    API_CORS_ORIGINS = join(",", var.cors_origins)
    PUBLIC_BASE_URL  = var.public_base_url
    LOG_JSON         = "true"
    DATA_DIR         = "/var/lib/shriii"
    # Set OTEL_ENABLED / OTEL_EXPORTER_OTLP_ENDPOINT through extra_backend_env once a collector exists (PLT-06).
    OTEL_ENABLED = "false"
  }, var.extra_backend_env)

  services = {
    api = {
      image   = "${var.repository_urls["api"]}:${var.image_tag}"
      cpu     = var.api_cpu
      memory  = var.api_memory
      count   = var.api_desired_count
      port    = 8000
      command = null
      health  = ["CMD", "python", "/usr/local/bin/shriii-healthcheck", "http", "http://127.0.0.1:8000/healthz"]
      backend = true
    }
    worker = {
      image   = "${var.repository_urls["worker"]}:${var.image_tag}"
      cpu     = var.worker_cpu
      memory  = var.worker_memory
      count   = var.worker_desired_count
      port    = null
      command = null
      health  = ["CMD", "python", "/usr/local/bin/shriii-healthcheck", "db"]
      backend = true
    }
    web = {
      image   = "${var.repository_urls["web"]}:${var.image_tag}"
      cpu     = var.web_cpu
      memory  = var.web_memory
      count   = var.web_desired_count
      port    = 3000
      command = null
      health  = ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"]
      backend = false
    }
  }
  task_definitions = merge(local.services, {
    migrate = {
      image   = "${var.repository_urls["api"]}:${var.image_tag}"
      cpu     = 512
      memory  = 1024
      count   = 0
      port    = null
      command = ["sh", "-c", "shriii-api migrate && shriii-api seed"]
      health  = null
      backend = true
    }
  })
}

resource "aws_ecs_cluster" "this" {
  name = var.name
  setting {
    name  = "containerInsights"
    value = "enhanced"
  }
  tags = var.tags
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]
  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

resource "aws_secretsmanager_secret" "backend" {
  name                    = "${var.name}/backend"
  description             = "SHRIII backend runtime secrets (JSON keys: ${join(", ", local.backend_secret_keys)})"
  kms_key_id              = var.secrets_kms_key_arn
  recovery_window_in_days = 30
  tags                    = var.tags
}

resource "aws_cloudwatch_log_group" "service" {
  for_each          = local.task_definitions
  name              = "/shriii/${var.name}/${each.key}"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.logs_kms_key_arn
  tags              = var.tags
}

# ------------------------------------------------------------------------------------------------- IAM

data "aws_iam_policy_document" "tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${var.name}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.tasks_assume.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secrets" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.backend.arn]
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = [var.secrets_kms_key_arn]
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  name   = "backend-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets.json
}

resource "aws_iam_role" "task" {
  name               = "${var.name}-ecs-task"
  assume_role_policy = data.aws_iam_policy_document.tasks_assume.json
  tags               = var.tags
}

data "aws_iam_policy_document" "task" {
  statement {
    sid       = "DataBuckets"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket", "s3:GetObjectVersion"]
    resources = flatten([for arn in var.bucket_arns : [arn, "${arn}/*"]])
  }
  statement {
    sid       = "EnvelopeEncryption"
    actions   = ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey"]
    resources = var.task_kms_key_arns
  }
  statement {
    sid       = "Telemetry"
    actions   = ["cloudwatch:PutMetricData", "xray:PutTraceSegments", "xray:PutTelemetryRecords"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "task" {
  name   = "shriii-task"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task.json
}

# --------------------------------------------------------------------------------------- networking + ALB

resource "aws_security_group" "alb" {
  name        = "${var.name}-alb"
  description = "Public HTTPS to the load balancer"
  vpc_id      = var.vpc_id
  tags        = merge(var.tags, { Name = "${var.name}-alb" })
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "HTTPS"
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  description       = "HTTP (redirected to HTTPS)"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_tasks" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.tasks.id
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 8000
  description                  = "To application tasks"
}

resource "aws_security_group" "tasks" {
  name        = "${var.name}-tasks"
  description = "Application tasks"
  vpc_id      = var.vpc_id
  tags        = merge(var.tags, { Name = "${var.name}-tasks" })
}

resource "aws_vpc_security_group_ingress_rule" "tasks_from_alb" {
  security_group_id            = aws_security_group.tasks.id
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 8000
  description                  = "From the load balancer"
}

resource "aws_vpc_security_group_egress_rule" "tasks_all" {
  security_group_id = aws_security_group.tasks.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
  description       = "Outbound (RDS, S3 endpoint, ECR, Cognito JWKS)"
}

resource "aws_lb" "this" {
  name                       = var.name
  load_balancer_type         = "application"
  internal                   = false
  security_groups            = [aws_security_group.alb.id]
  subnets                    = var.public_subnet_ids
  drop_invalid_header_fields = true
  enable_deletion_protection = var.deletion_protection
  idle_timeout               = 60
  tags                       = var.tags
}

resource "aws_lb_target_group" "this" {
  for_each             = { for k, v in local.services : k => v if v.port != null }
  name                 = "${var.name}-${each.key}"
  port                 = each.value.port
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = 30
  health_check {
    path                = each.key == "api" ? "/healthz" : "/"
    matcher             = "200-399"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
  tags = var.tags
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this["web"].arn
  }
}

resource "aws_lb_listener_rule" "api" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 10
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this["api"].arn
  }
  condition {
    path_pattern {
      # Only the versioned API and liveness go to FastAPI. Everything else under /api/* (e.g. the web app's
      # /api/auth/* OIDC callback) stays on Next.js; /docs, /openapi.json and /readyz (migration version,
      # database status) are not published on the internet-facing listener.
      values = ["/api/v1/*", "/healthz"]
    }
  }
}

# ------------------------------------------------------------------------------- tasks and services

resource "aws_ecs_task_definition" "this" {
  for_each                 = local.task_definitions
  family                   = "${var.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = each.value.cpu
  memory                   = each.value.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  volume {
    name = "data"
  }
  container_definitions = jsonencode([
    merge(
      {
        name                   = each.key
        image                  = each.value.image
        essential              = true
        readonlyRootFilesystem = false
        user                   = each.key == "web" ? "1000:1000" : "10001:10001"
        portMappings           = each.value.port == null ? [] : [{ containerPort = each.value.port, protocol = "tcp" }]
        environment = [
          for k, v in(each.value.backend ? local.backend_env : merge({
            API_BASE_URL     = var.internal_api_url
            API_PROXY_TARGET = var.internal_api_url
          }, var.extra_web_env)) :
          { name = k, value = v }
        ]
        secrets = each.value.backend ? [
          for k in local.backend_secret_keys : { name = k, valueFrom = "${aws_secretsmanager_secret.backend.arn}:${k}::" }
        ] : []
        mountPoints = each.value.backend ? [{ sourceVolume = "data", containerPath = "/var/lib/shriii" }] : []
        logConfiguration = {
          logDriver = "awslogs"
          options = {
            awslogs-group         = aws_cloudwatch_log_group.service[each.key].name
            awslogs-region        = data.aws_region.current.region
            awslogs-stream-prefix = each.key
          }
        }
        linuxParameters = { initProcessEnabled = true }
      },
      each.value.command == null ? {} : { command = each.value.command },
      each.value.health == null ? {} : {
        healthCheck = { command = each.value.health, interval = 30, timeout = 10, retries = 3, startPeriod = 30 }
      },
    )
  ])
  tags = var.tags
}

resource "aws_ecs_service" "this" {
  for_each               = local.services
  name                   = each.key
  cluster                = aws_ecs_cluster.this.id
  task_definition        = aws_ecs_task_definition.this[each.key].arn
  desired_count          = each.value.count
  launch_type            = "FARGATE"
  platform_version       = "LATEST"
  enable_execute_command = false
  propagate_tags         = "SERVICE"

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  dynamic "load_balancer" {
    for_each = each.value.port == null ? [] : [each.value.port]
    content {
      target_group_arn = aws_lb_target_group.this[each.key].arn
      container_name   = each.key
      container_port   = load_balancer.value
    }
  }

  depends_on = [aws_lb_listener.https]
  tags       = var.tags
}

resource "aws_appautoscaling_target" "api" {
  max_capacity       = var.api_max_count
  min_capacity       = var.api_desired_count
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.this["api"].name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "api_cpu" {
  name               = "${var.name}-api-cpu"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension
  service_namespace  = aws_appautoscaling_target.api.service_namespace
  target_tracking_scaling_policy_configuration {
    target_value = 60
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}
