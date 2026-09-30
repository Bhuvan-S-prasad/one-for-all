-- pgvector for semantic memory (M2, ADR-0004). The dev and self-host init
-- scripts already create it; this makes managed Postgres (cloud mode) match.
CREATE EXTENSION IF NOT EXISTS vector;
