-- Install Apache AGE extension
-- This runs automatically on database initialization

-- Install required dependencies (runs as root in init container)
-- Note: For production, use a custom Dockerfile with AGE pre-installed

-- Create AGE extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Load AGE (will be available after apt install in production)
-- For local dev, we'll skip AGE and use regular PostgreSQL for now
-- AGE can be added later without changing application logic

-- Create HIVE-MIND schema
CREATE SCHEMA IF NOT EXISTS hivemind;

-- Log success
DO $$
BEGIN
    RAISE NOTICE 'HIVE-MIND PostgreSQL initialization complete';
    RAISE NOTICE 'Extensions installed: uuid-ossp, pgcrypto';
    RAISE NOTICE 'Schema created: hivemind';
END $$;
