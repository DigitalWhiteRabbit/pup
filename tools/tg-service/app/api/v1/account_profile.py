"""Account PROFILE backend — make accounts look human.

Generate a coherent persona (name / username / bio / avatar) + privacy for a
Telegram account, store it on the account "card" (tg_accounts columns +
metadata JSON), and apply it to the real Telegram account on demand via
Telethon.

Storage map
-----------
- first_name / last_name / username  → ``tg_accounts`` real columns
- bio / avatar_path / privacy        → account's ``metadata`` JSON object

Telegram is only ever touched by ``POST /accounts/{id}/profile/apply`` — every
other endpoint operates purely on the local card.
"""

from __future__ import annotations

import json
import random
import re
import secrets
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import structlog
from fastapi import APIRouter, File, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from app.ai.anthropic_client import generate_message
from app.config import settings
from app.core.audit import record_audit
from app.deps import AdminAuth, WorkspaceDB, WorkspaceId
from app.telegram.client_pool import disconnect_client, get_client_for_account

router = APIRouter(prefix="/accounts", tags=["account-profile"])

log = structlog.get_logger(__name__)

# Browser User-Agent for thispersondoesnotexist.com — it 403s a default
# httpx/python UA, so we present a real desktop Chrome string.
_AVATAR_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)
_AVATAR_SOURCE_URL = "https://thispersondoesnotexist.com/"
# Fallback source: deterministic per-account avatar (seed = account_id) used when
# the synthetic-face source 403s / returns empty (a frequent failure mode).
_AVATAR_FALLBACK_URL = "https://i.pravatar.cc/512?u={seed}"

_HAIKU_MODEL = "claude-haiku-4-5-20251001"


async def _download_avatar_bytes(account_id: str) -> bytes:
    """Download an avatar image, trying the synthetic-face source first and a
    deterministic seeded fallback second. Raises HTTP 502 if all sources fail."""
    sources = [
        _AVATAR_SOURCE_URL,
        _AVATAR_FALLBACK_URL.format(seed=account_id),
    ]
    last_err = "no source"
    for url in sources:
        try:
            async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
                resp = await client.get(
                    url,
                    headers={"User-Agent": _AVATAR_USER_AGENT, "Accept": "image/jpeg,image/*"},
                )
            resp.raise_for_status()
            content = resp.content
            if content and len(content) >= 512:
                return content
            last_err = f"empty/invalid image from {url}"
        except Exception as exc:  # noqa: BLE001
            last_err = f"{url}: {exc}"
            log.warning("avatar_source_failed", account_id=account_id, error=str(exc)[:160])
    raise HTTPException(
        status_code=status.HTTP_502_BAD_GATEWAY,
        detail=f"All avatar sources failed: {last_err}",
    )

# Telegram constraints
_BIO_MAX = 70
_USERNAME_RE = re.compile(r"^[a-z0-9_]{5,32}$")

# Privacy: our values → Telethon InputPrivacyValue classes (resolved lazily).
_PRIVACY_KEYS = ("phone", "photo", "last_seen")
_PRIVACY_VALUES = ("everybody", "contacts", "nobody")
_DEFAULT_PRIVACY = {"phone": "contacts", "photo": "contacts", "last_seen": "contacts"}

# Apply: selectable profile parts (anti-ban — apply each separately over time).
#   "name"     → first_name + last_name + bio (UpdateProfileRequest)
#   "username" → UpdateUsernameRequest
#   "photo"    → UploadProfilePhotoRequest
#   "privacy"  → the 3 SetPrivacyRequest calls
_APPLY_PARTS = ("name", "username", "photo", "privacy")


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------


class PrivacySettings(BaseModel):
    phone: str | None = None
    photo: str | None = None
    last_seen: str | None = None


class ProfileResponse(BaseModel):
    first_name: str | None = None
    last_name: str | None = None
    username: str | None = None
    bio: str | None = None
    avatar_url: str | None = None
    privacy: dict[str, str] = Field(default_factory=lambda: dict(_DEFAULT_PRIVACY))


class GenerateIdentityRequest(BaseModel):
    gender: str | None = None  # "male" | "female" | None
    niche: str | None = None
    # Current form values + which name fields are actually being regenerated.
    # When a name is KEPT (gen_* False), the username must still be derived from
    # it so the handle stays consistent with the account's real name.
    first_name: str | None = None  # current value from the form
    last_name: str | None = None  # current value from the form
    gen_first: bool = True  # regenerate the first name?
    gen_last: bool = True  # regenerate the last name?


