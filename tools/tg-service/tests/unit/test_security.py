"""Unit tests for AES-256-GCM encryption and admin token verification."""

from __future__ import annotations

from pathlib import Path

from app.core.security import (
    decrypt_bytes,
    decrypt_session_file,
    encrypt_bytes,
    encrypt_session_file,
    verify_admin_token,
)


class TestEncryptDecryptRoundtrip:
    """encrypt_bytes -> decrypt_bytes must return the original payload."""

    def test_short_payload(self) -> None:
        data = b"hello world"
        assert decrypt_bytes(encrypt_bytes(data)) == data

    def test_empty_payload(self) -> None:
        data = b""
        assert decrypt_bytes(encrypt_bytes(data)) == data

    def test_large_payload(self) -> None:
        data = b"x" * 1_000_000
        assert decrypt_bytes(encrypt_bytes(data)) == data


class TestDifferentNonces:
    """Each encryption call must produce a unique ciphertext (random nonce)."""

    def test_different_nonces(self) -> None:
        data = b"identical payload"
        ct1 = encrypt_bytes(data)
        ct2 = encrypt_bytes(data)
        assert ct1 != ct2, "Same plaintext must produce different ciphertext"

    def test_both_decrypt_correctly(self) -> None:
        data = b"identical payload"
        ct1 = encrypt_bytes(data)
        ct2 = encrypt_bytes(data)
        assert decrypt_bytes(ct1) == data
        assert decrypt_bytes(ct2) == data


class TestEncryptSessionFile:
    """encrypt_session_file / decrypt_session_file file-based roundtrip."""

    def test_encrypt_session_file(self, tmp_path: Path) -> None:
        session_data = b"telethon session binary blob"
        plain = tmp_path / "test.session"
        plain.write_bytes(session_data)

        enc_path = encrypt_session_file(plain)

        # Original file removed, encrypted file created
        assert not plain.exists()
        assert enc_path.exists()
        assert enc_path.suffix == ".enc"

        # Decrypt and verify
        recovered = decrypt_session_file(enc_path)
        assert recovered == session_data


class TestVerifyAdminToken:
    """verify_admin_token must use constant-time comparison."""

    def test_valid_token(self) -> None:
        assert verify_admin_token("test-token") is True

    def test_invalid_token(self) -> None:
        assert verify_admin_token("wrong-token") is False

    def test_empty_token(self) -> None:
        assert verify_admin_token("") is False
