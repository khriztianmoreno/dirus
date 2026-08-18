-- D4 (design.md D-G): enable pgvector now so it is available for the
-- future doc_chunks table, without creating any vector(...) column yet.
CREATE EXTENSION IF NOT EXISTS vector;