class IdentitySuggestion(BaseModel):
    first_name: str
    last_name: str
    username: str = ""
    bio: str
    bio_ru: str = ""


class ProfilePatch(BaseModel):
    first_name: str | None = None
    last_name: str | None = None
    username: str | None = None
    bio: str | None = None
    privacy: PrivacySettings | None = None


class TranslateRequest(BaseModel):
    text: str = ""


class TranslateResponse(BaseModel):
    translation: str


class AvatarResponse(BaseModel):
    avatar_url: str


class UsernameCheckRequest(BaseModel):
    username: str


class UsernameCheckResult(BaseModel):
    username: str
    available: bool


class ApplyRequest(BaseModel):
    """Select which profile parts to push to Telegram.

    Empty / omitted ``parts`` → apply ALL parts (backward compatible). Allowed
    values are ``name``, ``username``, ``photo``, ``privacy``; an unknown value
    is rejected with HTTP 400.
    """

    parts: list[str] = Field(default_factory=list)


class ApplyResult(BaseModel):
    """Per-part outcome map for the parts that were actually requested.

    Each requested part maps to ``"ok"`` or ``"error: <detail>"``; skipped
    parts are omitted entirely.
    """

    applied: dict[str, str] = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _load_account_row(db: Any, account_id: str) -> dict[str, Any]:
    """Fetch an account row as a dict, or raise 404."""
    row = db.execute("SELECT * FROM tg_accounts WHERE id = ?", [account_id]).fetchone()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Account not found")
    return dict(row)


def _parse_metadata(raw: Any) -> dict[str, Any]:
    """Parse the metadata JSON column into a dict (empty on failure)."""
    if not raw:
        return {}
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, TypeError):
        return {}


def _normalize_privacy(raw: Any) -> dict[str, str]:
    """Coerce stored privacy into a complete {phone,photo,last_seen} dict.

    Unknown / missing keys fall back to the default ("contacts").
    """
    result = dict(_DEFAULT_PRIVACY)
    if isinstance(raw, dict):
        for key in _PRIVACY_KEYS:
            val = raw.get(key)
            if isinstance(val, str) and val in _PRIVACY_VALUES:
                result[key] = val
    return result


def _avatar_dir(workspace_id: str) -> Path:
    """Per-workspace avatar directory under the configured data dir."""
    return settings.data_dir / "avatars" / f"ws-{workspace_id}"


def _avatar_path(workspace_id: str, account_id: str) -> Path:
    return _avatar_dir(workspace_id) / f"{account_id}.jpg"


def _avatar_route(account_id: str) -> str:
    return f"/api/v1/accounts/{account_id}/profile/avatar"


def _build_profile(row: dict[str, Any], meta: dict[str, Any]) -> ProfileResponse:
    """Assemble the public profile shape from an account row + its metadata."""
    avatar_path = meta.get("avatar_path")
    avatar_url = _avatar_route(row["id"]) if avatar_path else None
    return ProfileResponse(
        first_name=row.get("first_name"),
        last_name=row.get("last_name"),
        username=row.get("username"),
        bio=meta.get("bio"),
        avatar_url=avatar_url,
        privacy=_normalize_privacy(meta.get("privacy")),
    )


def _derive_country(row: dict[str, Any]) -> str:
    """Best-effort country label for persona generation.

    Tries explicit country / country_code columns, then falls back to a
    phone-prefix lookup, then to a neutral default.
    """
    country = (row.get("country") or "").strip()
    if country:
        return country
    code = (row.get("country_code") or "").strip()
    if code:
        return code
    phone = (row.get("phone") or "").strip()
    if phone:
        try:
            import phonenumbers

            pn = phonenumbers.parse(phone if phone.startswith("+") else "+" + phone)
            region = phonenumbers.region_code_for_number(pn)
            if region:
                return region.upper()
        except Exception:
            pass
    return "International"


def _slugify_username(raw: str) -> str:
    """Coerce a model-suggested username into the valid Telegram charset.

    Keeps a-z0-9_, lowercases, trims to 32, and pads to >=5 chars if needed.
    """
    cleaned = re.sub(r"[^a-z0-9_]", "", (raw or "").lower())
    cleaned = cleaned[:32]
    if len(cleaned) < 5:
        cleaned = (cleaned + "_user" + str(random.randint(100, 999)))[:32]
    return cleaned


