# CloudWatch alarms for the platform (PLT-06 baseline): API 5xx and latency, unhealthy targets, ECS services below
# desired count, RDS CPU / storage / connections. Product, timing and data-quality panels (Grafana) and the kiosk
# fleet alarms (offline > 30 min, DLQ > 0.5 %, ...) are emitted as custom metrics by the API and added here
# when PLT-06 lands.

resource "aws_sns_topic" "alarms" {
  name              = "${var.name}-alarms"
  kms_master_key_id = var.sns_kms_key_id
  tags              = var.tags
}

resource "aws_sns_topic_subscription" "email" {
  for_each  = toset(var.alarm_emails)
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = each.value
}

locals {
  actions = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name          = "${var.name}-alb-target-5xx"
  alarm_description   = "Application 5xx responses above threshold"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  dimensions          = { LoadBalancer = var.alb_arn_suffix }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 2
  threshold           = var.alb_5xx_threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions
  tags                = var.tags
}

resource "aws_cloudwatch_metric_alarm" "api_latency" {
  alarm_name          = "${var.name}-api-p99-latency"
  alarm_description   = "API p99 target response time above threshold"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  dimensions          = { LoadBalancer = var.alb_arn_suffix, TargetGroup = var.target_group_arn_suffixes["api"] }
  extended_statistic  = "p99"
  period              = 300
  evaluation_periods  = 3
  threshold           = var.api_p99_seconds
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  tags                = var.tags
}

resource "aws_cloudwatch_metric_alarm" "unhealthy_targets" {
  for_each            = var.target_group_arn_suffixes
  alarm_name          = "${var.name}-${each.key}-unhealthy-targets"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  dimensions          = { LoadBalancer = var.alb_arn_suffix, TargetGroup = each.value }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 5
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions
  tags                = var.tags
}

resource "aws_cloudwatch_metric_alarm" "ecs_running" {
  for_each            = var.ecs_services
  alarm_name          = "${var.name}-${each.key}-running-tasks"
  alarm_description   = "ECS service ${each.key} has fewer running tasks than ${each.value}"
  namespace           = "ECS/ContainerInsights"
  metric_name         = "RunningTaskCount"
  dimensions          = { ClusterName = var.ecs_cluster_name, ServiceName = each.key }
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 5
  threshold           = each.value
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions
  tags                = var.tags
}

resource "aws_cloudwatch_metric_alarm" "rds_cpu" {
  alarm_name          = "${var.name}-rds-cpu"
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  dimensions          = { DBInstanceIdentifier = var.rds_instance_id }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = local.actions
  ok_actions          = local.actions
  tags                = var.tags
}

resource "aws_cloudwatch_metric_alarm" "rds_storage" {
  alarm_name          = "${var.name}-rds-free-storage"
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  dimensions          = { DBInstanceIdentifier = var.rds_instance_id }
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 2
  threshold           = var.rds_min_free_storage_bytes
  comparison_operator = "LessThanThreshold"
  alarm_actions       = local.actions
  ok_actions          = local.actions
  tags                = var.tags
}

resource "aws_cloudwatch_dashboard" "platform" {
  dashboard_name = "${var.name}-platform"
  dashboard_body = jsonencode({
    widgets = [
      {
        type = "metric", x = 0, y = 0, width = 12, height = 6
        properties = {
          title  = "API requests and 5xx"
          region = var.region
          stat   = "Sum"
          period = 300
          metrics = [
            ["AWS/ApplicationELB", "RequestCount", "LoadBalancer", var.alb_arn_suffix],
            ["AWS/ApplicationELB", "HTTPCode_Target_5XX_Count", "LoadBalancer", var.alb_arn_suffix],
          ]
        }
      },
      {
        type = "metric", x = 12, y = 0, width = 12, height = 6
        properties = {
          title  = "RDS CPU and connections"
          region = var.region
          stat   = "Average"
          period = 300
          metrics = [
            ["AWS/RDS", "CPUUtilization", "DBInstanceIdentifier", var.rds_instance_id],
            ["AWS/RDS", "DatabaseConnections", "DBInstanceIdentifier", var.rds_instance_id],
          ]
        }
      },
    ]
  })
}
