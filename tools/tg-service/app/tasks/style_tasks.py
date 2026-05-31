"""Celery tasks for the style-bank (training-on-conversations)."""

from __future__ import annotations

import structlog

from app.tasks.celery_app import celery_app

log = structlog.get_logger(__name__)


@celery_app.task(name="pup_tg.style_import_hf", bind=True, max_retries=0)
def style_import_hf(self, workspace_id: str, count: int = 2000, topic: str = "общее") -> dict:
    """Background import of informal-RU dialogue snippets from Hugging Face.

    Pulls ~count relevant Q→A pairs (random-sampled across the corpus), cleans +
    anonymizes them, and stores 2-turn style snippets the agent few-shots from.
    """
    from app.api.v1.style_bank import import_hf_dialogues
    from app.core.database import get_db

    db = get_db(workspace_id)
    result = import_hf_dialogues(db, target=count, topic=topic)
    log.info("style_import_hf_done", workspace_id=workspace_id, **result)
    return result


@celery_app.task(name="pup_tg.style_scrape_chat", bind=True, max_retries=0)
def style_scrape_chat(
    self, workspace_id: str, account_id: str, chat: str, topic: str = "крипта", limit: int = 400
) -> dict:
    """Background scrape of a real chat into on-topic style snippets."""
    import asyncio

    from app.api.v1.style_bank import scrape_chat_to_style

    result = asyncio.run(scrape_chat_to_style(workspace_id, account_id, chat, topic, limit))
    log.info("style_scrape_chat_done", workspace_id=workspace_id, **result)
    return result
