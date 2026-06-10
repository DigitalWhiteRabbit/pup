"""Bulk profile generation + application across an account pool (P6-06).

Reuses the single-account profile logic verbatim (``generate_identity`` /
``generate_avatar`` / ``apply_profile`` in ``app.api.v1.account_profile``) — no
duplicated generation/apply code. Runs in the Celery worker because the Claude
identity call is blocking and applying to Telegram is paced (anti-ban): doing it
in-request would block the API event loop.

- ``pup_tg.bulk_generate_profiles`` — generate identity (+ optional avatar) for
  each account and SAVE it locally (DRAFT; Telegram is not touched). Avatar
  reuses the P3-02 fallback source.
- ``pup_tg.bulk_apply_profiles`` — apply each account's saved profile to the
  real Telegram account, with a randomized gap between accounts. NO_PROXY-guarded
  per account (a proxy-less account is reported as failed, never sent over the
  real IP).
"""

from __future__ import annotations

import asyncio
import json
import random

import structlog

from app.core.audit import record_audit
from app.core.database import get_db
from app.tasks.celery_app import celery_app

log = structlog.get_logger(__name__)

# Bounds so a runaway/huge request can't hammer Claude or Telegram.
_MAX_POOL = 50
# Gap (seconds) between accounts when APPLYING to Telegram (anti-ban).
_APPLY_GAP_MIN = 5.0
_APPLY_GAP_MAX = 15.0


@celery_app.task(name="pup_tg.bulk_generate_profiles", bind=True, max_retries=0)
def bulk_generate_profiles(
    self,
    workspace_id: str,
    account_ids: list[str],
    gender: str | None = None,
    niche: str | None = None,
    with_avatar: bool = True,
) -> dict:
    return asyncio.run(
        _bulk_generate_async(workspace_id, account_ids, gender, niche, with_avatar)
    )


async def _bulk_generate_async(
    workspace_id: str,
    account_ids: list[str],
    gender: str | None,
    niche: str | None,
    with_avatar: bool,
) -> dict:
    from app.api.v1.account_profile import (
        GenerateIdentityRequest,
        _load_account_row,
        _parse_metadata,
        generate_avatar,
        generate_identity,
    )

    db = get_db(workspace_id)
    ids = list(dict.fromkeys(account_ids))[:_MAX_POOL]
    results: list[dict] = []

    for aid in ids:
        try:
            sugg = await generate_identity(
                aid,
                GenerateIdentityRequest(gender=gender, niche=niche),
                None,  # _token: auth dep, unused when called directly
                db,
            )
            # Persist exactly like PATCH /profile (cols + bio/bio_ru in metadata).
            row = _load_account_row(db, aid)
            meta = _parse_metadata(row.get("metadata"))
            meta["bio"] = sugg.bio
            if sugg.bio_ru:
                meta["bio_ru"] = sugg.bio_ru
            db.execute(
                "UPDATE tg_accounts SET first_name=?, last_name=?, username=?, "
                "metadata=?, updated_at=datetime('now') WHERE id=?",
                [sugg.first_name, sugg.last_name, sugg.username,
                 json.dumps(meta, ensure_ascii=False), aid],
            )
            db.commit()

            avatar_ok = False
            if with_avatar:
                try:
                    await generate_avatar(aid, None, db, workspace_id)
                    avatar_ok = True
                except Exception as exc:  # noqa: BLE001 — avatar is best-effort
                    log.warning("bulk_avatar_failed", account_id=aid, error=str(exc)[:200])

            results.append({
                "account_id": aid, "ok": True,
                "first_name": sugg.first_name, "username": sugg.username, "avatar": avatar_ok,
            })
            log.info("bulk_profile_generated", account_id=aid, username=sugg.username)
        except Exception as exc:  # noqa: BLE001 — one bad account never aborts the batch
            detail = getattr(exc, "detail", None) or str(exc)
            results.append({"account_id": aid, "ok": False, "error": str(detail)[:200]})
            log.warning("bulk_profile_generate_failed", account_id=aid, error=str(detail)[:200])

    ok = sum(1 for r in results if r["ok"])
    record_audit(
        db, "account.bulk_generate", f"bulk profile generate: {ok}/{len(results)} ok",
        entity_type="account", metadata={"total": len(results), "generated": ok, "with_avatar": with_avatar},
    )
    log.info("bulk_generate_done", workspace_id=workspace_id, total=len(results), generated=ok)
    return {"total": len(results), "generated": ok, "results": results}


@celery_app.task(name="pup_tg.bulk_apply_profiles", bind=True, max_retries=0)
def bulk_apply_profiles(
    self,
    workspace_id: str,
    account_ids: list[str],
    parts: list[str] | None = None,
) -> dict:
    return asyncio.run(_bulk_apply_async(workspace_id, account_ids, parts or []))


async def _bulk_apply_async(
    workspace_id: str, account_ids: list[str], parts: list[str]
) -> dict:
    from app.api.v1.account_profile import ApplyRequest, apply_profile

    db = get_db(workspace_id)
    ids = list(dict.fromkeys(account_ids))[:_MAX_POOL]
    results: list[dict] = []

    for idx, aid in enumerate(ids):
        if idx > 0:
            # Anti-ban: stagger Telegram writes across accounts.
            await asyncio.sleep(random.uniform(_APPLY_GAP_MIN, _APPLY_GAP_MAX))
        try:
            res = await apply_profile(aid, ApplyRequest(parts=parts), None, db)
            applied = getattr(res, "applied", {}) or {}
            results.append({"account_id": aid, "ok": True, "applied": applied})
            log.info("bulk_profile_applied", account_id=aid, applied=applied)
        except Exception as exc:  # noqa: BLE001 — NO_PROXY / connect errors per account
            detail = getattr(exc, "detail", None) or str(exc)
            results.append({"account_id": aid, "ok": False, "error": str(detail)[:200]})
            log.warning("bulk_profile_apply_failed", account_id=aid, error=str(detail)[:200])

    ok = sum(1 for r in results if r["ok"])
    record_audit(
        db, "account.bulk_apply", f"bulk profile apply: {ok}/{len(results)} ok",
        entity_type="account", metadata={"total": len(results), "applied": ok, "parts": parts},
    )
    log.info("bulk_apply_done", workspace_id=workspace_id, total=len(results), applied=ok)
    return {"total": len(results), "applied": ok, "results": results}