# ---------------------------------------------------------------------------
# 1. GET current stored profile
# ---------------------------------------------------------------------------


@router.get("/{account_id}/profile")
async def get_profile(
    account_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> ProfileResponse:
    """Return the account's currently stored profile card."""
    row = _load_account_row(db, account_id)
    meta = _parse_metadata(row.get("metadata"))
    return _build_profile(row, meta)


# ---------------------------------------------------------------------------
# 2. Generate identity suggestion (AI, no save, no Telegram)
# ---------------------------------------------------------------------------


@router.post("/{account_id}/profile/generate-identity")
async def generate_identity(
    account_id: str,
    body: GenerateIdentityRequest,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> IdentitySuggestion:
    """Generate a coherent human persona suggestion via Claude (Haiku).

    Returns a suggestion only — nothing is saved and Telegram is not touched.
    """
    row = _load_account_row(db, account_id)
    country = _derive_country(row)

    gender = body.gender if body.gender in ("male", "female") else None
    gender_label = gender or "any gender"
    niche = (body.niche or "").strip() or "an ordinary everyday person"

    # Which name parts are kept vs (re)generated. A kept name must be echoed back
    # unchanged AND drive the username/bio so the handle matches the real person.
    keep_first = (not body.gen_first) and bool((body.first_name or "").strip())
    keep_last = (not body.gen_last) and bool((body.last_name or "").strip())
    kept_first = (body.first_name or "").strip()[:64]
    kept_last = (body.last_name or "").strip()[:64]

    # ── Per-field name instructions (keep exact value, or generate fresh) ──
    name_rules: list[str] = []
    if keep_first:
        name_rules.append(
            f'KEEP the first name EXACTLY as "{kept_first}" — do NOT change it; '
            f'return first_name="{kept_first}" verbatim in the JSON.'
        )
    else:
        name_rules.append(
            "Generate a VARIED, realistic first name authentic for the country and "
            "gender; vary it on every generation (no defaulting to one popular name)."
        )
    if keep_last:
        name_rules.append(
            f'KEEP the last name EXACTLY as "{kept_last}" — do NOT change it; '
            f'return last_name="{kept_last}" verbatim in the JSON.'
        )
    else:
        name_rules.append(
            "Generate a VARIED, realistic surname authentic for the country — do NOT "
            "default to the single most common surname (for Moldova/Romania, do not "
            "always use 'Popescu'); vary it on every generation."
        )

    system_prompt = (
        "You generate realistic, human Telegram personas. "
        "Reply with ONLY a single JSON object, no markdown fences, no prose. "
        "Keys: first_name, last_name, username, bio, bio_ru. "
        "Make any generated name authentic for the given country (use the local "
        "language / script natives actually use). " + " ".join(name_rules) + " "
        "CRITICAL: the username MUST be DERIVED FROM and CONSISTENT WITH the FINAL "
        "first_name + last_name (e.g. based on the first name and/or surname, "
        "optionally plus the niche or a number) — NOT a random unrelated name. "
        "username MUST be latin lowercase, 5-32 chars, only a-z 0-9 underscore, "
        "and look like a plausible real Telegram handle for THIS person. "
        f"bio MUST be at most {_BIO_MAX} characters, fit THIS person, sound natural "
        "for the niche, and be written in the local language natives of that country "
        "actually use. "
        "bio_ru MUST be a faithful Russian translation of bio (for a "
        "Russian-speaking moderator); leave the native bio itself unchanged. "
        "Do not invent phone numbers, emails, or links."
    )
    user_message = (
        f"Country: {country}\n"
        f"Gender: {gender_label}\n"
        f"Niche / vibe: {niche}\n"
        f"Variation seed: {secrets.token_hex(4)} — vary the parts you generate "
        "(and, even when a name is kept, vary the username while keeping it "
        "consistent with that kept name) from any previous generation.\n"
        "Generate the persona JSON now."
    )

    try:
        result = generate_message(
            system_prompt=system_prompt,
            user_message=user_message,
            model=_HAIKU_MODEL,
            max_tokens=400,
            temperature=1.0,
        )
    except Exception as exc:
        log.error("identity_ai_failed", account_id=account_id, error=str(exc)[:200])
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"AI identity generation failed: {exc}",
        ) from exc

    text = (result.get("text") or "").strip()
    # Tolerate stray markdown fences around the JSON.
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        log.error("identity_ai_unparsable", account_id=account_id, raw=text[:200])
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="AI returned an unparseable identity",
        )

    try:
        data = json.loads(match.group(0))
    except json.JSONDecodeError as exc:
        log.error("identity_ai_bad_json", account_id=account_id, error=str(exc))
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="AI returned invalid identity JSON",
        ) from exc

    first_name = str(data.get("first_name") or "").strip()[:64]
    last_name = str(data.get("last_name") or "").strip()[:64]
    # Enforce kept names server-side — never let the model override a kept value.
    if keep_first:
        first_name = kept_first
    if keep_last:
        last_name = kept_last
    username = _slugify_username(str(data.get("username") or ""))
    bio = str(data.get("bio") or "").strip()[:_BIO_MAX]
    # RU translation of the bio for moderators; default "" if absent/unparsable.
    try:
        bio_ru = str(data.get("bio_ru") or "").strip()
    except Exception:
        bio_ru = ""

    if not first_name:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="AI did not return a first name",
        )

    log.info(
        "identity_generated",
        account_id=account_id,
        country=country,
        gender=gender_label,
        cost_usd=result.get("cost_usd"),
    )
    return IdentitySuggestion(
        first_name=first_name,
        last_name=last_name,
        username=username,
        bio=bio,
        bio_ru=bio_ru,
    )


