"""Killable Hermes 0.21.2 execution worker for one OriginPost Board Profile.

The dashboard extension launches this file in a fresh process for every probe
and run.  The child receives only one profile's environment, enters Hermes'
official profile runtime/secret scope, and returns one bounded JSON envelope.
"""

from __future__ import annotations

import base64
import hashlib
import inspect
import json
import os
import shutil
import stat
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any


SUPPORTED_VERSION = "0.21.2"
SUPPORTED_SHA = "939e45c91d751fadd94dcd1b873ac3cb44846213"
RUNTIME_TOOLSETS = ("memory", "skills", "no_mcp")
RUNTIME_TOOLS = frozenset({"memory", "skill_manage", "skill_view", "skills_list"})
MAX_SCOPE_ENTRIES = 10_000
MAX_SKILL_BYTES = 10 * 1024 * 1024
RUN_MAX_ITERATIONS = 8
RUN_MAX_TOKENS = 4_000
RUN_BUDGET_SECONDS = 180.0
MAX_RESULT = 100_000
ESSENTIAL_SKILL_TREE_SHA256 = "a9a7130ca89a9e7c7b003d42341bac45dcef082559c1906083d0995ec2960562"
EXPECTED_TOOL_MANIFEST_SHA256 = "8d4f839a12bb2f391c2f1514f98c110051106a5a79c5cd97160e3b01aba758f6"

EXPECTED_TOOLS = {
    "memory": {
        "toolset": "memory",
        "module": "tools.memory_tool",
        "schemaSha256": "838bcb453a8686dc2488c632074fc3f3f8510c2d3dc8dd9c28e0b2f9db150620",
        "handlerFileSha256": "ed9c5db6b3144b88425f7039280239b29a047143aa8ffdfd3b7f47bf7e707143",
        "checkModule": "tools.memory_tool",
        "dynamicModule": "tools.memory_tool",
        "finalSchemaSha256": "896214490c8940931706e9f1441158bfc31aa71977931a79031ff9fa299ded89",
    },
    "skill_manage": {
        "toolset": "skills",
        "module": "tools.skill_manager_tool",
        "schemaSha256": "f21b7abd43788ff2601729aed6cf7be7ab518860b9d7c654c294a0491fcb05bb",
        "handlerFileSha256": "87f088f543adbac9723ef196336f424adf2afd15a6c71c5e0e2918173df1a386",
        "checkModule": "",
        "dynamicModule": "",
        "finalSchemaSha256": "a5f4553141a6e2435f460110e40077532362fae328348975af7039205f6342ce",
    },
    "skill_view": {
        "toolset": "skills",
        "module": "tools.skills_tool",
        "schemaSha256": "b659333299dc2d1c7fb5a4fb18fb86c3426b47cf4e453772a85c9bfe1e2e92de",
        "handlerFileSha256": "0f205b8c2d9266d272d8c6cae3d189b86a5aebce98f03b61605d266b65f9497c",
        "checkModule": "tools.skills_tool",
        "dynamicModule": "",
        "finalSchemaSha256": "500f19c906409a9923211274f0fd1d752342aea6b5ea24ae0dc8c520a6426f77",
    },
    "skills_list": {
        "toolset": "skills",
        "module": "tools.skills_tool",
        "schemaSha256": "b63eb8ddaea7296ac3ab6cb7d6a7b817ea92ba5ec3bd66331770355db313bf57",
        "handlerFileSha256": "0f205b8c2d9266d272d8c6cae3d189b86a5aebce98f03b61605d266b65f9497c",
        "checkModule": "tools.skills_tool",
        "dynamicModule": "",
        "finalSchemaSha256": "ee7599879125b4ca354f8059204b6e3ae46c6a9acf9d7d7bc8e9cbd82136108f",
    },
}


def _canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _sha(value: Any) -> str:
    return hashlib.sha256(_canonical(value)).hexdigest()


