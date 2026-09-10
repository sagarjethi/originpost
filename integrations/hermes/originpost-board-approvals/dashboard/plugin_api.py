"""Hidden Hermes 0.21.1 backend extension for OriginPost Board approvals.

The dashboard mounts ``router`` below
``/api/plugins/originpost-board-approvals`` and protects it with the normal
dashboard authentication middleware. This module never changes ``os.environ``;
Hermes' ContextVar-based home override scopes every operation to one Board
profile.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import signal
import stat
import subprocess
import sys
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator, Literal

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field
import yaml

from hermes_cli.build_info import get_code_identity
from hermes_cli.profiles import _get_profiles_root, get_profile_dir, profile_exists
from tools import write_approval as wa
from tools.memory_tool import apply_memory_pending, load_on_disk_store
from tools.skill_manager_tool import apply_skill_pending


_PROFILE = re.compile(r"^opb_[a-f0-9]{24}$")
_PENDING_ID = re.compile(r"^[a-f0-9]{8}$")
_IDEMPOTENCY_KEY = re.compile(r"^[A-Za-z0-9_-]{16,100}$")
_OWNER = re.compile(r"^opb_owner_[a-f0-9]{40}$")
_MEMORY_SCOPE = re.compile(r"^opb_mem_[a-f0-9]{40}$")
_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_NONCE = re.compile(r"^[a-f0-9]{32}$")
_PROFILE_DESCRIPTION = re.compile(
    r"^OriginPost Board runtime; owner=(opb_owner_[a-f0-9]{40}); memory=(opb_mem_[a-f0-9]{40}); "
    r"policy=([a-f0-9]{64}); provider=([a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}); "
    r"model=([a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}); skills=([a-f0-9]{64}); "
    r"skill_manifest=([a-f0-9]{64}|pending)\.$"
)
_MAX_SUMMARY = 300
_MAX_DETAIL = 100_000
_MAX_SCOPE_ENTRIES = 10_000
_MAX_RUN_PROMPT = 12_000
_MAX_RUN_INSTRUCTIONS = 2_000
_SUPPORTED_SHA = "2237be355906fbe6065ce1815711eee52b2d646e"
_AUTH_WINDOW_SECONDS = 90
_WORKER_PROBE_TIMEOUT_SECONDS = 60
_WORKER_RUN_TIMEOUT_SECONDS = 190
_MAX_TRUST_FILE_BYTES = 128 * 1024
_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


class DecisionBody(BaseModel):
    decision: Literal["approve", "reject"]
    expectedSha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    idempotencyKey: str = Field(min_length=16, max_length=100)


class RunBody(BaseModel):
    prompt: str = Field(min_length=1, max_length=_MAX_RUN_PROMPT)
    instructions: str = Field(min_length=1, max_length=_MAX_RUN_INSTRUCTIONS)
    sessionKey: str = Field(pattern=r"^opb_mem_[a-f0-9]{40}$")
    skillManifestSha256: str = Field(pattern=r"^[a-f0-9]{64}$")


class SealBody(BaseModel):
    owner: str = Field(pattern=r"^opb_owner_[a-f0-9]{40}$")
    memoryScope: str = Field(pattern=r"^opb_mem_[a-f0-9]{40}$")
    policySha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    provider: str = Field(pattern=r"^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$")
    model: str = Field(pattern=r"^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$")
    enabledSkillsSha256: str = Field(pattern=r"^[a-f0-9]{64}$")


@dataclass(frozen=True)
class SignedHeaders:
    timestamp: str
    nonce: str
    signature: str
    owner: str
    memory_scope: str
    policy_sha256: str


def _signed_headers(
    x_originpost_timestamp: str = Header(alias="x-originpost-timestamp"),
    x_originpost_nonce: str = Header(alias="x-originpost-nonce"),
    x_originpost_signature: str = Header(alias="x-originpost-signature"),
    x_originpost_board_owner: str = Header(alias="x-originpost-board-owner"),
    x_originpost_memory_scope: str = Header(alias="x-originpost-memory-scope"),
    x_originpost_policy_sha256: str = Header(alias="x-originpost-policy-sha256"),
) -> SignedHeaders:
    return SignedHeaders(
        timestamp=x_originpost_timestamp,
        nonce=x_originpost_nonce,
        signature=x_originpost_signature,
        owner=x_originpost_board_owner,
        memory_scope=x_originpost_memory_scope,
        policy_sha256=x_originpost_policy_sha256,
    )


def _authenticate(x_hermes_session_token: str | None = Header(default=None, alias="x-hermes-session-token")) -> None:
    expected = os.environ.get("ORIGINPOST_BOARD_PLUGIN_TOKEN", "")
    if len(expected.encode("utf-8")) < 32:
        raise HTTPException(status_code=503, detail="OriginPost Board plugin authentication is not configured.")
    if x_hermes_session_token is None or not secrets.compare_digest(x_hermes_session_token, expected):
        raise HTTPException(status_code=401, detail="Invalid OriginPost Board plugin token.")


router = APIRouter(dependencies=[Depends(_authenticate)])


def _require_supported_version() -> None:
    if not sys.dont_write_bytecode:
        raise HTTPException(status_code=503, detail="Start Hermes with PYTHONDONTWRITEBYTECODE=1 before loading the OriginPost Board extension.")
    identity = get_code_identity(refresh=True)
    if identity.get("version") != "0.21.1" or identity.get("sha") != _SUPPORTED_SHA or identity.get("source") != "git":
        raise HTTPException(status_code=503, detail="This extension requires the approved Hermes 0.21.1 build exactly.")
    root = Path(__import__("hermes_cli").__file__).resolve().parent.parent
    git = shutil.which("git")
    if not git:
        raise HTTPException(status_code=503, detail="The approved Hermes source cannot be verified.")
    try:
        checked = subprocess.run(
            [git, "-C", str(root), "status", "--porcelain=v1", "--untracked-files=all"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise HTTPException(status_code=503, detail="The approved Hermes source cannot be verified.")
    if checked.returncode != 0 or checked.stdout.strip():
        raise HTTPException(status_code=503, detail="The Hermes source checkout is not immutable and clean.")
    ignored = subprocess.run(
        [git, "-C", str(root), "ls-files", "-z", "--others", "--ignored", "--exclude-standard"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        timeout=10,
        check=False,
    )
    ignored_paths = [Path(value.decode("utf-8", errors="surrogateescape")) for value in ignored.stdout.split(b"\0") if value]
    if ignored.returncode != 0 or any("__pycache__" in path.parts or path.suffix.lower() in {".py", ".pyc", ".pyo", ".so", ".pyd"} for path in ignored_paths):
        raise HTTPException(status_code=503, detail="The Hermes source checkout contains ignored executable code or bytecode.")


def _validated(profile: str, subsystem: str, pending_id: str | None = None) -> tuple[str, str, str | None]:
    _validated_profile(profile)
    if subsystem not in {wa.MEMORY, wa.SKILLS}:
        raise HTTPException(status_code=404, detail="Approval subsystem not found.")
    if pending_id is not None and not _PENDING_ID.fullmatch(pending_id):
        raise HTTPException(status_code=404, detail="Pending write not found.")
    return profile, subsystem, pending_id


def _validated_profile(profile: str) -> str:
    if not _PROFILE.fullmatch(profile):
        raise HTTPException(status_code=404, detail="Board profile not found.")
    lexical = get_profile_dir(profile).expanduser()
    try:
        root = _get_profiles_root().expanduser().resolve(strict=True)
        lexical_stat = lexical.lstat()
        home = lexical.resolve(strict=True)
    except (FileNotFoundError, OSError, RuntimeError):
        raise HTTPException(status_code=404, detail="Board profile not found.")
    if stat.S_ISLNK(lexical_stat.st_mode) or not stat.S_ISDIR(lexical_stat.st_mode) or home.parent != root or home.name != profile or not profile_exists(profile):
        raise HTTPException(status_code=409, detail="Board profile scope could not be verified.")
    return profile


@contextmanager
def _profile_scope(profile: str) -> Iterator[Path]:
    _validated_profile(profile)
    home = get_profile_dir(profile).expanduser().resolve(strict=True)
    from gateway.run import _profile_runtime_scope

    _require_isolation(profile)
    with _profile_runtime_scope(home):
        yield home


def _canonical_sha256(record: dict[str, Any]) -> str:
    encoded = json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _profile_dir_fd(home: Path) -> int:
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(home, flags)
    except OSError:
        raise HTTPException(status_code=409, detail="Board profile scope could not be verified.")
    if not stat.S_ISDIR(os.fstat(descriptor).st_mode):
        os.close(descriptor)
        raise HTTPException(status_code=409, detail="Board profile scope could not be verified.")
    return descriptor


def _read_trust_file(home: Path, name: str) -> str:
    home_fd = _profile_dir_fd(home)
    try:
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(name, flags, dir_fd=home_fd)
        try:
            file_stat = os.fstat(descriptor)
            if not stat.S_ISREG(file_stat.st_mode) or file_stat.st_nlink != 1 or file_stat.st_size > _MAX_TRUST_FILE_BYTES:
                raise HTTPException(status_code=409, detail="The Board profile trust files are invalid.")
            chunks: list[bytes] = []
            size = 0
            while chunk := os.read(descriptor, 16 * 1024):
                size += len(chunk)
                if size > _MAX_TRUST_FILE_BYTES:
                    raise HTTPException(status_code=409, detail="The Board profile trust files are invalid.")
                chunks.append(chunk)
            return b"".join(chunks).decode("utf-8-sig")
        finally:
            os.close(descriptor)
    except (FileNotFoundError, OSError, UnicodeDecodeError):
        raise HTTPException(status_code=409, detail="The Board profile trust files are unavailable.")
    finally:
        os.close(home_fd)


def _read_profile_yaml(home: Path) -> dict[str, Any]:
    try:
        value = yaml.safe_load(_read_trust_file(home, "profile.yaml")) or {}
    except yaml.YAMLError:
        raise HTTPException(status_code=409, detail="The Board profile ownership contract is invalid.")
    if not isinstance(value, dict):
        raise HTTPException(status_code=409, detail="The Board profile ownership contract is invalid.")
    return value


def _write_profile_description(home: Path, description: str) -> None:
    value = _read_profile_yaml(home)
    value["description"] = description.strip()
    value["description_auto"] = False
    encoded = yaml.safe_dump(value, sort_keys=False, allow_unicode=True).encode("utf-8")
    if len(encoded) > _MAX_TRUST_FILE_BYTES:
        raise HTTPException(status_code=409, detail="The Board profile ownership contract is too large.")
    home_fd = _profile_dir_fd(home)
    temporary = f".originpost-profile-{secrets.token_hex(8)}.tmp"
    descriptor: int | None = None
    try:
        descriptor = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0), 0o600, dir_fd=home_fd)
        offset = 0
        while offset < len(encoded):
            offset += os.write(descriptor, encoded[offset:])
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = None
        os.replace(temporary, "profile.yaml", src_dir_fd=home_fd, dst_dir_fd=home_fd)
    except OSError:
        raise HTTPException(status_code=409, detail="The Board profile ownership contract could not be sealed.")
    finally:
        if descriptor is not None:
            os.close(descriptor)
        try:
            os.unlink(temporary, dir_fd=home_fd)
        except FileNotFoundError:
            pass
        except OSError:
            pass
        os.close(home_fd)


def _profile_contract(home: Path, *, allow_pending: bool = False) -> dict[str, str]:
    description = _read_profile_yaml(home).get("description", "")
    match = _PROFILE_DESCRIPTION.fullmatch(str(description))
    if not match or (not allow_pending and match.group(7) == "pending"):
        raise HTTPException(status_code=409, detail="The Board profile ownership contract is not sealed.")
    return {
        "owner": match.group(1),
        "memoryScope": match.group(2),
        "policySha256": match.group(3),
        "provider": match.group(4),
        "model": match.group(5),
        "enabledSkillsSha256": match.group(6),
        "skillManifestSha256": match.group(7),
    }


def _contract_description(contract: dict[str, str], skill_manifest_sha256: str) -> str:
    return (
        f"OriginPost Board runtime; owner={contract['owner']}; memory={contract['memoryScope']}; "
        f"policy={contract['policySha256']}; provider={contract['provider']}; model={contract['model']}; "
        f"skills={contract['enabledSkillsSha256']}; skill_manifest={skill_manifest_sha256}."
    )


def _profile_api_key(home: Path) -> str:
    from agent.secret_scope import _strip_inline_comment
    from hermes_cli.config import _parse_env_value

    key = ""
    for raw in _read_trust_file(home, ".env").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].lstrip()
        name, separator, value = line.partition("=")
        if separator and name.strip() == "API_SERVER_KEY":
            key = _parse_env_value(_strip_inline_comment(value))
    if len(key.encode("utf-8")) < 32:
        raise HTTPException(status_code=409, detail="The Board profile key is unavailable.")
    return key


def _ensure_scoped_directory(home: Path, name: str) -> Path:
    home_fd = _profile_dir_fd(home)
    directory_fd: int | None = None
    try:
        try:
            os.mkdir(name, 0o700, dir_fd=home_fd)
        except FileExistsError:
            pass
        flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
        directory_fd = os.open(name, flags, dir_fd=home_fd)
        if not stat.S_ISDIR(os.fstat(directory_fd).st_mode):
            raise OSError("not a directory")
    except OSError:
        raise HTTPException(status_code=409, detail="Board profile scope could not be verified.")
    finally:
        if directory_fd is not None:
            os.close(directory_fd)
        os.close(home_fd)
    return home / name


def _ensure_empty_scoped_directory(home: Path, name: str) -> Path:
    path = _ensure_scoped_directory(home, name)
    home_fd = _profile_dir_fd(home)
    directory_fd: int | None = None
    try:
        flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
        directory_fd = os.open(name, flags, dir_fd=home_fd)
        if os.listdir(directory_fd):
            raise HTTPException(status_code=409, detail="The Board child-process credential scope is not empty.")
    except HTTPException:
        raise
    except OSError:
        raise HTTPException(status_code=409, detail="Board child-process credential scope could not be verified.")
    finally:
        if directory_fd is not None:
            os.close(directory_fd)
        os.close(home_fd)
    return path


def _consume_nonce(home: Path, timestamp: int, nonce: str) -> None:
    home_fd = _profile_dir_fd(home)
    state_fd: int | None = None
    nonce_fd: int | None = None
    now = int(time.time())
    try:
        directory_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
        try:
            os.mkdir("state", 0o700, dir_fd=home_fd)
        except FileExistsError:
            pass
        state_fd = os.open("state", directory_flags, dir_fd=home_fd)
        try:
            os.mkdir("originpost-auth-nonces", 0o700, dir_fd=state_fd)
        except FileExistsError:
            pass
        nonce_fd = os.open("originpost-auth-nonces", directory_flags, dir_fd=state_fd)
        try:
            for index, entry in enumerate(os.scandir(nonce_fd)):
                if index >= 2_000:
                    break
                try:
                    stamp = int(entry.name.split("-", 1)[0])
                    if stamp < now - (_AUTH_WINDOW_SECONDS * 2):
                        os.unlink(entry.name, dir_fd=nonce_fd)
                except (OSError, ValueError):
                    continue
            descriptor = os.open(f"{timestamp}-{nonce}", os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0), 0o600, dir_fd=nonce_fd)
            os.close(descriptor)
        except FileExistsError:
            raise HTTPException(status_code=409, detail="The signed Board request was already used.")
    except HTTPException:
        raise
    except OSError:
        raise HTTPException(status_code=503, detail="The signed Board request could not be recorded.")
    finally:
        if nonce_fd is not None:
            os.close(nonce_fd)
        if state_fd is not None:
            os.close(state_fd)
        os.close(home_fd)


def _authorize_board(
    profile: str,
    method: str,
    route: str,
    body: Any,
    signed: SignedHeaders,
    *,
    reseal: SealBody | None = None,
    allow_pending: bool = False,
) -> tuple[Path, dict[str, str]]:
    profile = _validated_profile(profile)
    if not _NONCE.fullmatch(signed.nonce) or not _SHA256.fullmatch(signed.signature):
        raise HTTPException(status_code=401, detail="Invalid signed Board request.")
    try:
        timestamp = int(signed.timestamp)
    except ValueError:
        raise HTTPException(status_code=401, detail="Invalid signed Board request.")
    if abs(int(time.time()) - timestamp) > _AUTH_WINDOW_SECONDS:
        raise HTTPException(status_code=401, detail="The signed Board request expired.")
    home = get_profile_dir(profile).expanduser().resolve(strict=True)
    _read_trust_file(home, "config.yaml")
    contract = _profile_contract(home, allow_pending=reseal is not None or allow_pending)
    if reseal is not None and (
        contract["owner"] != reseal.owner
        or contract["memoryScope"] != reseal.memoryScope
        or contract["policySha256"] != reseal.policySha256
        or contract["provider"] != reseal.provider
        or contract["model"] != reseal.model
        or contract["enabledSkillsSha256"] != reseal.enabledSkillsSha256
    ):
        raise HTTPException(status_code=401, detail="Invalid signed Board request.")
    expected = {
        "owner": reseal.owner if reseal else contract["owner"],
        "memoryScope": reseal.memoryScope if reseal else contract["memoryScope"],
        "policySha256": reseal.policySha256 if reseal else contract["policySha256"],
    }
    if contract["owner"] != expected["owner"] or signed.owner != expected["owner"] or signed.memory_scope != expected["memoryScope"] or signed.policy_sha256 != expected["policySha256"]:
        raise HTTPException(status_code=401, detail="Invalid signed Board request.")
    body_sha = hashlib.sha256(_canonical_json(body).encode("utf-8")).hexdigest()
    canonical = "\n".join((
        method.upper(),
        route,
        body_sha,
        signed.timestamp,
        signed.nonce,
        signed.owner,
        signed.memory_scope,
        signed.policy_sha256,
    ))
    expected_signature = hmac.new(_profile_api_key(home).encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256).hexdigest()
    if not secrets.compare_digest(signed.signature, expected_signature):
        raise HTTPException(status_code=401, detail="Invalid signed Board request.")
    _require_isolation(profile)
    _consume_nonce(home, timestamp, signed.nonce)
    return home, contract


def _child_environment(home: Path) -> dict[str, str]:
    allowed = ("PATH", "USER", "LANG", "LC_ALL", "TZ", "TMPDIR", "VIRTUAL_ENV", "SSL_CERT_FILE")
    result = {name: os.environ[name] for name in allowed if os.environ.get(name)}
    # Hermes' Codex provider can otherwise recover credentials from the process
    # user's ~/.codex/auth.json. A Board worker must see only its own home/auth.
    process_home = _ensure_empty_scoped_directory(home, ".originpost-empty-home")
    result["HOME"] = str(process_home)
    result["HERMES_HOME"] = str(home)
    result["CODEX_HOME"] = str(_ensure_empty_scoped_directory(home, ".originpost-empty-codex-home"))
    result["PYTHONDONTWRITEBYTECODE"] = "1"
    result["PYTHONUNBUFFERED"] = "1"
    return result


def _terminate_worker(process: subprocess.Popen[bytes]) -> None:
    try:
        if os.name == "posix":
            os.killpg(process.pid, signal.SIGKILL)
        else:
            process.kill()
    except (OSError, ProcessLookupError):
        pass


def _run_worker(profile: str, home: Path, operation: str, contract: dict[str, str], extras: dict[str, Any] | None = None) -> dict[str, Any]:
    worker_path = Path(__file__).with_name("runtime_worker.py").resolve(strict=True)
    hermes_root = Path(__import__("hermes_cli").__file__).resolve().parent.parent
    launcher = "import runpy,sys;sys.path.insert(0,sys.argv[1]);runpy.run_path(sys.argv[2],run_name='__main__')"
    payload = {
        "operation": operation,
        "profile": profile,
        "home": str(home),
        "provider": contract["provider"],
        "model": contract["model"],
        "enabledSkillsSha256": contract["enabledSkillsSha256"],
        "sealedSkillManifestSha256": contract.get("skillManifestSha256", ""),
        **(extras or {}),
    }
    process = subprocess.Popen(
        [sys.executable, "-c", launcher, str(hermes_root), str(worker_path)],
        cwd=str(hermes_root),
        env=_child_environment(home),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        start_new_session=(os.name == "posix"),
    )
    timeout = _WORKER_RUN_TIMEOUT_SECONDS if operation == "run" else _WORKER_PROBE_TIMEOUT_SECONDS
    try:
        stdout, _ = process.communicate(_canonical_json(payload).encode("utf-8"), timeout=timeout)
    except subprocess.TimeoutExpired:
        _terminate_worker(process)
        process.communicate()
        raise HTTPException(status_code=504, detail="The Board runtime exceeded its hard time limit.")
    if process.returncode != 0 or len(stdout) > 200_000:
        raise HTTPException(status_code=503, detail="The isolated Board runtime worker failed.")
    marker = b"ORIGINPOST_RESULT:"
    encoded = next((line[len(marker):] for line in reversed(stdout.splitlines()) if line.startswith(marker)), b"")
    try:
        result = json.loads(base64.b64decode(encoded, validate=True).decode("utf-8"))
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
        raise HTTPException(status_code=503, detail="The isolated Board runtime returned an invalid result.")
    if not isinstance(result, dict) or result.get("ok") is not True or result.get("schemaVersion") != 2:
        raise HTTPException(status_code=409, detail="The isolated Board runtime rejected its policy.")
    return result


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


def _receipt_name(idempotency_key: str) -> str:
    digest = hashlib.sha256(idempotency_key.encode("utf-8")).hexdigest()
    return f"{digest}.json"


@contextmanager
def _receipt_dir_fd(home: Path) -> Iterator[int]:
    home_fd = _profile_dir_fd(home)
    pending_fd: int | None = None
    receipt_fd: int | None = None
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        try:
            os.mkdir("pending", 0o700, dir_fd=home_fd)
        except FileExistsError:
            pass
        pending_fd = os.open("pending", flags, dir_fd=home_fd)
        try:
            os.mkdir("originpost-receipts", 0o700, dir_fd=pending_fd)
        except FileExistsError:
            pass
        receipt_fd = os.open("originpost-receipts", flags, dir_fd=pending_fd)
        yield receipt_fd
    except HTTPException:
        raise
    except OSError:
        raise HTTPException(status_code=409, detail="The Board decision receipt store is invalid.")
    finally:
        if receipt_fd is not None:
            os.close(receipt_fd)
        if pending_fd is not None:
            os.close(pending_fd)
        os.close(home_fd)


def _read_receipt(home: Path, idempotency_key: str) -> dict[str, Any] | None:
    name = _receipt_name(idempotency_key)
    with _receipt_dir_fd(home) as receipt_fd:
        try:
            descriptor = os.open(name, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0), dir_fd=receipt_fd)
        except FileNotFoundError:
            return None
        except OSError:
            raise HTTPException(status_code=409, detail="The prior decision outcome needs operator review.")
        try:
            file_stat = os.fstat(descriptor)
            if not stat.S_ISREG(file_stat.st_mode) or file_stat.st_nlink != 1 or file_stat.st_size > _MAX_DETAIL:
                raise HTTPException(status_code=409, detail="The prior decision outcome needs operator review.")
            raw = os.read(descriptor, _MAX_DETAIL + 1)
        finally:
            os.close(descriptor)
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise HTTPException(status_code=409, detail="The prior decision outcome needs operator review.")
    if not isinstance(value, dict):
        raise HTTPException(status_code=409, detail="The prior decision outcome needs operator review.")
    return value


def _write_receipt(home: Path, idempotency_key: str, payload: dict[str, Any]) -> None:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    name = _receipt_name(idempotency_key)
    temporary = f".{name}.{secrets.token_hex(8)}.tmp"
    with _receipt_dir_fd(home) as receipt_fd:
        descriptor: int | None = None
        try:
            descriptor = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0), 0o600, dir_fd=receipt_fd)
            offset = 0
            while offset < len(encoded):
                offset += os.write(descriptor, encoded[offset:])
            os.fsync(descriptor)
            os.close(descriptor)
            descriptor = None
            os.replace(temporary, name, src_dir_fd=receipt_fd, dst_dir_fd=receipt_fd)
        except OSError:
            raise HTTPException(status_code=409, detail="The Board decision receipt could not be recorded safely.")
        finally:
            if descriptor is not None:
                os.close(descriptor)
            try:
                os.unlink(temporary, dir_fd=receipt_fd)
            except FileNotFoundError:
                pass
            except OSError:
                pass


def _inside(path: Path, root: Path) -> bool:
    try:
        path.resolve(strict=False).relative_to(root)
        return True
    except (OSError, RuntimeError, ValueError):
        return False


def _tree_scoped(path: Path, home: Path) -> bool:
    """Reject links, special files, and any profile-owned tree that escapes its home."""
    if not _inside(path, home):
        return False
    if not path.exists():
        return True
    try:
        root_stat = path.lstat()
        if stat.S_ISLNK(root_stat.st_mode) or not stat.S_ISDIR(root_stat.st_mode):
            return False
        for index, child in enumerate(path.rglob("*")):
            child_stat = child.lstat()
            if index >= _MAX_SCOPE_ENTRIES or stat.S_ISLNK(child_stat.st_mode) or not _inside(child, home):
                return False
            if stat.S_ISREG(child_stat.st_mode) and child_stat.st_nlink != 1:
                return False
            if not stat.S_ISREG(child_stat.st_mode) and not stat.S_ISDIR(child_stat.st_mode):
                return False
    except (OSError, RuntimeError):
        return False
    return True


def _trust_files_scoped(home: Path) -> bool:
    try:
        for name in ("profile.yaml", "config.yaml", ".env"):
            path = home / name
            file_stat = path.lstat()
            if stat.S_ISLNK(file_stat.st_mode) or not stat.S_ISREG(file_stat.st_mode) or file_stat.st_nlink != 1 or path.resolve(strict=True).parent != home:
                return False
        auth = home / "auth.json"
        if auth.exists() or auth.is_symlink():
            auth_stat = auth.lstat()
            if stat.S_ISLNK(auth_stat.st_mode) or not stat.S_ISREG(auth_stat.st_mode) or auth_stat.st_nlink != 1 or auth.resolve(strict=True).parent != home:
                return False
    except (FileNotFoundError, OSError, RuntimeError):
        return False
    return True


def _isolation_state(profile: str) -> dict[str, bool | int]:
    lexical_home = get_profile_dir(profile).expanduser()
    try:
        profiles_root = _get_profiles_root().expanduser().resolve(strict=True)
        home = lexical_home.resolve(strict=True)
    except (OSError, RuntimeError):
        raise HTTPException(status_code=409, detail="Board profile scope could not be verified.")
    profile_scoped = not lexical_home.is_symlink() and home.parent == profiles_root and home.name == profile and _trust_files_scoped(home)
    memory_scoped = profile_scoped and _tree_scoped(home / "memories", home)
    skills_scoped = profile_scoped and _tree_scoped(home / "skills", home)
    state_scoped = profile_scoped and all(_tree_scoped(home / name, home) for name in ("pending", "sessions", "state", "cron", ".codex", ".originpost-empty-home", ".originpost-empty-codex-home"))
    return {
        "schemaVersion": 1,
        "profileScoped": profile_scoped,
        "memoryScoped": memory_scoped,
        "skillsScoped": skills_scoped,
        "stateScoped": state_scoped,
    }


def _require_isolation(profile: str) -> None:
    state = _isolation_state(profile)
    if not all(state.get(name) is True for name in ("profileScoped", "memoryScoped", "skillsScoped", "stateScoped")):
        raise HTTPException(status_code=409, detail="Board profile scope could not be verified.")


@router.get("/isolation/{profile}")
def isolation(profile: str, signed: SignedHeaders = Depends(_signed_headers)) -> dict[str, Any]:
    """Return booleans only; never disclose profile or filesystem paths."""
    _require_supported_version()
    _authorize_board(profile, "GET", f"/isolation/{profile}", {}, signed)
    return _isolation_state(profile)


@router.post("/seal/{profile}")
def seal(profile: str, body: SealBody, signed: SignedHeaders = Depends(_signed_headers)) -> dict[str, Any]:
    """Bind the current exact skill tree and runtime policy to this Board Profile."""
    _require_supported_version()
    home, _ = _authorize_board(profile, "POST", f"/seal/{profile}", body.model_dump(by_alias=True), signed, reseal=body)
    contract = {
        "owner": body.owner,
        "memoryScope": body.memoryScope,
        "policySha256": body.policySha256,
        "provider": body.provider,
        "model": body.model,
        "enabledSkillsSha256": body.enabledSkillsSha256,
        "skillManifestSha256": "",
    }
    with _lock(profile, "runtime"):
        observed = _run_worker(profile, home, "seal", contract)
        skill_manifest = str(observed.get("skillManifestSha256") or "")
        tool_manifest = str(observed.get("toolManifestSha256") or "")
        if not _SHA256.fullmatch(skill_manifest) or not _SHA256.fullmatch(tool_manifest):
            raise HTTPException(status_code=409, detail="The Board runtime could not be sealed.")
        _write_profile_description(home, _contract_description(contract, skill_manifest))
    return {"schemaVersion": 2, "sealed": True, "skillManifestSha256": skill_manifest, "toolManifestSha256": tool_manifest}


@router.get("/runtime/{profile}")
def runtime(profile: str, signed: SignedHeaders = Depends(_signed_headers)) -> dict[str, Any]:
    """Probe the real AIAgent in a killable, profile-secret-scoped process."""
    _require_supported_version()
    home, contract = _authorize_board(profile, "GET", f"/runtime/{profile}", {}, signed)
    state = _isolation_state(profile)
    if not all(state.get(name) is True for name in ("profileScoped", "memoryScoped", "skillsScoped", "stateScoped")):
        raise HTTPException(status_code=409, detail="Board profile scope could not be verified.")
    with _lock(profile, "runtime"):
        observed = _run_worker(profile, home, "probe", contract)
    return {
        "schemaVersion": 2,
        "ready": True,
        "provider": contract["provider"],
        "model": contract["model"],
        "toolManifestSha256": observed.get("toolManifestSha256"),
        "skillManifestSha256": observed.get("skillManifestSha256"),
    }


@router.post("/run/{profile}")
def run(profile: str, body: RunBody, signed: SignedHeaders = Depends(_signed_headers)) -> dict[str, Any]:
    """Attest and execute in one killable, profile-secret-scoped child."""
    _require_supported_version()
    home, contract = _authorize_board(profile, "POST", f"/run/{profile}", body.model_dump(by_alias=True), signed)
    if body.sessionKey != contract["memoryScope"] or body.skillManifestSha256 != contract["skillManifestSha256"]:
        raise HTTPException(status_code=409, detail="The Board run does not match its sealed policy.")
    state = _isolation_state(profile)
    if not all(state.get(name) is True for name in ("profileScoped", "memoryScoped", "skillsScoped", "stateScoped")):
        raise HTTPException(status_code=409, detail="Board profile scope could not be verified.")
    with _lock(profile, "runtime"):
        observed = _run_worker(profile, home, "run", contract, {
            "prompt": body.prompt,
            "instructions": body.instructions,
            "sessionKey": body.sessionKey,
        })
    return observed


@router.get("/pending/{profile}/{subsystem}")
def list_pending(profile: str, subsystem: str, signed: SignedHeaders = Depends(_signed_headers)) -> dict[str, Any]:
    _require_supported_version()
    profile, subsystem, _ = _validated(profile, subsystem)
    _authorize_board(profile, "GET", f"/pending/{profile}/{subsystem}", {}, signed)
    with _profile_scope(profile):
        records = [_safe_record(record, subsystem) for record in wa.list_pending(subsystem)[:200]]
    return {"profile": profile, "subsystem": subsystem, "pending": records}


@router.get("/pending/{profile}/{subsystem}/{pending_id}")
def pending_detail(profile: str, subsystem: str, pending_id: str, signed: SignedHeaders = Depends(_signed_headers)) -> dict[str, Any]:
    _require_supported_version()
    profile, subsystem, pending_id = _validated(profile, subsystem, pending_id)
    _authorize_board(profile, "GET", f"/pending/{profile}/{subsystem}/{pending_id}", {}, signed)
    with _profile_scope(profile):
        record = wa.get_pending(subsystem, pending_id)
        if not isinstance(record, dict):
            raise HTTPException(status_code=404, detail="Pending write not found.")
        return _safe_record(record, subsystem, include_detail=True)


@router.post("/pending/{profile}/{subsystem}/{pending_id}/decision")
def decide_pending(profile: str, subsystem: str, pending_id: str, body: DecisionBody, signed: SignedHeaders = Depends(_signed_headers)) -> dict[str, Any]:
    _require_supported_version()
    profile, subsystem, pending_id = _validated(profile, subsystem, pending_id)
    if not _IDEMPOTENCY_KEY.fullmatch(body.idempotencyKey):
        raise HTTPException(status_code=422, detail="Invalid idempotency key.")
    _, contract = _authorize_board(
        profile,
        "POST",
        f"/pending/{profile}/{subsystem}/{pending_id}/decision",
        body.model_dump(by_alias=True),
        signed,
        allow_pending=subsystem == wa.SKILLS,
    )
    with _lock(profile, subsystem):
        with _profile_scope(profile) as home:
            receipt = _read_receipt(home, body.idempotencyKey)
            if receipt is not None:
                if receipt.get("pendingId") != pending_id or receipt.get("subsystem") != subsystem or receipt.get("decision") != body.decision or receipt.get("sha256") != body.expectedSha256:
                    raise HTTPException(status_code=409, detail="The idempotency key was already used for another decision.")
                if receipt.get("state") != "complete":
                    raise HTTPException(status_code=409, detail="The prior decision outcome is uncertain and needs operator review.")
                return {"ok": True, "replayed": True, "decision": body.decision, "id": pending_id}

            if contract["skillManifestSha256"] == "pending":
                raise HTTPException(status_code=409, detail="This Board must finish resealing before another skill decision.")

            record = wa.get_pending(subsystem, pending_id)
            if not isinstance(record, dict):
                raise HTTPException(status_code=404, detail="Pending write not found.")
            digest = _canonical_sha256(record)
            if digest != body.expectedSha256:
                raise HTTPException(status_code=409, detail="The pending write changed. Review it again.")

            receipt = {"pendingId": pending_id, "subsystem": subsystem, "decision": body.decision, "sha256": digest, "state": "applying"}
            _write_receipt(home, body.idempotencyKey, receipt)
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
                if subsystem == wa.SKILLS:
                    _write_profile_description(home, _contract_description(contract, "pending"))
            if not wa.discard_pending(subsystem, pending_id):
                raise HTTPException(status_code=409, detail="The decision was applied but its final receipt needs operator review.")

            receipt["state"] = "complete"
            _write_receipt(home, body.idempotencyKey, receipt)
            return {"ok": True, "replayed": False, "decision": body.decision, "id": pending_id}
