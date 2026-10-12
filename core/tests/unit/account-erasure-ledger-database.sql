\set ON_ERROR_STOP on
CREATE SCHEMA hivemind;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE hivemind.knowledge_documents(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid);
CREATE TABLE hivemind.source_artifacts(LIKE hivemind.knowledge_documents INCLUDING ALL);
CREATE TABLE hivemind.knowledge_ingest_jobs(LIKE hivemind.knowledge_documents INCLUDING ALL);
CREATE TABLE hivemind.knowledge_segments(LIKE hivemind.knowledge_documents INCLUDING ALL);
CREATE TABLE hivemind.memories(LIKE hivemind.knowledge_documents INCLUDING ALL);