def _file_sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(64 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _callable_module(registry: Any, value: Any) -> str:
    return registry._callable_module(value) if value is not None else ""


def _schema_for_digest(value: Any, profile_home: Path) -> Any:
    """Normalize only Hermes' documented profile-specific skill-create path."""
    if isinstance(value, dict):
        return {key: _schema_for_digest(item, profile_home) for key, item in value.items()}
    if isinstance(value, list):
        return [_schema_for_digest(item, profile_home) for item in value]
    if isinstance(value, str):
        result = value
        homes = {str(profile_home), os.environ.get("HERMES_HOME", "").strip()}
        for home in sorted((item for item in homes if item), key=len, reverse=True):
            result = result.replace(f"{Path(home) / 'skills'}{os.sep}", "<BOARD_PROFILE>/skills/")
        return result
    return value


def _require_build() -> Path:
    if not sys.dont_write_bytecode:
        raise RuntimeError("bytecode_writes_enabled")
    candidates = [Path(value).resolve() for value in sys.path if value and (Path(value) / "hermes_cli" / "__init__.py").is_file()]
    if not candidates:
        raise RuntimeError("hermes_source_unavailable")
    root = candidates[0]
    git = shutil.which("git")
    if not git:
        raise RuntimeError("git_unavailable")
    checked = subprocess.run(
        [git, "-C", str(root), "status", "--porcelain=v1", "--untracked-files=all"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        timeout=10,
        check=False,
    )
    if checked.returncode != 0 or checked.stdout.strip():
        raise RuntimeError("runtime_source_dirty")
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
        raise RuntimeError("runtime_ignored_code")
    from hermes_cli.build_info import get_code_identity

    identity = get_code_identity(refresh=True)
    if identity.get("version") != SUPPORTED_VERSION or identity.get("sha") != SUPPORTED_SHA or identity.get("source") != "git" or Path(inspect.getfile(get_code_identity)).resolve().parents[1] != root:
        raise RuntimeError("unsupported_build")
    return root


def _require_profile_files(home: Path) -> None:
    for name in ("profile.yaml", "config.yaml", ".env"):
        path = home / name
        file_stat = path.lstat()
        if stat.S_ISLNK(file_stat.st_mode) or not stat.S_ISREG(file_stat.st_mode) or file_stat.st_nlink != 1 or path.resolve(strict=True).parent != home:
            raise RuntimeError("profile_trust_file_invalid")
    auth = home / "auth.json"
    if auth.exists() or auth.is_symlink():
        auth_stat = auth.lstat()
        if stat.S_ISLNK(auth_stat.st_mode) or not stat.S_ISREG(auth_stat.st_mode) or auth_stat.st_nlink != 1 or auth.resolve(strict=True).parent != home:
            raise RuntimeError("profile_auth_file_invalid")


def _runtime_config() -> tuple[str, str]:
    from hermes_cli.config import load_config

    config = load_config()
    memory = config.get("memory") if isinstance(config.get("memory"), dict) else {}
    skills = config.get("skills") if isinstance(config.get("skills"), dict) else {}
    model = config.get("model") if isinstance(config.get("model"), dict) else {}
    context = config.get("context") if isinstance(config.get("context"), dict) else {}
    plugins = config.get("plugins") if isinstance(config.get("plugins"), dict) else {}
    platform_toolsets = config.get("platform_toolsets") if isinstance(config.get("platform_toolsets"), dict) else {}
    provider = str(model.get("provider") or "")
    model_name = str(model.get("default") or "")
    api_toolsets = platform_toolsets.get("api_server")
    compliant = (
        memory.get("memory_enabled") is True
        and memory.get("user_profile_enabled") is True
        and memory.get("write_approval") is True
        and memory.get("provider") == ""
        and skills.get("write_approval") is True
        and skills.get("external_dirs") == []
        and skills.get("create_dir") == ""
        and skills.get("project_discovery") is False
        and skills.get("trusted_project_dirs") == []
        and skills.get("inline_shell") is False
        and provider == "openai-codex"
        and bool(model_name)
        and model.get("openai_runtime") == "auto"
        and model.get("max_tokens") == RUN_MAX_TOKENS
        and context.get("engine") == "compressor"
        and config.get("fallback_providers") == []
        and config.get("fallback_model") == []
        and isinstance(api_toolsets, list)
        and all(isinstance(item, str) for item in api_toolsets)
        and sorted(set(api_toolsets)) == sorted(RUNTIME_TOOLSETS)
        and plugins.get("enabled") == []
        and plugins.get("entries") == {}
    )
    if not compliant:
        raise RuntimeError("runtime_policy")
    return provider, model_name


def _tree_digest(root: Path) -> str:
    records: list[tuple[str, str]] = []
    total = 0
    root_stat = root.lstat()
    if stat.S_ISLNK(root_stat.st_mode) or not stat.S_ISDIR(root_stat.st_mode):
        raise RuntimeError("skill_tree_invalid")
    for index, path in enumerate(sorted(root.rglob("*"), key=lambda item: item.as_posix())):
        path_stat = path.lstat()
        if index >= MAX_SCOPE_ENTRIES or stat.S_ISLNK(path_stat.st_mode):
            raise RuntimeError("skill_tree_invalid")
        resolved = path.resolve(strict=True)
        resolved.relative_to(root.resolve(strict=True))
        if stat.S_ISREG(path_stat.st_mode):
            if path_stat.st_nlink != 1:
                raise RuntimeError("skill_tree_hardlink")
            total += path_stat.st_size
            if total > MAX_SKILL_BYTES:
                raise RuntimeError("skill_tree_too_large")
            records.append((path.relative_to(root).as_posix(), _file_sha(path)))
        elif not stat.S_ISDIR(path_stat.st_mode):
            raise RuntimeError("skill_tree_invalid")
    return _sha(records)


def _skill_manifest(home: Path, expected_names_sha256: str) -> str:
    from agent.skill_utils import (
        get_disabled_skill_names,
        is_excluded_skill_path,
        skill_matches_environment,
        skill_matches_platform,
    )
    from tools.skill_usage import _read_bundled_manifest_names, _read_hub_installed_names
    from tools.skills_tool import _parse_frontmatter

    skills_root = (home / "skills").resolve(strict=True)
    disabled = get_disabled_skill_names("api_server")
    bundled = _read_bundled_manifest_names()
    hub = _read_hub_installed_names()
    manifest: list[dict[str, str]] = []
    seen: set[str] = set()
    for skill_md in sorted(skills_root.rglob("SKILL.md"), key=lambda item: item.as_posix()):
        if is_excluded_skill_path(skill_md, root=skills_root):
            continue
        skill_root = skill_md.parent
        if skill_root.is_symlink() or skill_md.is_symlink():
            raise RuntimeError("skill_symlink")
        resolved_root = skill_root.resolve(strict=True)
        resolved_root.relative_to(skills_root)
        frontmatter, _ = _parse_frontmatter(skill_md.read_text(encoding="utf-8")[:4_000])
        name = str(frontmatter.get("name") or skill_root.name)
        if not name or name in seen:
            raise RuntimeError("skill_name_collision")
        seen.add(name)
        if name in disabled or not skill_matches_platform(frontmatter) or not skill_matches_environment(frontmatter):
            continue
        provenance = "hub" if name in hub else "bundled" if name in bundled else "agent"
        tree_sha = _tree_digest(resolved_root)
        if name == "hermes-agent" and (provenance != "bundled" or tree_sha != ESSENTIAL_SKILL_TREE_SHA256):
            raise RuntimeError("essential_skill_drift")
        manifest.append({
            "name": name,
            "provenance": provenance,
            "realRoot": str(resolved_root),
            "treeSha256": tree_sha,
        })
    manifest.sort(key=lambda item: item["name"])
    nonessential = sorted(item["name"] for item in manifest if item["name"] != "hermes-agent")
    if "hermes-agent" not in {item["name"] for item in manifest}:
        raise RuntimeError("essential_skill_missing")
    names_sha = hashlib.sha256("\n".join(nonessential).encode("utf-8")).hexdigest()
    if names_sha != expected_names_sha256:
        raise RuntimeError("skill_policy_drift")
    return _sha(manifest)


def _tool_manifest(agent: Any, hermes_root: Path, profile_home: Path) -> str:
    from tools.registry import registry

    definitions = getattr(agent, "tools", None)
    if not isinstance(definitions, list) or len(definitions) != len(RUNTIME_TOOLS):
        raise RuntimeError("tool_surface_invalid")
    by_name: dict[str, dict[str, Any]] = {}
    for definition in definitions:
        function = definition.get("function") if isinstance(definition, dict) else None
        name = function.get("name") if isinstance(function, dict) else None
        if not isinstance(name, str) or name in by_name:
            raise RuntimeError("tool_schema_collision")
        by_name[name] = definition
    if frozenset(by_name) != RUNTIME_TOOLS or frozenset(getattr(agent, "valid_tool_names", set()) or set()) != RUNTIME_TOOLS:
        raise RuntimeError("tool_names_invalid")

    manifest: list[dict[str, str]] = []
    for name in sorted(RUNTIME_TOOLS):
        expected = EXPECTED_TOOLS[name]
        entry = registry.get_entry(name)
        if entry is None:
            raise RuntimeError("tool_entry_missing")
        module = _callable_module(registry, entry.handler)
        check_module = _callable_module(registry, entry.check_fn)
        dynamic_module = _callable_module(registry, entry.dynamic_schema_overrides)
        source = inspect.getsourcefile(entry.handler)
        if source is None:
            raise RuntimeError("tool_handler_source_missing")
        source_path = Path(source).resolve(strict=True)
        source_path.relative_to(hermes_root.resolve(strict=True))
        raw_schema_sha = _sha(_schema_for_digest({**entry.schema, "name": entry.name}, profile_home))
        actual = {
            "name": name,
            "toolset": str(entry.toolset),
            "module": module,
            "schemaSha256": raw_schema_sha,
            "handlerFileSha256": _file_sha(source_path),
            "checkModule": check_module,
            "dynamicModule": dynamic_module,
            "finalSchemaSha256": _sha(_schema_for_digest(by_name[name], profile_home)),
        }
        if any(actual[key] != expected[key] for key in expected):
            raise RuntimeError("tool_provenance_drift")
        manifest.append(actual)
    digest = _sha(manifest)
    if digest != EXPECTED_TOOL_MANIFEST_SHA256:
        raise RuntimeError("tool_manifest_drift")
    return digest


def _close(agent: Any) -> None:
    try:
        agent.close()
    except Exception:
        pass


def _require_agent_contract(agent: Any, provider: str, model: str) -> None:
    if (
        str(getattr(agent, "provider", "") or "") != provider
        or str(getattr(agent, "model", "") or "") != model
        or getattr(agent, "api_mode", None) != "codex_responses"
        or getattr(agent, "max_tokens", None) != RUN_MAX_TOKENS
    ):
        raise RuntimeError("agent_contract_drift")


def _execute(payload: dict[str, Any]) -> dict[str, Any]:
    hermes_root = _require_build()
    home = Path(str(payload.get("home") or "")).expanduser().resolve(strict=True)
    expected_home = Path(os.environ.get("HERMES_HOME", "")).expanduser().resolve(strict=True)
    if home != expected_home or home.name != payload.get("profile"):
        raise RuntimeError("profile_scope_invalid")
    _require_profile_files(home)
    for name in ("memories", "skills", "state"):
        tree = home / name
        if tree.exists():
            _tree_digest(tree)
    operation = payload.get("operation")
    if operation not in {"seal", "probe", "run"}:
        raise RuntimeError("operation_invalid")
    names_sha = str(payload.get("enabledSkillsSha256") or "")
    sealed_skill_sha = str(payload.get("sealedSkillManifestSha256") or "")
    if len(names_sha) != 64 or (operation != "seal" and len(sealed_skill_sha) != 64):
        raise RuntimeError("skill_contract_invalid")

    from agent.secret_scope import set_multiplex_active
    from gateway.run import _profile_runtime_scope, _resolve_runtime_agent_kwargs
    from run_agent import AIAgent

    set_multiplex_active(True)
    with _profile_runtime_scope(home):
        provider, model = _runtime_config()
        if provider != payload.get("provider") or model != payload.get("model"):
            raise RuntimeError("model_contract_drift")
        skill_sha = _skill_manifest(home, names_sha)
        if operation != "seal" and skill_sha != sealed_skill_sha:
            raise RuntimeError("skill_manifest_drift")
        kwargs = _resolve_runtime_agent_kwargs()
        if str(kwargs.get("provider") or "") != provider or kwargs.get("api_mode") != "codex_responses":
            raise RuntimeError("provider_resolution_drift")
        session_id = str(uuid.uuid4())
        agent = AIAgent(
            model=model,
            **kwargs,
            max_iterations=RUN_MAX_ITERATIONS,
            enabled_toolsets=list(RUNTIME_TOOLSETS),
            quiet_mode=True,
            verbose_logging=False,
            ephemeral_system_prompt=str(payload.get("instructions") or "") if operation == "run" else None,
            session_id=session_id,
            gateway_session_key=str(payload.get("sessionKey") or f"opb_mem_{'0' * 40}"),
            platform="api_server",
            max_tokens=RUN_MAX_TOKENS,
            skip_context_files=True,
            load_soul_identity=False,
            skip_background_review=True,
            fallback_model=None,
            checkpoints_enabled=False,
            run_budget_seconds=RUN_BUDGET_SECONDS,
        )
        try:
            _require_agent_contract(agent, provider, model)
            tool_sha = _tool_manifest(agent, hermes_root, home)
            if operation in {"seal", "probe"}:
                return {"ready": True, "provider": provider, "model": model, "toolManifestSha256": tool_sha, "skillManifestSha256": skill_sha}
            result = agent.run_conversation(user_message=str(payload.get("prompt") or ""), conversation_history=[], task_id=session_id)
            _require_agent_contract(agent, provider, model)
            if _tool_manifest(agent, hermes_root, home) != tool_sha or _skill_manifest(home, names_sha) != skill_sha:
                raise RuntimeError("runtime_changed_during_run")
            text = str(result.get("final_response") or "").strip() if isinstance(result, dict) else ""
            if not text:
                raise RuntimeError("empty_result")
            return {
                "id": f"opbrun_{uuid.uuid4().hex}",
                "model": model,
                "text": text[:MAX_RESULT],
                "toolManifestSha256": tool_sha,
                "skillManifestSha256": skill_sha,
                "usage": {
                    "inputTokens": int(getattr(agent, "session_prompt_tokens", 0) or 0),
                    "outputTokens": int(getattr(agent, "session_completion_tokens", 0) or 0),
                },
            }
        finally:
            _close(agent)


def main() -> None:
    try:
        raw = sys.stdin.buffer.read(64 * 1024)
        payload = json.loads(raw.decode("utf-8"))
        if not isinstance(payload, dict):
            raise RuntimeError("payload_invalid")
        result = {"ok": True, "schemaVersion": 2, **_execute(payload)}
    except Exception:
        result = {"ok": False, "schemaVersion": 2, "errorCode": "runtime_policy_rejected"}
    encoded = base64.b64encode(_canonical(result)).decode("ascii")
    sys.stdout.write(f"ORIGINPOST_RESULT:{encoded}\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
