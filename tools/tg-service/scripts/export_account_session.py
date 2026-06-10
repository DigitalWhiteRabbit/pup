"""One-off helper: decrypt a stored AES-256-GCM session, write the plain
Telethon .session file to disk, and verify the account is still authorised
through its assigned proxy.

Run from the project root:
    PYTHONPATH=. .venv/bin/python scripts/export_account_session.py <account_id>

The output file goes to data/exports/<phone>.session and is printed at the end.
This file is a plain Telethon SQLite session — handle like a password.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

from app.core.database import connect_db
from app.core.security import decrypt_bytes


async def main(account_id: str, proxy_override_id: str | None = None) -> None:
    db = connect_db("default")
    row = db.execute(
        "SELECT id, phone, username, first_name, last_name, status, session_path, metadata "
        "FROM tg_accounts WHERE id = ?",
        [account_id],
    ).fetchone()
    if not row:
        print(f"ERROR: account {account_id} not found")
        sys.exit(1)
    acc = dict(row)
    meta = json.loads(acc["metadata"] or "{}")

    app_id = int(meta["app_id"])
    app_hash = str(meta["app_hash"])
    twofa = meta.get("twoFA") or meta.get("twofa_password")
    proxy_tuple = meta.get("proxy")  # [scheme_int, host, port, rdns, user, pass]

    out_dir = Path("data/exports")
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{acc['phone'].lstrip('+')}.session"
    out_path.write_bytes(decrypt_bytes(Path(acc["session_path"]).read_bytes()))
    print(f"Decrypted session → {out_path.resolve()}")
    print()

    print("─── Account ────────────────────────────────────────────")
    print(f"  id        : {acc['id']}")
    print(f"  phone     : {acc['phone']}")
    print(f"  name      : {acc['first_name']} {acc['last_name']}")
    print(f"  username  : {acc['username'] or '(none)'}")
    print(f"  status    : {acc['status']}")
    print(f"  app_id    : {app_id}")
    print(f"  app_hash  : {app_hash}")
    print(f"  2FA pwd   : {twofa or '(none)'}")
    if proxy_tuple:
        scheme_map = {2: "http", 3: "socks5"}
        scheme = scheme_map.get(proxy_tuple[0], f"int={proxy_tuple[0]}")
        print(f"  proxy     : {scheme}://{proxy_tuple[4]}:{proxy_tuple[5]}@{proxy_tuple[1]}:{proxy_tuple[2]}  rdns={proxy_tuple[3]}")
    print()

    # Verify the session is still authorised via the assigned proxy.
    from telethon import TelegramClient

    proxy_kwargs: dict = {}
    if proxy_override_id:
        pr = db.execute(
            "SELECT scheme, host, port, username, password FROM tg_proxies WHERE id = ?",
            [proxy_override_id],
        ).fetchone()
        if not pr:
            print(f"ERROR: proxy {proxy_override_id} not found")
            sys.exit(1)
        import socks  # PySocks
        proxy_kwargs["proxy"] = (
            socks.HTTP if pr["scheme"] == "http" else socks.SOCKS5,
            pr["host"], int(pr["port"]), True,
            pr["username"], pr["password"],
        )
        print(f"  override  : using pool proxy {pr['scheme']}://{pr['host']}:{pr['port']}")
    elif proxy_tuple:
        import socks  # PySocks
        scheme_int = proxy_tuple[0]
        proxy_kwargs["proxy"] = (
            socks.SOCKS5 if scheme_int == 3 else socks.HTTP,
            proxy_tuple[1],
            int(proxy_tuple[2]),
            bool(proxy_tuple[3]),
            str(proxy_tuple[4]),
            str(proxy_tuple[5]),
        )

    client = TelegramClient(
        str(out_path.with_suffix("")),
        app_id, app_hash,
        timeout=30, connection_retries=3, retry_delay=2,
        **proxy_kwargs,
    )
    await client.connect()
    try:
        if not await client.is_user_authorized():
            print("WARNING: session loaded but not authorised. Maybe 2FA is required.")
            sys.exit(2)
        me = await client.get_me()
        print("─── get_me() through assigned proxy ────────────────────")
        print(f"  id        : {me.id}")
        print(f"  phone     : +{me.phone}")
        print(f"  username  : @{me.username}" if me.username else "  username  : (none)")
        print(f"  first/last: {me.first_name!r} / {me.last_name!r}")
        print(f"  premium   : {bool(getattr(me, 'premium', False))}")

        print()
        print("─── Active sessions (Telegram → Settings → Devices) ───")
        from telethon.tl.functions.account import GetAuthorizationsRequest
        auths = await client(GetAuthorizationsRequest())
        for a in auths.authorizations:
            mark = "★ CURRENT" if a.current else ""
            print(f"  - {a.device_model} · {a.platform} · {a.app_name} v{a.app_version} · {a.country} {mark}")
        print()
        print("SUCCESS: session is alive. You can use the .session file above.")
    finally:
        await client.disconnect()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: export_account_session.py <account_id> [proxy_override_id]")
        sys.exit(1)
    override = sys.argv[2] if len(sys.argv) > 2 else None
    asyncio.run(main(sys.argv[1], override))