# ---------------------------------------------------------------------------
# 2b. Translate arbitrary text to Russian (AI, no save, no Telegram)
# ---------------------------------------------------------------------------


@router.post("/{account_id}/profile/translate")
async def translate_text(
    account_id: str,
    body: TranslateRequest,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> TranslateResponse:
    """Translate arbitrary text to Russian via Claude (Haiku).

    Used by the UI to translate a manually-edited bio on demand. Returns an
    empty translation for empty input and never touches Telegram.
    """
    # Account existence check (nice-to-have, keeps behaviour consistent).
    _load_account_row(db, account_id)

    text = (body.text or "").strip()
    if not text:
        return TranslateResponse(translation="")

    system_prompt = (
        "You are a translation engine. Translate the user's text into Russian. "
        "Reply with ONLY the Russian translation — no quotes, no notes, no "
        "explanations, no original text. Preserve tone and meaning."
    )

    try:
        result = generate_message(
            system_prompt=system_prompt,
            user_message=text,
            model=_HAIKU_MODEL,
            max_tokens=400,
            temperature=0.3,
        )
    except Exception as exc:
        log.error("translate_ai_failed", account_id=account_id, error=str(exc)[:200])
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"AI translation failed: {exc}",
        ) from exc

    translation = (result.get("text") or "").strip()
    log.info(
        "text_translated",
        account_id=account_id,
        in_len=len(text),
        out_len=len(translation),
        cost_usd=result.get("cost_usd"),
    )
    return TranslateResponse(translation=translation)


# ---------------------------------------------------------------------------
# 3. Generate avatar (download a synthetic face, store path)
# ---------------------------------------------------------------------------


@router.post("/{account_id}/profile/generate-avatar")
async def generate_avatar(
    account_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
    workspace_id: WorkspaceId,
) -> AvatarResponse:
    """Download a synthetic face JPEG and store its path on the account card."""
    row = _load_account_row(db, account_id)

    content = await _download_avatar_bytes(account_id)

    avatar_dir = _avatar_dir(workspace_id)
    avatar_dir.mkdir(parents=True, exist_ok=True)
    target = _avatar_path(workspace_id, account_id)
    try:
        target.write_bytes(content)
    except OSError as exc:
        log.error("avatar_save_failed", account_id=account_id, error=str(exc)[:200])
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to save avatar: {exc}",
        ) from exc

    # Store the path relative to data_dir so it survives across runs/machines.
    rel_path = str(target.relative_to(settings.data_dir))
    meta = _parse_metadata(row.get("metadata"))
    meta["avatar_path"] = rel_path

    db.execute(
        "UPDATE tg_accounts SET metadata = ?, updated_at = datetime('now') WHERE id = ?",
        [json.dumps(meta, ensure_ascii=False), account_id],
    )
    db.commit()

    log.info("avatar_generated", account_id=account_id, size=len(content), path=rel_path)
    return AvatarResponse(avatar_url=_avatar_route(account_id))


