"""Live-listen for the Telegram login code on a stored account.

Connects through the assigned proxy, subscribes to NewMessage events from user
777000 (the official ``Telegram`` service notification account), and prints
the first 5-digit code it sees. Also dumps the last few existing service
messages on startup in case the code already arrived.

Usage:
    PYTHONPATH=. .venv/bin/python scripts/listen_login_code.py <account_id> [proxy_override_id] [timeout_sec]
"""

from __future__ import annotations

import asyncio
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from app.core.database import connect_db
from app.core.security import decrypt_bytes

CODE_RE = re.compile(r"(\d{5,6})")
TG_SERVICE_USER_ID = 777000


async def main(account_id: str, proxy_override_id: str | None, timeout_sec: int) -> None:
    db = connect_db("default")
    row = db.execute(
        "SELECT phone, session_path, metadata FROM tg_accounts WHERE id = ?",
        [account_id],
    ).fetchone()
    if not row:
        print(f"ERROR: account {account_id} not found")
        sys.exit(1)
    acc = dict(row)
    meta = json.loads(acc["metadata"] or "{}")
    app_id = int(meta["app_id"])
    app_hash = str(meta["app_hash"])

    # Use the exact same plain .session that scripts/export_account_session.py
    # already produced, so we never re-decrypt and never race the original
    # .enc file. If the export hasn't been run, fall back to a fresh decrypt
    # into a tmp file (caller usually ran export first).
    plain_session = Path(f"data/exports/{acc['phone'].lstrip('+')}.session")
    if not plain_session.exists():
        plain_session.parent.mkdir(parents=True, exist_ok=True)
        plain_session.write_bytes(decrypt_bytes(Path(acc["session_path"]).read_bytes()))

    proxy_kwargs: dict = {}
    if proxy_override_id:
        pr = db.execute(
            "SELECT scheme, host, port, username, password FROM tg_proxies WHERE id = ?",
            [proxy_override_id],
        ).fetchone()
        if not pr:
            print(f"ERROR: proxy {proxy_override_id} not found")
            sys.exit(1)
        import socks
        proxy_kwargs["proxy"] = (
            socks.HTTP if pr["scheme"] == "http" else socks.SOCKS5,
            pr["host"], int(pr["port"]), True,
            pr["username"], pr["password"],
        )

    from telethon import TelegramClient, events

    client = TelegramClient(
        str(plain_session.with_suffix("")),
        app_id, app_hash,
        timeout=30, connection_retries=3, retry_delay=2,
        **proxy_kwargs,
    )
    await client.connect()
    if not await client.is_user_authorized():
        print("ERROR: session not authorized")
        await client.disconnect()
        sys.exit(2)

    me = await client.get_me()
    print(f"Listening on +{me.phone} (id={me.id})")
    print(f"Timeout: {timeout_sec}s. Trigger the login NOW.")
    print()

    # Snapshot of the last few service messages (in case the code arrived
    # before we hit Start Listening). Anything within the last 2 minutes
    # is considered relevant.
    cutoff = datetime.now(timezone.utc).timestamp() - 120
    try:
        recent = await client.get_messages(TG_SERVICE_USER_ID, limit=5)
        for m in recent or []:
            if not m.text:
                continue
            if m.date.timestamp() < cutoff:
                continue
            print(f"[recent {m.date.isoformat()}] {m.text}")
            for match in CODE_RE.findall(m.text):
                print(f">>> CODE: {match}")
    except Exception as exc:  # noqa: BLE001
        print(f"(could not preload recent service messages: {exc})")
    print()
    print("Waiting for new messages from 777000…")

    found = asyncio.Event()
    captured: list[str] = []

    @client.on(events.NewMessage(from_users=[TG_SERVICE_USER_ID]))
    async def _handler(event):  # type: ignore[no-untyped-def]
        text = event.raw_text or ""
        print()
        print(f"[{datetime.now().isoformat(timespec='seconds')}] {text}")
        for match in CODE_RE.findall(text):
            print(f">>> CODE: {match}")
            captured.append(match)
            found.set()

    try:
        await asyncio.wait_for(found.wait(), timeout=timeout_sec)
        print()
        print(f"Done. Code captured: {captured[0]}")
    except asyncio.TimeoutError:
        print()
        print(f"Timeout after {timeout_sec}s without seeing a code.")
    finally:
        await client.disconnect()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: listen_login_code.py <account_id> [proxy_override_id] [timeout_sec]")
        sys.exit(1)
    override = sys.argv[2] if len(sys.argv) > 2 else None
    timeout = int(sys.argv[3]) if len(sys.argv) > 3 else 180
    asyncio.run(main(sys.argv[1], override, timeout))
