"""FastAPI application entry-point for TG Service."""

from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.api.v1.account_profile import router as account_profile_router
from app.api.v1.accounts import router as accounts_router
from app.api.v1.ai_promoter import router as ai_promoter_router
from app.api.v1.ai_sales import router as ai_sales_router
from app.api.v1.audiences import router as audiences_router
from app.api.v1.auto_replier import router as auto_replier_router
from app.api.v1.boost import router as boost_router
from app.api.v1.channel_creator import router as channel_creator_router
from app.api.v1.channels import router as channels_router
from app.api.v1.chat_broadcasts import router as chat_broadcasts_router
from app.api.v1.cloner import router as cloner_router
from app.api.v1.commenting import router as commenting_router
from app.api.v1.converter import router as converter_router
from app.api.v1.telegram_client import router as telegram_client_router
from app.api.v1.dashboard import router as dashboard_router
from app.api.v1.dm_campaigns import router as dm_campaigns_router
from app.api.v1.invite_campaigns import router as invite_campaigns_router
from app.api.v1.join_chats import router as join_chats_router
from app.api.v1.knowledge_base import router as knowledge_base_router
from app.api.v1.style_bank import router as style_bank_router
from app.api.v1.parser import router as parser_router
from app.api.v1.phone_checker import router as phone_checker_router
from app.api.v1.arena import router as arena_router
from app.api.v1.proxies import router as proxies_router
from app.api.v1.settings import router as settings_router
from app.api.v1.smoke import router as smoke_router
from app.api.v1.system import router as system_router
from app.api.v1.stories_boost import router as stories_boost_router
from app.api.v1.templates import router as templates_router
from app.api.v1.warmup import router as warmup_router
from app.api.v1.warmup_scripts import router as warmup_scripts_router
from app.config import settings
from app.core.database import close_all
from app.core.logging import get_logger, setup_logging


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    setup_logging()
    log = get_logger("main")
    log.info("app_starting", version=settings.app_version, port=settings.app_port)
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    settings.sessions_dir.mkdir(parents=True, exist_ok=True)
    yield
    close_all()
    log.info("app_shutdown")


app = FastAPI(
    title=settings.app_name,
    version=settings.app_version,
    lifespan=lifespan,
)

# ---------- CORS (needed for iframe embedding) ----------
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------- Public endpoints ----------
@app.get("/health")
async def health() -> dict[str, str]:
    return {
        "status": "ok",
        "version": settings.app_version,
        "environment": settings.environment,
    }


# ---------- API routes ----------
app.include_router(smoke_router, prefix="/api/v1")
app.include_router(system_router, prefix="/api/v1")
app.include_router(accounts_router, prefix="/api/v1")
app.include_router(account_profile_router, prefix="/api/v1")
app.include_router(proxies_router, prefix="/api/v1")
app.include_router(arena_router, prefix="/api/v1")
app.include_router(settings_router, prefix="/api/v1")
app.include_router(dashboard_router, prefix="/api/v1")
app.include_router(warmup_router, prefix="/api/v1")
app.include_router(parser_router, prefix="/api/v1")
app.include_router(audiences_router, prefix="/api/v1")
app.include_router(channels_router, prefix="/api/v1")
app.include_router(phone_checker_router, prefix="/api/v1")
app.include_router(ai_promoter_router, prefix="/api/v1")
app.include_router(ai_sales_router, prefix="/api/v1")
app.include_router(commenting_router, prefix="/api/v1")
app.include_router(auto_replier_router, prefix="/api/v1")
app.include_router(templates_router, prefix="/api/v1")
app.include_router(dm_campaigns_router, prefix="/api/v1")
app.include_router(chat_broadcasts_router, prefix="/api/v1")
app.include_router(invite_campaigns_router, prefix="/api/v1")
app.include_router(knowledge_base_router, prefix="/api/v1")
app.include_router(boost_router, prefix="/api/v1")
app.include_router(stories_boost_router, prefix="/api/v1")
app.include_router(cloner_router, prefix="/api/v1")
app.include_router(channel_creator_router, prefix="/api/v1")
app.include_router(converter_router, prefix="/api/v1")
app.include_router(telegram_client_router, prefix="/api/v1")
app.include_router(join_chats_router, prefix="/api/v1")
app.include_router(warmup_scripts_router, prefix="/api/v1")
app.include_router(style_bank_router, prefix="/api/v1")

# ---------- Static frontend (only when public/ exists) ----------
_public = Path(__file__).resolve().parent.parent / "public"
if _public.is_dir():
    app.mount("/", StaticFiles(directory=str(_public), html=True), name="public")