# ---------------------------------------------------------------------------
# 3b. Upload a custom avatar
# ---------------------------------------------------------------------------


@router.post("/{account_id}/profile/upload-avatar")
async def upload_avatar(
    account_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
    workspace_id: WorkspaceId,
    file: UploadFile = File(...),
) -> AvatarResponse:
    """Store an operator-supplied image as the account's avatar.

    Saved to the same per-account path as a generated avatar so the rest of the
    profile flow (preview, apply-to-Telegram) works unchanged. Validates that
    the upload is a non-trivial image.
    """
    row = _load_account_row(db, account_id)

    content = await file.read()
    if not content or len(content) < 512:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Uploaded file is empty or too small to be an image",
        )
    ctype = (file.content_type or "").lower()
    if ctype and not ctype.startswith("image/"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Expected an image, got content-type '{ctype}'",
        )

    avatar_dir = _avatar_dir(workspace_id)
    avatar_dir.mkdir(parents=True, exist_ok=True)
    target = _avatar_path(workspace_id, account_id)
    try:
        target.write_bytes(content)
    except OSError as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to save avatar: {exc}",
        ) from exc

    rel_path = str(target.relative_to(settings.data_dir))
    meta = _parse_metadata(row.get("metadata"))
    meta["avatar_path"] = rel_path
    db.execute(
        "UPDATE tg_accounts SET metadata = ?, updated_at = datetime('now') WHERE id = ?",
        [json.dumps(meta, ensure_ascii=False), account_id],
    )
    db.commit()

    log.info("avatar_uploaded", account_id=account_id, size=len(content))
    return AvatarResponse(avatar_url=_avatar_route(account_id))


# ---------------------------------------------------------------------------
# 3c. Check username availability via Telegram (CheckUsernameRequest)
# ---------------------------------------------------------------------------


@router.post("/{account_id}/profile/check-username")
async def check_username_availability(
    account_id: str,
    body: UsernameCheckRequest,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> UsernameCheckResult:
    """Check whether a Telegram username is available (CheckUsernameRequest).

    Requires a live Telegram session — the account must have a proxy assigned
    or NO_PROXY guard will raise HTTP 400 (same as check-telegram). Returns
    ``{username, available: true}`` if free, ``available: false`` if taken.
    """
    username = (body.username or "").strip().lstrip("@").lower()
    if not _USERNAME_RE.match(username):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="username must be 5-32 chars of a-z, 0-9, underscore",
        )
    _load_account_row(db, account_id)  # 404 guard

    from telethon.tl.functions.account import CheckUsernameRequest

    client = None
    try:
        client = await get_client_for_account(account_id, db)
        available: bool = await client(CheckUsernameRequest(username=username))
        log.info("username_check", account_id=account_id, username=username, available=available)
        return UsernameCheckResult(username=username, available=available)
    except HTTPException:
        raise
    except Exception as exc:
        log.error("username_check_failed", account_id=account_id, error=str(exc)[:200])
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Telegram check failed: {exc}",
        ) from exc
    finally:
        await disconnect_client(client)


# ---------------------------------------------------------------------------
# 4. Serve the stored avatar JPEG
# ---------------------------------------------------------------------------


@router.get("/{account_id}/profile/avatar")
async def get_avatar(
    account_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
    workspace_id: WorkspaceId,
) -> FileResponse:
    """Return the saved avatar JPEG for the account (404 if none)."""
    row = _load_account_row(db, account_id)
    meta = _parse_metadata(row.get("metadata"))
    rel_path = meta.get("avatar_path")

    candidate: Path | None = None
    if rel_path:
        candidate = (settings.data_dir / rel_path).resolve()
        # Containment guard: never serve a file outside the data dir.
        data_root = settings.data_dir.resolve()
        if data_root not in candidate.parents and candidate != data_root:
            candidate = None

    # Fall back to the deterministic location if metadata is stale/missing.
    if candidate is None or not candidate.exists():
        deterministic = _avatar_path(workspace_id, account_id)
        candidate = deterministic if deterministic.exists() else None

    if candidate is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No avatar set")

    return FileResponse(str(candidate), media_type="image/jpeg")


# ---------------------------------------------------------------------------
# 5. PATCH — save profile to the card only (no Telegram)
# ---------------------------------------------------------------------------


