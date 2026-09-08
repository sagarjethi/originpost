"""Hidden Hermes 0.21 backend extension for OriginPost Board approvals.

The dashboard mounts ``router`` below
``/api/plugins/originpost-board-approvals`` and protects it with the normal
dashboard authentication middleware. This module never changes ``os.environ``;
Hermes' ContextVar-based home override scopes every operation to one Board
profile.
"""

from __future__ import annotations

import hashlib
import json
import re
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from hermes_cli.build_info import get_code_identity
from hermes_cli.profiles import get_profile_dir, profile_exists
from hermes_constants import reset_hermes_home_override, set_hermes_home_override
from tools import write_approval as wa
from tools.memory_tool import apply_memory_pending, load_on_disk_store
from tools.skill_manager_tool import apply_skill_pending


router = APIRouter()
_PROFILE = re.compile(r"^opb_[a-f0-9]{24}$")
_PENDING_ID = re.compile(r"^[a-f0-9]{8}$")
_IDEMPOTENCY_KEY = re.compile(r"^[A-Za-z0-9_-]{16,100}$")
_MAX_SUMMARY = 300
_MAX_DETAIL = 100_000
_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


class DecisionBody(BaseModel):
    decision: Literal["approve", "reject"]
    expectedSha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    idempotencyKey: str = Field(min_length=16, max_length=100)


def _require_supported_version() -> None:
    if get_code_identity().get("version") != "0.21.0":
        raise HTTPException(status_code=503, detail="This extension requires Hermes 0.21.0 exactly.")


def _validated(profile: str, subsystem: str, pending_id: str | None = None) -> tuple[str, str, str | None]:
    if not _PROFILE.fullmatch(profile) or not profile_exists(profile):
        raise HTTPException(status_code=404, detail="Board profile not found.")
    if subsystem not in {wa.MEMORY, wa.SKILLS}:
        raise HTTPException(status_code=404, detail="Approval subsystem not found.")
    if pending_id is not None and not _PENDING_ID.fullmatch(pending_id):
        raise HTTPException(status_code=404, detail="Pending write not found.")
    return profile, subsystem, pending_id


@contextmanager
def _profile_scope(profile: str) -> Iterator[Path]:
    home = get_profile_dir(profile).expanduser().resolve(strict=True)
    token = set_hermes_home_override(home)
    try:
        yield home
    finally:
        reset_hermes_home_override(token)


def _canonical_sha256(record: dict[str, Any]) -> str:
    encoded = json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _safe_record(record: dict[str, Any], subsystem: str, include_detail: bool = False) -> dict[str, Any]:
    result: dict[str, Any] = {
        "id": str(record.get("id", "")),
        "subsystem": subsystem,
        "action": str(record.get("action", ""))[:80],
        "summary": str(record.get("summary", ""))[:_MAX_SUMMARY],
        "origin": "background_review" if record.get("origin") == "background_review" else "foreground",
        "createdAt": float(record.get("created_at", 0) or 0),
        "sha256": _canonical_sha256(record),
    }
    if include_detail:
        if subsystem == wa.MEMORY:
            payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
            detail = json.dumps({
                "action": payload.get("action"),
                "target": payload.get("target", "memory"),
                "content": payload.get("content"),
                "oldText": payload.get("old_text"),
                "operations": payload.get("operations"),
            }, ensure_ascii=False, indent=2)
        else:
            detail = wa.skill_pending_diff(record)
        result["detail"] = detail[:_MAX_DETAIL]
        result["detailTruncated"] = len(detail) > _MAX_DETAIL
    return result


def _lock(profile: str, subsystem: str) -> threading.Lock:
    key = f"{profile}:{subsystem}"
    with _locks_guard:
        return _locks.setdefault(key, threading.Lock())


def _receipt_path(home: Path, idempotency_key: str) -> Path:
    digest = hashlib.sha256(idempotency_key.encode("utf-8")).hexdigest()
    return home / "pending" / "originpost-receipts" / f"{digest}.json"


def _write_receipt(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(payload, sort_keys=True), encoding="utf-8")
    temporary.replace(path)


@router.get("/pending/{profile}/{subsystem}")
def list_pending(profile: str, subsystem: str) -> dict[str, Any]:
    _require_supported_version()
    profile, subsystem, _ = _validated(profile, subsystem)
    with _profile_scope(profile):
        records = [_safe_record(record, subsystem) for record in wa.list_pending(subsystem)[:200]]
    return {"profile": profile, "subsystem": subsystem, "pending": records}


@router.get("/pending/{profile}/{subsystem}/{pending_id}")
def pending_detail(profile: str, subsystem: str, pending_id: str) -> dict[str, Any]:
    _require_supported_version()
    profile, subsystem, pending_id = _validated(profile, subsystem, pending_id)
    with _profile_scope(profile):
        record = wa.get_pending(subsystem, pending_id)
        if not isinstance(record, dict):
            raise HTTPException(status_code=404, detail="Pending write not found.")
        return _safe_record(record, subsystem, include_detail=True)


@router.post("/pending/{profile}/{subsystem}/{pending_id}/decision")
def decide_pending(profile: str, subsystem: str, pending_id: str, body: DecisionBody) -> dict[str, Any]:
    _require_supported_version()
    profile, subsystem, pending_id = _validated(profile, subsystem, pending_id)
    if not _IDEMPOTENCY_KEY.fullmatch(body.idempotencyKey):
        raise HTTPException(status_code=422, detail="Invalid idempotency key.")
    with _lock(profile, subsystem):
        with _profile_scope(profile) as home:
            receipt_path = _receipt_path(home, body.idempotencyKey)
            if receipt_path.is_file():
                try:
                    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
                except (OSError, UnicodeDecodeError, json.JSONDecodeError):
                    raise HTTPException(status_code=409, detail="The prior decision outcome needs operator review.")
                if receipt.get("pendingId") != pending_id or receipt.get("subsystem") != subsystem or receipt.get("decision") != body.decision or receipt.get("sha256") != body.expectedSha256:
                    raise HTTPException(status_code=409, detail="The idempotency key was already used for another decision.")
                if receipt.get("state") != "complete":
                    raise HTTPException(status_code=409, detail="The prior decision outcome is uncertain and needs operator review.")
                return {"ok": True, "replayed": True, "decision": body.decision, "id": pending_id}

            record = wa.get_pending(subsystem, pending_id)
            if not isinstance(record, dict):
                raise HTTPException(status_code=404, detail="Pending write not found.")
            digest = _canonical_sha256(record)
            if digest != body.expectedSha256:
                raise HTTPException(status_code=409, detail="The pending write changed. Review it again.")

            receipt = {"pendingId": pending_id, "subsystem": subsystem, "decision": body.decision, "sha256": digest, "state": "applying"}
            _write_receipt(receipt_path, receipt)
            if body.decision == "approve":
                if subsystem == wa.MEMORY:
                    result = apply_memory_pending(record.get("payload", {}), load_on_disk_store())
                else:
                    try:
                        result = json.loads(apply_skill_pending(record.get("payload", {})))
                    except json.JSONDecodeError:
                        result = {"success": False, "error": "Hermes returned an invalid skill result."}
                if not result.get("success"):
                    raise HTTPException(status_code=409, detail="Hermes could not safely apply this write.")
            if not wa.discard_pending(subsystem, pending_id):
                raise HTTPException(status_code=409, detail="The decision was applied but its final receipt needs operator review.")

            receipt["state"] = "complete"
            _write_receipt(receipt_path, receipt)
            return {"ok": True, "replayed": False, "decision": body.decision, "id": pending_id}
