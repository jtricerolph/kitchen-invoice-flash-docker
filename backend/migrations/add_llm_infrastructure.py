"""
Migration: Add LLM infrastructure — settings columns, usage log table, analysis cache table.
LLM FEATURE — see LLM-MANIFEST.md for removal instructions
"""
import asyncio
from sqlalchemy import text
from database import engine


async def migrate():
    async with engine.begin() as conn:
        # 1. Add LLM columns to kitchen_settings
        for col_sql in [
            "ALTER TABLE kitchen_settings ADD COLUMN IF NOT EXISTS llm_enabled BOOLEAN DEFAULT FALSE",
            "ALTER TABLE kitchen_settings ADD COLUMN IF NOT EXISTS anthropic_api_key VARCHAR(500)",
            "ALTER TABLE kitchen_settings ADD COLUMN IF NOT EXISTS llm_model VARCHAR(100) DEFAULT 'claude-haiku-4-5-20251001'",
            "ALTER TABLE kitchen_settings ADD COLUMN IF NOT EXISTS llm_confidence_threshold NUMERIC(3,2) DEFAULT 0.80",
            "ALTER TABLE kitchen_settings ADD COLUMN IF NOT EXISTS llm_monthly_token_limit INTEGER DEFAULT 500000",
            """ALTER TABLE kitchen_settings ADD COLUMN IF NOT EXISTS llm_features_enabled JSONB DEFAULT '{
                "label_parsing": true, "invoice_assist": true, "ingredient_match": true,
                "recipe_scanning": true, "line_item_reconciliation": true, "menu_description": true,
                "dispute_email": true, "duplicate_detection": true, "supplier_alias": true, "yield_estimation": true
            }'::jsonb""",
        ]:
            try:
                await conn.execute(text(col_sql))
            except Exception:
                pass
        print("+ Added LLM columns to kitchen_settings")

        # 2. Create llm_usage_log table
        await conn.execute(text("""
            CREATE TABLE IF NOT EXISTS llm_usage_log (
                id SERIAL PRIMARY KEY,
                kitchen_id INTEGER NOT NULL,
                feature VARCHAR(50) NOT NULL,
                model VARCHAR(100) NOT NULL,
                input_tokens INTEGER DEFAULT 0,
                output_tokens INTEGER DEFAULT 0,
                latency_ms INTEGER DEFAULT 0,
                success BOOLEAN DEFAULT TRUE,
                error_message TEXT,
                created_at TIMESTAMP DEFAULT NOW()
            )
        """))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS idx_llm_usage_kitchen ON llm_usage_log(kitchen_id)"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS idx_llm_usage_feature ON llm_usage_log(feature)"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS idx_llm_usage_created ON llm_usage_log(created_at)"
        ))
        print("+ Created llm_usage_log table")

        # 3. Create llm_analysis_cache table
        await conn.execute(text("""
            CREATE TABLE IF NOT EXISTS llm_analysis_cache (
                id SERIAL PRIMARY KEY,
                kitchen_id INTEGER NOT NULL,
                feature VARCHAR(50) NOT NULL,
                input_hash VARCHAR(64) NOT NULL,
                result_json JSONB NOT NULL,
                model_used VARCHAR(100) NOT NULL,
                prompt_version VARCHAR(10) NOT NULL,
                created_at TIMESTAMP DEFAULT NOW(),
                CONSTRAINT uq_llm_cache_feature_hash_version UNIQUE (feature, input_hash, prompt_version)
            )
        """))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS idx_llm_cache_kitchen ON llm_analysis_cache(kitchen_id)"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS idx_llm_cache_hash ON llm_analysis_cache(input_hash)"
        ))
        print("+ Created llm_analysis_cache table")

    print("+ LLM infrastructure migration complete")


if __name__ == "__main__":
    print("Running migration: add_llm_infrastructure")
    asyncio.run(migrate())
    print("Migration complete!")