@router.patch("/{account_id}/profile")
async def update_profile(
    account_id: str,
    body: ProfilePatch,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> ProfileResponse:
    """Save profile fields to the local card. Telegram is not touched."""
    row = _load_account_row(db, account_id)
    meta = _parse_metadata(row.get("metadata"))

    provided = body.model_dump(exclude_unset=True)

    # ── Validate bio ────────────────────────────────────────────────
    if "bio" in provided and body.bio is not None and len(body.bio) > _BIO_MAX:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"bio must be at most {_BIO_MAX} characters",
        )

    # ── Validate username ───────────────────────────────────────────
    if "username" in provided and body.username and not _USERNAME_RE.match(body.username):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="username must be 5-32 chars of a-z, 0-9, underscore",
        )

    # ── Validate privacy ────────────────────────────────────────────
    if "privacy" in provided and body.privacy is not None:
        priv_in = body.privacy.model_dump(exclude_unset=True)
        for key, val in priv_in.items():
            if val is not None and val not in _PRIVACY_VALUES:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"privacy.{key} must be one of {', '.join(_PRIVACY_VALUES)}",
                )

    # ── Apply column updates (first_name / last_name / username) ─────
    col_updates: dict[str, Any] = {}
    if "first_name" in provided:
        col_updates["first_name"] = body.first_name
    if "last_name" in provided:
        col_updates["last_name"] = body.last_name
    if "username" in provided:
        col_updates["username"] = body.username

    # ── Apply metadata updates (bio / privacy) ──────────────────────
    if "bio" in provided:
        meta["bio"] = body.bio
    if "privacy" in provided and body.privacy is not None:
        current_privacy = _normalize_privacy(meta.get("privacy"))
        for key, val in body.privacy.model_dump(exclude_unset=True).items():
            if val is not None:
                current_privacy[key] = val
        meta["privacy"] = current_privacy

    # ── Persist ─────────────────────────────────────────────────────
    set_parts = [f"{col} = ?" for col in col_updates]
    values: list[Any] = list(col_updates.values())
    set_parts.append("metadata = ?")
    values.append(json.dumps(meta, ensure_ascii=False))
    set_parts.append("updated_at = datetime('now')")
    values.append(account_id)

    db.execute(f"UPDATE tg_accounts SET {', '.join(set_parts)} WHERE id = ?", values)
    db.commit()

    log.info("profile_saved", account_id=account_id, fields=list(provided.keys()))

    fresh = _load_account_row(db, account_id)
    return _build_profile(fresh, _parse_metadata(fresh.get("metadata")))


# ---------------------------------------------------------------------------
# 6. APPLY the stored profile to the real Telegram account (Telethon)
# ---------------------------------------------------------------------------


async def _anti_ban_sleep() -> None:
    """Random 1-3s pause between Telegram write actions."""
    import asyncio

    await asyncio.sleep(random.uniform(1.0, 3.0))


def _privacy_value_class(value: str) -> Any:
    """Map our privacy value → a Telethon InputPrivacyValue instance."""
    from telethon.tl.types import (
        InputPrivacyValueAllowAll,
        InputPrivacyValueAllowContacts,
        InputPrivacyValueDisallowAll,
    )

    if value == "everybody":
        return InputPrivacyValueAllowAll()
    if value == "nobody":
        return InputPrivacyValueDisallowAll()
    # default / "contacts"
    return InputPrivacyValueAllowContacts()


