-- HIVEMIND BYOD — curated memory-subgraph schema for the customer's Postgres.
-- 14 memory tables, FKs to global tables RELAXED + app triggers stripped (the engine does
-- audit/derive logic). Global user/org/key info stays in the ONE central Postgres. From prod.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE SCHEMA IF NOT EXISTS hivemind;

DO $$ BEGIN CREATE TYPE hivemind."MemoryScope" AS ENUM ('personal','project','team','organization'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE hivemind."MemoryType" AS ENUM ('fact','preference','decision','lesson','goal','event','relationship','synthesis','summary','conversation'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE hivemind."RelationshipType" AS ENUM ('Updates','Extends','Derives','Contradicts','PartOf','Mentions'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE hivemind."VisibilityScope" AS ENUM ('private','organization','public'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE public."MemoryType" AS ENUM ('fact','preference','decision','lesson','goal','event','relationship'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE public."RelationshipType" AS ENUM ('Updates','Extends','Derives'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE public."VisibilityScope" AS ENUM ('private','organization','public'); EXCEPTION WHEN duplicate_object THEN null; END $$;

--
-- PostgreSQL database dump
--

-- Dumped from database version 15.7
-- Dumped by pg_dump version 15.7

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: entity_mentions; Type: TABLE; Schema: hivemind; Owner: -
--

CREATE TABLE hivemind.entity_mentions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    entity_id uuid NOT NULL,
    document_id uuid,
    segment_id uuid,
    mention_text character varying(500) NOT NULL,
    start_offset integer,
    end_offset integer,
    confidence real DEFAULT 0.9 NOT NULL,
    context text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    memory_id uuid
);


--
-- Name: knowledge_documents; Type: TABLE; Schema: hivemind; Owner: -
--

CREATE TABLE hivemind.knowledge_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    org_id uuid NOT NULL,
    source_artifact_id uuid,
    document_type character varying(50) NOT NULL,
    title character varying(1000),
    source_platform character varying(50) NOT NULL,
    source_id character varying(500),
    source_url text,
    thread_id character varying(500),
    session_id character varying(500),
    parent_document_id uuid,
    document_date timestamp(6) with time zone,
    author character varying(500),
    participants text[] DEFAULT ARRAY[]::text[],
    tags text[] DEFAULT ARRAY[]::text[],
    language character varying(10) DEFAULT 'en'::character varying,
    word_count integer,
    parse_status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    parse_engine character varying(50),
    parse_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    structure_extracted boolean DEFAULT false NOT NULL,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    archived_at timestamp(6) with time zone
);


--
-- Name: knowledge_segments; Type: TABLE; Schema: hivemind; Owner: -
--

CREATE TABLE hivemind.knowledge_segments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    document_id uuid NOT NULL,
    user_id uuid NOT NULL,
    org_id uuid NOT NULL,
    segment_type character varying(50) NOT NULL,
    content text NOT NULL,
    content_hash character varying(64) NOT NULL,
    segment_index integer NOT NULL,
    parent_segment_id uuid,
    previous_segment_id uuid,
    depth integer DEFAULT 0 NOT NULL,
    start_offset integer,
    end_offset integer,
    start_page integer,
    end_page integer,
    word_count integer,
    embedding_model character varying(100) DEFAULT 'mistral-embed'::character varying,
    embedding_dimension integer DEFAULT 1024,
    vector_stored boolean DEFAULT false NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, content)) STORED,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: memory_derivations; Type: TABLE; Schema: hivemind; Owner: -
--

CREATE TABLE hivemind.memory_derivations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    memory_id uuid NOT NULL,
    derivation_method character varying(50) NOT NULL,
    derivation_agent character varying(100),
    prompt_template text,
    input_tokens integer,
    output_tokens integer,
    confidence real DEFAULT 0.8 NOT NULL,
    review_status character varying(20) DEFAULT 'unreviewed'::character varying NOT NULL,
    reviewed_by uuid,
    reviewed_at timestamp(6) with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: memory_entity_links; Type: TABLE; Schema: hivemind; Owner: -
--

CREATE TABLE hivemind.memory_entity_links (
    memory_id uuid NOT NULL,
    entity_id uuid NOT NULL,
    role character varying(40) DEFAULT 'mentioned'::character varying NOT NULL,
    confidence numeric(3,2) DEFAULT 1.00 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: memory_evidence_links; Type: TABLE; Schema: hivemind; Owner: -
--

CREATE TABLE hivemind.memory_evidence_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    memory_id uuid NOT NULL,
    document_id uuid,
    segment_id uuid,
    link_type character varying(50) DEFAULT 'supports'::character varying NOT NULL,
    confidence real DEFAULT 0.9 NOT NULL,
    excerpt text,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: memory_projects; Type: TABLE; Schema: hivemind; Owner: -
--

CREATE TABLE hivemind.memory_projects (
    memory_id uuid NOT NULL,
    project_id uuid NOT NULL,
    added_by uuid,
    added_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: vector_embeddings; Type: TABLE; Schema: hivemind; Owner: -
--

CREATE TABLE hivemind.vector_embeddings (
    memory_id uuid NOT NULL,
    qdrant_collection character varying(100) NOT NULL,
    qdrant_point_id uuid NOT NULL,
    embedding_version integer DEFAULT 1,
    last_reembedded_at timestamp with time zone,
    sync_status character varying(50) DEFAULT 'synced'::character varying,
    last_sync_attempt timestamp with time zone,
    sync_error_message text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: memories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memories (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    org_id uuid,
    content text NOT NULL,
    memory_type public."MemoryType" DEFAULT 'fact'::public."MemoryType",
    title character varying(500),
    tags text[],
    source_platform character varying(50),
    source_session_id character varying(255),
    source_message_id character varying(255),
    source_url text,
    is_latest boolean DEFAULT true,
    supersedes_id uuid,
    strength real DEFAULT 1.0,
    recall_count integer DEFAULT 0,
    importance_score real DEFAULT 0.5,
    last_confirmed_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    document_date timestamp with time zone,
    event_dates timestamp with time zone[],
    visibility public."VisibilityScope" DEFAULT 'private'::public."VisibilityScope",
    shared_with_orgs uuid[],
    embedding_model character varying(100) DEFAULT 'mistral-embed'::character varying,
    embedding_dimension integer DEFAULT 1024,
    embedding_version integer DEFAULT 1,
    processing_basis character varying(100) DEFAULT 'consent'::character varying,
    retention_until timestamp with time zone,
    export_blocked boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    deleted_at timestamp with time zone,
    project text,
    version integer DEFAULT 1 NOT NULL
);


--
-- Name: memory_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_versions (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    memory_id uuid NOT NULL,
    content_hash character varying(64) NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    is_latest boolean DEFAULT false NOT NULL,
    reason character varying(50) NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    related_memory_id uuid
);


--
-- Name: code_memory_metadata; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.code_memory_metadata (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    memory_id uuid NOT NULL,
    filepath text NOT NULL,
    language text NOT NULL,
    entity_type text,
    entity_name text,
    start_line integer,
    end_line integer,
    scope_chain text[] DEFAULT ARRAY[]::text[] NOT NULL,
    signatures text[] DEFAULT ARRAY[]::text[] NOT NULL,
    imports text[] DEFAULT ARRAY[]::text[] NOT NULL,
    dependencies text[] DEFAULT ARRAY[]::text[] NOT NULL,
    nws_count integer DEFAULT 0 NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: derivation_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.derivation_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_memory_id uuid NOT NULL,
    target_memory_id uuid NOT NULL,
    confidence double precision NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone
);


--
-- Name: relationships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.relationships (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    from_id uuid NOT NULL,
    to_id uuid NOT NULL,
    type public."RelationshipType" NOT NULL,
    confidence real DEFAULT 1.0,
    inference_model character varying(100),
    inference_prompt_hash character varying(64),
    metadata jsonb DEFAULT '{}'::jsonb,
    created_by character varying(50) DEFAULT 'system'::character varying,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: source_metadata; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_metadata (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    memory_id uuid NOT NULL,
    source_type text NOT NULL,
    source_id text,
    source_platform text,
    source_url text,
    thread_id text,
    parent_message_id text,
    ingested_at timestamp with time zone DEFAULT now() NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: entity_mentions entity_mentions_pkey; Type: CONSTRAINT; Schema: hivemind; Owner: -
--

ALTER TABLE ONLY hivemind.entity_mentions
    ADD CONSTRAINT entity_mentions_pkey PRIMARY KEY (id);


--
-- Name: knowledge_documents knowledge_documents_pkey; Type: CONSTRAINT; Schema: hivemind; Owner: -
--

ALTER TABLE ONLY hivemind.knowledge_documents
    ADD CONSTRAINT knowledge_documents_pkey PRIMARY KEY (id);


--
-- Name: knowledge_segments knowledge_segments_pkey; Type: CONSTRAINT; Schema: hivemind; Owner: -
--

ALTER TABLE ONLY hivemind.knowledge_segments
    ADD CONSTRAINT knowledge_segments_pkey PRIMARY KEY (id);


--
-- Name: memory_derivations memory_derivations_pkey; Type: CONSTRAINT; Schema: hivemind; Owner: -
--

ALTER TABLE ONLY hivemind.memory_derivations
    ADD CONSTRAINT memory_derivations_pkey PRIMARY KEY (id);


--
-- Name: memory_entity_links memory_entity_links_pkey; Type: CONSTRAINT; Schema: hivemind; Owner: -
--

ALTER TABLE ONLY hivemind.memory_entity_links
    ADD CONSTRAINT memory_entity_links_pkey PRIMARY KEY (memory_id, entity_id, role);


--
-- Name: memory_evidence_links memory_evidence_links_pkey; Type: CONSTRAINT; Schema: hivemind; Owner: -
--

ALTER TABLE ONLY hivemind.memory_evidence_links
    ADD CONSTRAINT memory_evidence_links_pkey PRIMARY KEY (id);


--
-- Name: memory_projects memory_projects_pkey; Type: CONSTRAINT; Schema: hivemind; Owner: -
--

ALTER TABLE ONLY hivemind.memory_projects
    ADD CONSTRAINT memory_projects_pkey PRIMARY KEY (memory_id, project_id);


--
-- Name: vector_embeddings vector_embeddings_pkey; Type: CONSTRAINT; Schema: hivemind; Owner: -
--

ALTER TABLE ONLY hivemind.vector_embeddings
    ADD CONSTRAINT vector_embeddings_pkey PRIMARY KEY (memory_id);


--
-- Name: code_memory_metadata code_memory_metadata_memory_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.code_memory_metadata
    ADD CONSTRAINT code_memory_metadata_memory_id_key UNIQUE (memory_id);


--
-- Name: code_memory_metadata code_memory_metadata_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.code_memory_metadata
    ADD CONSTRAINT code_memory_metadata_pkey PRIMARY KEY (id);


--
-- Name: derivation_jobs derivation_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.derivation_jobs
    ADD CONSTRAINT derivation_jobs_pkey PRIMARY KEY (id);


--
-- Name: memories memories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_pkey PRIMARY KEY (id);


--
-- Name: memory_versions memory_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_versions
    ADD CONSTRAINT memory_versions_pkey PRIMARY KEY (id);


--
-- Name: relationships relationships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.relationships
    ADD CONSTRAINT relationships_pkey PRIMARY KEY (id);


--
-- Name: source_metadata source_metadata_memory_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_metadata
    ADD CONSTRAINT source_metadata_memory_id_key UNIQUE (memory_id);


--
-- Name: source_metadata source_metadata_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_metadata
    ADD CONSTRAINT source_metadata_pkey PRIMARY KEY (id);


--
-- Name: entity_mentions_created_at_idx; Type: INDEX; Schema: hivemind; Owner: -
--

CREATE INDEX entity_mentions_created_at_idx ON hivemind.entity_mentions USING btree (created_at DESC);


--
-- Name: entity_mentions_document_id_idx; Type: INDEX; Schema: hivemind; Owner: -
--

CREATE INDEX entity_mentions_document_id_idx ON hivemind.entity_mentions USING btree (document_id);


--
-- Name: entity_mentions_entity_id_idx; Type: INDEX; Schema: hivemind; Owner: -
--

CREATE INDEX entity_mentions_entity_id_idx ON hivemind.entity_mentions USING btree (entity_id);


--
-- Name: entity_mentions_memory_id_idx; Type: INDEX; Schema: hivemind; Owner: -
--

CREATE INDEX entity_mentions_memory_id_idx ON hivemind.entity_mentions USING btree (memory_id);


--
-- Name: entity_mentions_segment_id_idx; Type: INDEX; Schema: hivemind; Owner: -
--

CREATE INDEX entity_mentions_segment_id_idx ON hivemind.entity_mentions USING btree (segment_id);


--
-- Name: knowledge_documents_created_at_idx; Type: INDEX; Schema: hivemind; Owner: -
--

CREATE INDEX knowledge_documents_created_at_idx ON hivemind.knowledge_documents USING btree (created_at DESC);


--
-- Name: knowledge_documents_document_date_idx; Type: INDEX; Schema: hivemind; Owner: -
--

CREATE INDEX knowledge_documents_document_date_idx ON hivemind.knowledge_documents USING btree (document_date DESC);


--
-- Name: knowledge_documents_document_type_idx; Type: INDEX; Schema: hivemind; Owner: -
--

CREATE INDEX knowledge_documents_document_type_idx ON hivemind.knowledge_documents USING btree (document_type);


--
-- Name: knowledge_documents_parent_document_id_idx; Type: INDEX; Schema: hivemind; Owner: -
--

CREATE INDEX knowledge_documents_parent_document_id_idx ON hivemind.knowledge_documents USING btree (parent_document_id);


--
-- Name: knowledge_documents_parse_status_idx; Type: INDEX; Schema: hivemind; Owner: -
--

CREATE INDEX knowledge_documents_parse_status_idx ON hivemind.knowledge_documents USING btree (parse_status);


--
-- Name: knowledge_documents_session_id_idx; Type: INDEX; Schema: hivemind; Owner: -
--

CREATE INDEX knowledge_documents_session_id_idx ON hivemind.knowledge_documents USING btree (session_id);


--
-- Name: knowledge_documents_source_platform_idx; Type: INDEX; Schema: hivemind; Owner: -
--

CREATE INDEX knowledge_documents_source_platform_idx ON hivemind.knowledge_documents USING btree (source_platform);


--
-- Name: knowledge_documents_tags_idx; Type: INDEX; Schema: hivemind; Owner: -
--

CREATE INDEX knowledge_documents_tags_idx ON hivemind.knowledge_documents USING gin (tags);


--
-- Name: knowledge_documents_thread_id_idx; Type: INDEX; Schema: hivemind; Owner: -
--

CREATE INDEX knowledge_documents_thread_id_idx ON hivemind.knowledge_documents USING btree (thread_id);


--
-- Name: knowledge_documents_user_id_org_id_idx; Type: INDEX; Schema: hivemind; Owner: -
--

CREATE INDEX knowledge_documents_user_id_org_id_idx ON hivemind.knowledge_documents USING btree (user_id, org_id);


--
-- Name: knowledge_documents_user_id_org_id_source_platform_sourc_key; Type: INDEX; Schema: hivemind; Owner: -
--

CREATE UNIQUE INDEX knowledge_documents_user_id_org_id_source_platform_sourc_key ON hivemind.knowledge_documents USING btree (user_id, org_id, source_platform, source_id);


--
-- Name: knowledge_segments_content_hash_idx; Type: INDEX; Schema: hivemind; Owner: -
--

CREATE INDEX knowledge_segments_content_hash_idx ON hivemind.knowledge_segments USING btree (content_hash);

-- FTS is language-neutral so German identifiers and inflections remain recallable.
CREATE INDEX knowledge_segments_content_tsv_idx ON hivemind.knowledge_segments USING gin (content_tsv);


--
-- Name: knowledge_segments_created_at_idx; Type: INDEX; Schema: hivemind; Owner: -
--

CREATE INDEX knowledge_segments_created_at_idx ON hivemind.knowledge_segments USING btree (created_at DESC);


--
-- Name: knowledge_segments_document_id_idx; Type: INDEX; Schema: hivemind; Owner: -
--

CREATE INDEX knowledge_segments_document_id_idx ON hivemind.knowledge_segments USING btree (document_id);


--
-- Name: knowledge_segments_document_id_segment_index_key; Type: INDEX; Schema: hivemind; Owner: -
--

CREATE UNIQUE INDEX knowledge_segments_document_id_segment_index_key ON hivemind.knowledge_segments USING btree (document_id, segment_index);


--
-- Name: knowledge_segments_parent_segment_id_idx; Type: INDEX; Schema: hivemind; Owner: -
--

CREATE INDEX knowledge_segments_parent_segment_id_idx ON hivemind.knowledge_segments USING btree (parent_segment_id);


--
-- Name: knowledge_segments_previous_segment_id_idx; Type: INDEX; Schema: hivemind; Owner: -
--

CREATE INDEX knowledge_segments_previous_segment_id_idx ON hivemind.knowledge_segments USING btree (previous_segment_id);


--
-- Name: knowledge_segments_segment_type_idx; Type: INDEX; Schema: hivemind; Owner: -
--

CREATE INDEX knowledge_segments_segment_type_idx ON hivemind.knowledge_segments USING btree (segment_type);


--
-- Name: knowledge_segments_user_id_org_id_idx; Type: INDEX; Schema: hivemind; Owner: -
--

CREATE INDEX knowledge_segments_user_id_org_id_idx ON hivemind.knowledge_segments USING btree (user_id, org_id);


--
-- Name: knowledge_segments_vector_stored_idx; Type: INDEX; Schema: hivemind; Owner: -
--

CREATE INDEX knowledge_segments_vector_stored_idx ON hivemind.knowledge_segments USING btree (vector_stored);


--
-- Name: memory_derivations_created_at_idx; Type: INDEX; Schema: hivemind; Owner: -
--

CREATE INDEX memory_derivations_created_at_idx ON hivemind.memory_derivations USING btree (created_at DESC);


--
-- Name: memory_derivations_derivation_method_idx; Type: INDEX; Schema: hivemind; Owner: -
--

CREATE INDEX memory_derivations_derivation_method_idx ON hivemind.memory_derivations USING btree (derivation_method);


--
-- Name: memory_derivations_memory_id_key; Type: INDEX; Schema: hivemind; Owner: -
--

CREATE UNIQUE INDEX memory_derivations_memory_id_key ON hivemind.memory_derivations USING btree (memory_id);


--
-- Name: memory_derivations_review_status_idx; Type: INDEX; Schema: hivemind; Owner: -
--

CREATE INDEX memory_derivations_review_status_idx ON hivemind.memory_derivations USING btree (review_status);


--
-- Name: memory_entity_links_entity_idx; Type: INDEX; Schema: hivemind; Owner: -
--

CREATE INDEX memory_entity_links_entity_idx ON hivemind.memory_entity_links USING btree (entity_id);


--
-- Name: memory_evidence_links_document_id_idx; Type: INDEX; Schema: hivemind; Owner: -
--

CREATE INDEX memory_evidence_links_document_id_idx ON hivemind.memory_evidence_links USING btree (document_id);


--
-- Name: memory_evidence_links_link_type_idx; Type: INDEX; Schema: hivemind; Owner: -
--

CREATE INDEX memory_evidence_links_link_type_idx ON hivemind.memory_evidence_links USING btree (link_type);


--
-- Name: memory_evidence_links_memory_id_document_id_segment_id_key; Type: INDEX; Schema: hivemind; Owner: -
--

CREATE UNIQUE INDEX memory_evidence_links_memory_id_document_id_segment_id_key ON hivemind.memory_evidence_links USING btree (memory_id, document_id, segment_id);


--
-- Name: memory_evidence_links_memory_id_idx; Type: INDEX; Schema: hivemind; Owner: -
--

CREATE INDEX memory_evidence_links_memory_id_idx ON hivemind.memory_evidence_links USING btree (memory_id);


--
-- Name: memory_evidence_links_segment_id_idx; Type: INDEX; Schema: hivemind; Owner: -
--

CREATE INDEX memory_evidence_links_segment_id_idx ON hivemind.memory_evidence_links USING btree (segment_id);


--
-- Name: memory_projects_memory_id_idx; Type: INDEX; Schema: hivemind; Owner: -
--

CREATE INDEX memory_projects_memory_id_idx ON hivemind.memory_projects USING btree (memory_id);


--
-- Name: memory_projects_project_id_idx; Type: INDEX; Schema: hivemind; Owner: -
--

CREATE INDEX memory_projects_project_id_idx ON hivemind.memory_projects USING btree (project_id);


--
-- Name: vector_embeddings_sync_status_last_sync_attempt_idx; Type: INDEX; Schema: hivemind; Owner: -
--

CREATE INDEX vector_embeddings_sync_status_last_sync_attempt_idx ON hivemind.vector_embeddings USING btree (sync_status, last_sync_attempt);


--
-- Name: idx_code_memory_metadata_filepath; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_code_memory_metadata_filepath ON public.code_memory_metadata USING btree (filepath);


--
-- Name: idx_code_memory_metadata_language; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_code_memory_metadata_language ON public.code_memory_metadata USING btree (language);


--
-- Name: idx_derivation_jobs_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_derivation_jobs_source ON public.derivation_jobs USING btree (source_memory_id);


--
-- Name: idx_derivation_jobs_status_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_derivation_jobs_status_created ON public.derivation_jobs USING btree (status, created_at);


--
-- Name: idx_derivation_jobs_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_derivation_jobs_target ON public.derivation_jobs USING btree (target_memory_id);


--
-- Name: idx_memory_versions_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_versions_created ON public.memory_versions USING btree (created_at);


--
-- Name: idx_memory_versions_is_latest; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_versions_is_latest ON public.memory_versions USING btree (is_latest);


--
-- Name: idx_memory_versions_memory; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_versions_memory ON public.memory_versions USING btree (memory_id);


--
-- Name: idx_memory_versions_memory_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_versions_memory_created ON public.memory_versions USING btree (memory_id, created_at DESC);


--
-- Name: idx_memory_versions_memory_latest; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_versions_memory_latest ON public.memory_versions USING btree (memory_id, is_latest);


--
-- Name: idx_memory_versions_reason; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_versions_reason ON public.memory_versions USING btree (reason);


--
-- Name: idx_memory_versions_related_memory; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_versions_related_memory ON public.memory_versions USING btree (related_memory_id);


--
-- Name: idx_memory_versions_version; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_versions_version ON public.memory_versions USING btree (version);


--
-- Name: idx_source_metadata_platform; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_source_metadata_platform ON public.source_metadata USING btree (source_platform);


--
-- Name: idx_source_metadata_type_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_source_metadata_type_id ON public.source_metadata USING btree (source_type, source_id);


--
-- Name: memories_content_fts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memories_content_fts_idx ON public.memories USING gin (to_tsvector('english'::regconfig, content));


--
-- Name: memories_deleted_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memories_deleted_at_idx ON public.memories USING btree (deleted_at) WHERE (deleted_at IS NOT NULL);


--
-- Name: memories_document_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memories_document_date_idx ON public.memories USING btree (document_date DESC);


--
-- Name: memories_is_latest_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memories_is_latest_idx ON public.memories USING btree (is_latest) WHERE (is_latest = true);


--
-- Name: memories_memory_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memories_memory_type_idx ON public.memories USING btree (memory_type);


--
-- Name: memories_org_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memories_org_id_idx ON public.memories USING btree (org_id);


--
-- Name: memories_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memories_project_idx ON public.memories USING btree (project);


--
-- Name: memories_source_platform_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memories_source_platform_idx ON public.memories USING btree (source_platform);


--
-- Name: memories_strength_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memories_strength_idx ON public.memories USING btree (strength DESC);


--
-- Name: memories_tags_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memories_tags_idx ON public.memories USING gin (tags);


--
-- Name: memories_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memories_user_id_idx ON public.memories USING btree (user_id);


--
-- Name: memories_version_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memories_version_idx ON public.memories USING btree (version);


--
-- Name: relationships_from_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX relationships_from_id_idx ON public.relationships USING btree (from_id);


--
-- Name: relationships_from_id_to_id_type_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX relationships_from_id_to_id_type_key ON public.relationships USING btree (from_id, to_id, type);


--
-- Name: relationships_from_id_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX relationships_from_id_type_idx ON public.relationships USING btree (from_id, type);


--
-- Name: relationships_to_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX relationships_to_id_idx ON public.relationships USING btree (to_id);


--
-- Name: relationships_to_id_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX relationships_to_id_type_idx ON public.relationships USING btree (to_id, type);


--
-- Name: relationships_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX relationships_type_idx ON public.relationships USING btree (type);


--
-- Name: memories audit_memories_is_latest_changes; Type: TRIGGER; Schema: public; Owner: -
--



--
-- Name: memory_versions audit_memory_versions_changes; Type: TRIGGER; Schema: public; Owner: -
--



--
-- Name: relationships trigger_memory_derive; Type: TRIGGER; Schema: public; Owner: -
--



--
-- Name: relationships trigger_memory_extend; Type: TRIGGER; Schema: public; Owner: -
--



--
-- Name: relationships trigger_memory_update; Type: TRIGGER; Schema: public; Owner: -
--



--
-- Name: entity_mentions entity_mentions_document_id_fkey; Type: FK CONSTRAINT; Schema: hivemind; Owner: -
--



--
-- Name: entity_mentions entity_mentions_entity_id_fkey; Type: FK CONSTRAINT; Schema: hivemind; Owner: -
--



--
-- Name: entity_mentions entity_mentions_memory_id_fkey; Type: FK CONSTRAINT; Schema: hivemind; Owner: -
--



--
-- Name: entity_mentions entity_mentions_segment_id_fkey; Type: FK CONSTRAINT; Schema: hivemind; Owner: -
--



--
-- Name: knowledge_documents knowledge_documents_parent_document_id_fkey; Type: FK CONSTRAINT; Schema: hivemind; Owner: -
--



--
-- Name: knowledge_documents knowledge_documents_source_artifact_id_fkey; Type: FK CONSTRAINT; Schema: hivemind; Owner: -
--



--
-- Name: knowledge_segments knowledge_segments_document_id_fkey; Type: FK CONSTRAINT; Schema: hivemind; Owner: -
--



--
-- Name: knowledge_segments knowledge_segments_parent_segment_id_fkey; Type: FK CONSTRAINT; Schema: hivemind; Owner: -
--



--
-- Name: knowledge_segments knowledge_segments_previous_segment_id_fkey; Type: FK CONSTRAINT; Schema: hivemind; Owner: -
--



--
-- Name: memory_derivations memory_derivations_memory_id_fkey; Type: FK CONSTRAINT; Schema: hivemind; Owner: -
--



--
-- Name: memory_entity_links memory_entity_links_entity_id_fkey; Type: FK CONSTRAINT; Schema: hivemind; Owner: -
--



--
-- Name: memory_entity_links memory_entity_links_memory_id_fkey; Type: FK CONSTRAINT; Schema: hivemind; Owner: -
--



--
-- Name: memory_evidence_links memory_evidence_links_document_id_fkey; Type: FK CONSTRAINT; Schema: hivemind; Owner: -
--



--
-- Name: memory_evidence_links memory_evidence_links_memory_id_fkey; Type: FK CONSTRAINT; Schema: hivemind; Owner: -
--



--
-- Name: memory_evidence_links memory_evidence_links_segment_id_fkey; Type: FK CONSTRAINT; Schema: hivemind; Owner: -
--



--
-- Name: memory_projects memory_projects_added_by_fkey; Type: FK CONSTRAINT; Schema: hivemind; Owner: -
--



--
-- Name: memory_projects memory_projects_memory_id_fkey; Type: FK CONSTRAINT; Schema: hivemind; Owner: -
--



--
-- Name: memory_projects memory_projects_project_id_fkey; Type: FK CONSTRAINT; Schema: hivemind; Owner: -
--



--
-- Name: vector_embeddings vector_embeddings_memory_id_fkey; Type: FK CONSTRAINT; Schema: hivemind; Owner: -
--



--
-- Name: code_memory_metadata code_memory_metadata_memory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--



--
-- Name: derivation_jobs derivation_jobs_source_memory_id_fkey_pub_legacy; Type: FK CONSTRAINT; Schema: public; Owner: -
--



--
-- Name: derivation_jobs derivation_jobs_target_memory_id_fkey_pub_legacy; Type: FK CONSTRAINT; Schema: public; Owner: -
--



--
-- Name: memories memories_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--



--
-- Name: memories memories_supersedes_id_fkey_pub_legacy; Type: FK CONSTRAINT; Schema: public; Owner: -
--



--
-- Name: memories memories_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--



--
-- Name: memory_versions memory_versions_memory_id_fkey_pub_legacy; Type: FK CONSTRAINT; Schema: public; Owner: -
--



--
-- Name: memory_versions memory_versions_related_memory_id_fkey_pub_legacy; Type: FK CONSTRAINT; Schema: public; Owner: -
--



--
-- Name: relationships relationships_from_id_fkey_pub_legacy; Type: FK CONSTRAINT; Schema: public; Owner: -
--



--
-- Name: relationships relationships_to_id_fkey_pub_legacy; Type: FK CONSTRAINT; Schema: public; Owner: -
--



--
-- Name: source_metadata source_metadata_memory_id_fkey_pub_legacy; Type: FK CONSTRAINT; Schema: public; Owner: -
--



--
-- PostgreSQL database dump complete
--

-- Phase 0 canonical knowledge foundation (additive; relationships remain memory lineage only).
CREATE TABLE IF NOT EXISTS hivemind.canonical_predicates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name varchar(80) NOT NULL, version integer NOT NULL DEFAULT 1,
  aliases text[] NOT NULL DEFAULT '{}', inverse_name varchar(80), active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(name, version)
);
CREATE TABLE IF NOT EXISTS hivemind.canonical_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, claim_key varchar(128) NOT NULL,
  subject_entity_id uuid NOT NULL, predicate_id uuid NOT NULL, object_entity_id uuid, object_literal jsonb,
  qualifiers jsonb NOT NULL DEFAULT '{}', confidence numeric(4,3) NOT NULL DEFAULT 1,
  assertion_status varchar(32) NOT NULL DEFAULT 'user_asserted', lifecycle_status varchar(24) NOT NULL DEFAULT 'active',
  valid_from timestamptz, valid_to timestamptz, known_at timestamptz NOT NULL DEFAULT now(),
  processing_version integer NOT NULL DEFAULT 1, source_digest varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id, claim_key), CHECK ((object_entity_id IS NOT NULL) <> (object_literal IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS hivemind.claim_evidence_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), claim_id uuid NOT NULL, memory_id uuid NOT NULL,
  exact_quote text, start_offset integer, end_offset integer, source_digest varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(claim_id, memory_id, source_digest)
);
CREATE TABLE IF NOT EXISTS hivemind.memory_projection_states (
  memory_id uuid PRIMARY KEY, organization_id uuid NOT NULL, admitted_mode varchar(16) NOT NULL DEFAULT 'off',
  processing_version integer NOT NULL DEFAULT 1, memory_status varchar(20) NOT NULL DEFAULT 'complete',
  entities_status varchar(20) NOT NULL DEFAULT 'pending', claims_status varchar(20) NOT NULL DEFAULT 'pending',
  lineage_status varchar(20) NOT NULL DEFAULT 'complete', vector_status varchar(20) NOT NULL DEFAULT 'pending',
  remote_status varchar(20), receipt jsonb, last_error text, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hivemind.canonical_projection_nonces (
  nonce varchar(200) PRIMARY KEY, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
