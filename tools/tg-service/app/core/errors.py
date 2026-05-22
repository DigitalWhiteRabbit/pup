from __future__ import annotations


class PupTgError(Exception):
    pass


class AuthError(PupTgError):
    pass


class NotFoundError(PupTgError):
    pass


class ValidationError(PupTgError):
    pass


class TelegramError(PupTgError):
    pass


class WorkspaceError(PupTgError):
    pass