@router.post("/{account_id}/profile/apply")
async def apply_profile(
    account_id: str,
    body: ApplyRequest,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> ApplyResult:
    """Apply SELECTED parts of the stored profile to the real Telegram account.

    The UI applies one part per button (name / username / photo / privacy) at
    different times so a single account doesn't change everything at once
    (anti-ban). ``body.parts`` selects which parts run; empty / omitted applies
    ALL parts (backward compatible). Each step is tolerant and logged; a failure
    in one step does not abort the rest. NO_PROXY-guarded by
    ``get_client_for_account``.
    """
    # ── Validate & resolve requested parts ──────────────────────────
    requested = body.parts or list(_APPLY_PARTS)
    unknown = [p for p in requested if p not in _APPLY_PARTS]
    if unknown:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"unknown part(s): {', '.join(unknown)}; allowed: {', '.join(_APPLY_PARTS)}",
        )
    # Preserve canonical order, de-dupe, so "between-step" sleeps stay sane.
    parts = [p for p in _APPLY_PARTS if p in requested]

    # P5-08: hot-path audit (observability only).
    record_audit(db, "account.profile_apply", f"profile apply invoked: {', '.join(parts)}",
                 entity_type="account", entity_id=account_id, metadata={"parts": parts})

    do_name = "name" in parts
    do_username = "username" in parts
    do_photo = "photo" in parts
    do_privacy = "privacy" in parts

    from telethon.errors import UsernameInvalidError, UsernameOccupiedError
    from telethon.tl.functions.account import (
        SetPrivacyRequest,
        UpdateProfileRequest,
        UpdateUsernameRequest,
    )
    from telethon.tl.functions.photos import UploadProfilePhotoRequest
    from telethon.tl.types import (
        InputPrivacyKeyPhoneNumber,
        InputPrivacyKeyProfilePhoto,
        InputPrivacyKeyStatusTimestamp,
    )

    row = _load_account_row(db, account_id)
    meta = _parse_metadata(row.get("metadata"))

    first_name = row.get("first_name")
    last_name = row.get("last_name")
    username = row.get("username")
    bio = meta.get("bio")
    avatar_rel = meta.get("avatar_path")
    privacy = _normalize_privacy(meta.get("privacy"))

    applied: dict[str, str] = {}
    # Track which parts actually succeeded → only persist those columns/meta.
    name_ok = False
    username_ok = False

    # Insert an anti-ban pause only *between* steps that actually run.
    ran_any = False

    async def _gap() -> None:
        nonlocal ran_any
        if ran_any:
            await _anti_ban_sleep()
        ran_any = True

    client = None
    try:
        client = await get_client_for_account(account_id, db)

        # ── name + bio (UpdateProfileRequest) ───────────────────────
        if do_name:
            await _gap()
            try:
                await client(
                    UpdateProfileRequest(
                        first_name=first_name or "",
                        last_name=last_name or "",
                        about=bio or "",
                    )
                )
                applied["name"] = "ok"
                name_ok = True
                log.info("apply_name_ok", account_id=account_id)
            except Exception as exc:
                applied["name"] = f"error: {str(exc)[:120]}"
                log.warning("apply_name_failed", account_id=account_id, error=str(exc)[:200])

        # ── username (UpdateUsernameRequest) ────────────────────────
        if do_username:
            if username:
                await _gap()
                try:
                    await client(UpdateUsernameRequest(username=username))
                    applied["username"] = "ok"
                    username_ok = True
                    log.info("apply_username_ok", account_id=account_id, username=username)
                except (UsernameOccupiedError, UsernameInvalidError) as exc:
                    applied["username"] = f"error: {type(exc).__name__}"
                    log.warning(
                        "apply_username_failed",
                        account_id=account_id,
                        error=type(exc).__name__,
                    )
                except Exception as exc:
                    applied["username"] = f"error: {str(exc)[:120]}"
                    log.warning(
                        "apply_username_failed", account_id=account_id, error=str(exc)[:200]
                    )
            else:
                applied["username"] = "error: no username set"
                log.warning("apply_username_missing", account_id=account_id)

        # ── photo (UploadProfilePhotoRequest) ───────────────────────
        if do_photo:
            if avatar_rel:
                avatar_full = settings.data_dir / avatar_rel
                if avatar_full.exists():
                    await _gap()
                    try:
                        uploaded = await client.upload_file(str(avatar_full))
                        await client(UploadProfilePhotoRequest(file=uploaded))
                        applied["photo"] = "ok"
                        log.info("apply_avatar_ok", account_id=account_id)
                    except Exception as exc:
                        applied["photo"] = f"error: {str(exc)[:120]}"
                        log.warning(
                            "apply_avatar_failed", account_id=account_id, error=str(exc)[:200]
                        )
                else:
                    applied["photo"] = "error: avatar file missing"
                    log.warning("apply_avatar_missing", account_id=account_id, path=avatar_rel)
            else:
                applied["photo"] = "error: no avatar set"
                log.warning("apply_avatar_none", account_id=account_id)

        # ── privacy (3× SetPrivacyRequest) ──────────────────────────
        if do_privacy:
            await _gap()
            privacy_map = {
                "phone": InputPrivacyKeyPhoneNumber(),
                "photo": InputPrivacyKeyProfilePhoto(),
                "last_seen": InputPrivacyKeyStatusTimestamp(),
            }
            privacy_errors: list[str] = []
            for our_key, key_obj in privacy_map.items():
                try:
                    await client(
                        SetPrivacyRequest(
                            key=key_obj,
                            rules=[_privacy_value_class(privacy[our_key])],
                        )
                    )
                except Exception as exc:
                    privacy_errors.append(f"{our_key}: {str(exc)[:80]}")
                    log.warning(
                        "apply_privacy_failed",
                        account_id=account_id,
                        key=our_key,
                        error=str(exc)[:200],
                    )
            applied["privacy"] = (
                "ok" if not privacy_errors else "error: " + "; ".join(privacy_errors)
            )

    finally:
        await disconnect_client(client)

    # ── Reflect applied state on the card (only the parts that ran) ──
    set_parts: list[str] = []
    values: list[Any] = []
    if name_ok:
        set_parts += ["first_name = ?", "last_name = ?"]
        values += [first_name, last_name]
    if username_ok:
        set_parts.append("username = ?")
        values.append(username)
    if applied:
        # Stamp last-applied time + remember which parts were just pushed.
        now_iso = datetime.now(UTC).isoformat()
        meta["profile_applied_at"] = now_iso
        meta["profile_applied_parts"] = parts
        set_parts.append("metadata = ?")
        values.append(json.dumps(meta, ensure_ascii=False))
    if set_parts:
        set_parts.append("updated_at = datetime('now')")
        values.append(account_id)
        db.execute(f"UPDATE tg_accounts SET {', '.join(set_parts)} WHERE id = ?", values)
        db.commit()

    log.info(
        "profile_applied",
        account_id=account_id,
        parts=parts,
        applied=applied,
    )
    return ApplyResult(applied=applied)


