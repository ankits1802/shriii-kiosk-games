output "user_pool_id" {
  value = aws_cognito_user_pool.this.id
}

output "issuer_url" {
  description = "OIDC issuer (JWKS at <issuer>/.well-known/jwks.json)."
  value       = "https://${aws_cognito_user_pool.this.endpoint}"
}

output "jwks_url" {
  value = "https://${aws_cognito_user_pool.this.endpoint}/.well-known/jwks.json"
}

output "web_client_id" {
  value = aws_cognito_user_pool_client.web.id
}

output "web_client_secret" {
  value     = aws_cognito_user_pool_client.web.client_secret
  sensitive = true
}

output "hosted_ui_domain" {
  value = aws_cognito_user_pool_domain.this.domain
}
