"""Integration tests for FastAPI endpoints."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture()
def client() -> TestClient:
    """Provide a synchronous test client for the FastAPI app."""
    return TestClient(app, raise_server_exceptions=False)


class TestHealthEndpoint:
    """GET /api/v1/health -- public liveness probe."""

    def test_health_returns_200(self, client: TestClient) -> None:
        resp = client.get("/api/v1/health")
        assert resp.status_code == 200

    def test_health_body(self, client: TestClient) -> None:
        data = client.get("/api/v1/health").json()
        assert data == {"status": "ok"}


class TestSmokeDbCheck:
    """GET /api/v1/smoke/db -- admin-only DB connectivity check."""

    def test_requires_auth(self, client: TestClient) -> None:
        """Request without x-admin-token must return 401."""
        resp = client.get("/api/v1/smoke/db")
        assert resp.status_code == 401

    def test_rejects_bad_token(self, client: TestClient) -> None:
        """Request with wrong token must return 401."""
        resp = client.get(
            "/api/v1/smoke/db",
            headers={"x-admin-token": "wrong-token"},
        )
        assert resp.status_code == 401

    def test_with_valid_admin_token(self, client: TestClient) -> None:
        """Request with the correct admin token must return 200."""
        resp = client.get(
            "/api/v1/smoke/db",
            headers={"x-admin-token": "test-token"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert "settings_rows" in data