# ---------------------------------------------------------------------------
# 7. BULK generate / apply across a pool (P6-06) — dispatched to the worker
# ---------------------------------------------------------------------------


class BulkGenerateRequest(BaseModel):
    account_ids: list[str] = Field(..., min_length=1, max_length=50)
    gender: str | None = None
    niche: str | None = None
    with_avatar: bool = True


class BulkApplyRequest(BaseModel):
    account_ids: list[str] = Field(..., min_length=1, max_length=50)
    parts: list[str] = Field(default_factory=list)


@router.post("/profiles/bulk-generate", status_code=status.HTTP_202_ACCEPTED)
async def bulk_generate_profiles(
    body: BulkGenerateRequest,
    _token: AdminAuth,
    db: WorkspaceDB,
    workspace_id: WorkspaceId,
) -> dict[str, Any]:
    """Generate (and locally save) profiles for a pool of accounts (P6-06).

    Runs in the worker (Claude calls are blocking). Telegram is NOT touched —
    profiles are saved as DRAFT; use bulk-apply to push them.
    """
    from app.tasks.dispatch import dispatch_task

    count = len(dict.fromkeys(body.account_ids))
    task_id = dispatch_task(
        "pup_tg.bulk_generate_profiles",
        args=[workspace_id, body.account_ids, body.gender, body.niche, body.with_avatar],
    )
    log.info("bulk_generate_dispatched", count=count, task_id=task_id)
    return {"status": "dispatched", "task_id": task_id, "count": count}


@router.post("/profiles/bulk-apply", status_code=status.HTTP_202_ACCEPTED)
async def bulk_apply_profiles(
    body: BulkApplyRequest,
    _token: AdminAuth,
    db: WorkspaceDB,
    workspace_id: WorkspaceId,
) -> dict[str, Any]:
    """Apply saved profiles to the real Telegram accounts across a pool (P6-06).

    Runs in the worker with an anti-ban gap between accounts. Each account is
    NO_PROXY-guarded (a proxy-less account is reported failed, never sent over
    the real IP). Empty ``parts`` applies all parts.
    """
    unknown = [p for p in body.parts if p not in _APPLY_PARTS]
    if unknown:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"unknown part(s): {', '.join(unknown)}; allowed: {', '.join(_APPLY_PARTS)}",
        )

    from app.tasks.dispatch import dispatch_task

    count = len(dict.fromkeys(body.account_ids))
    task_id = dispatch_task(
        "pup_tg.bulk_apply_profiles",
        args=[workspace_id, body.account_ids, body.parts],
    )
    log.info("bulk_apply_dispatched", count=count, parts=body.parts, task_id=task_id)
    return {"status": "dispatched", "task_id": task_id, "count": count}
