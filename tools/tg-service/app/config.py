from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    model_config = {"env_file": ".env", "env_file_encoding": "utf-8", "extra": "ignore"}

    # ── App ──────────────────────────────────────────────────────────
    app_name: str = "pup-tg-service"
    app_version: str = "0.1.0"
    app_host: str = "127.0.0.1"
    app_port: int = 8001
    environment: str = "development"
    debug: bool = False

    # ── Redis / Celery ───────────────────────────────────────────────
    redis_url: str = "redis://localhost:6379/5"
    celery_broker_url: str = "redis://localhost:6379/5"
    celery_result_backend: str = "redis://localhost:6379/5"

    # ── Security ─────────────────────────────────────────────────────
    admin_token: str = "replace-with-secure-token"
    pup_secret: str = ""  # base64-encoded 32-byte master key for AES-256-GCM

    # ── Telegram ─────────────────────────────────────────────────────
    telegram_app_id: int | None = None
    telegram_app_hash: str | None = None

    # ── AI ───────────────────────────────────────────────────────────
    anthropic_api_key: str | None = None

    # ── Logging ──────────────────────────────────────────────────────
    log_level: str = "INFO"

    # ── Paths ────────────────────────────────────────────────────────
    data_dir: Path = Path("./data")
    sessions_dir: Path = Path("./data/sessions")


settings = Settings()
