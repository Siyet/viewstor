-- Shared database for ClickHouse e2e tests.
-- ClickHouse runs /docker-entrypoint-initdb.d/*.sql sequentially against the default database;
-- use explicit `ON CLUSTER` only in multi-node setups (we have one).

CREATE DATABASE IF NOT EXISTS viewstor_test;
