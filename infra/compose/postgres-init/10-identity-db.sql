-- Runs once on an empty data directory (docker-entrypoint-initdb.d).
-- The identity vault lives in its own database with its own Alembic environment (PRV-04).
CREATE DATABASE shriii_identity OWNER shriii;
