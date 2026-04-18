-- Extensions and schemas for the shared test stack.
-- Runs once on container init (Postgres executes /docker-entrypoint-initdb.d/*.sql in sorted order).
-- Idempotent on purpose: re-running locally via `docker compose up` after a reset is safe.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE SCHEMA IF NOT EXISTS analytics;
