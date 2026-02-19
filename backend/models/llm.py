"""
LLM integration models — usage tracking and response caching.
LLM FEATURE — see LLM-MANIFEST.md for removal instructions
"""
from datetime import datetime
from typing import Optional
from sqlalchemy import String, DateTime, Integer, Text, Boolean, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column
from database import Base


class LlmUsageLog(Base):
    """Log every LLM API call for cost tracking and debugging"""
    __tablename__ = "llm_usage_log"

    id: Mapped[int] = mapped_column(primary_key=True)
    kitchen_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    feature: Mapped[str] = mapped_column(String(50), nullable=False, index=True)  # label_analysis, invoice_assist, etc.
    model: Mapped[str] = mapped_column(String(100), nullable=False)
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    latency_ms: Mapped[int] = mapped_column(Integer, default=0)
    success: Mapped[bool] = mapped_column(Boolean, default=True)
    error_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


class LlmAnalysisCache(Base):
    """Cache LLM responses to avoid redundant calls for identical inputs"""
    __tablename__ = "llm_analysis_cache"
    __table_args__ = (
        UniqueConstraint("feature", "input_hash", "prompt_version", name="uq_llm_cache_feature_hash_version"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    kitchen_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    feature: Mapped[str] = mapped_column(String(50), nullable=False)  # label_analysis, ingredient_match, etc.
    input_hash: Mapped[str] = mapped_column(String(64), nullable=False, index=True)  # SHA-256 of input
    result_json: Mapped[dict] = mapped_column(JSONB, nullable=False)
    model_used: Mapped[str] = mapped_column(String(100), nullable=False)
    prompt_version: Mapped[str] = mapped_column(String(10), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
