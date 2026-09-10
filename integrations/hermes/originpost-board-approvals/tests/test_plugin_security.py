from __future__ import annotations

import hashlib
import hmac
import importlib.util
import json
import os
import base64
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from fastapi import HTTPException


DASHBOARD = Path(__file__).resolve().parents[1] / "dashboard"


def load_module(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, DASHBOARD / filename)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load {filename}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


plugin = load_module("originpost_board_plugin_api_test", "plugin_api.py")
worker = load_module("originpost_board_runtime_worker_test", "runtime_worker.py")


class PluginSecurityTests(unittest.TestCase):
    profile = "opb_" + "1" * 24
    owner = "opb_owner_" + "2" * 40
    memory = "opb_mem_" + "3" * 40
    policy = "4" * 64
    enabled = "5" * 64
    sealed = "6" * 64
    api_key = "k" * 32

    def make_profile(self, root: Path) -> Path:
        home = root / self.profile
        home.mkdir()
        description = (
            f"OriginPost Board runtime; owner={self.owner}; memory={self.memory}; "
            f"policy={self.policy}; provider=openai-codex; model=gpt-5.5; "
            f"skills={self.enabled}; skill_manifest={self.sealed}."
        )
        (home / "profile.yaml").write_text(json.dumps({"description": description}), encoding="utf-8")
        (home / "config.yaml").write_text("model: {}\n", encoding="utf-8")
        (home / ".env").write_text(f"API_SERVER_KEY={self.api_key}\n", encoding="utf-8")
        return home

    def signed(self, route: str, body: object, *, nonce: str = "7" * 32) -> object:
        timestamp = str(int(time.time()))
        body_sha = hashlib.sha256(plugin._canonical_json(body).encode("utf-8")).hexdigest()
        canonical = "\n".join(("GET", route, body_sha, timestamp, nonce, self.owner, self.memory, self.policy))
        signature = hmac.new(self.api_key.encode(), canonical.encode(), hashlib.sha256).hexdigest()
        return plugin.SignedHeaders(timestamp, nonce, signature, self.owner, self.memory, self.policy)

    def profile_patches(self, root: Path):
        return (
            patch.object(plugin, "get_profile_dir", side_effect=lambda _profile: root / self.profile),
            patch.object(plugin, "_get_profiles_root", return_value=root),
            patch.object(plugin, "profile_exists", return_value=True),
        )

    def test_signed_request_succeeds_once_then_replay_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            home = self.make_profile(root)
            route = f"/runtime/{self.profile}"
            signed = self.signed(route, {})
            first, contract = None, None
            first_patch, second_patch, third_patch = self.profile_patches(root)
            with first_patch, second_patch, third_patch:
                first, contract = plugin._authorize_board(self.profile, "GET", route, {}, signed)
                with self.assertRaises(HTTPException) as replay:
                    plugin._authorize_board(self.profile, "GET", route, {}, signed)
            self.assertEqual(first, home.resolve())
            self.assertEqual(contract["memoryScope"], self.memory)
            self.assertEqual(replay.exception.status_code, 409)

    def test_symlinked_trust_file_is_rejected_before_nonce_consumption(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            home = self.make_profile(root)
            (home / "config.yaml").unlink()
            target = root / "outside.yaml"
            target.write_text("model: {}\n", encoding="utf-8")
            (home / "config.yaml").symlink_to(target)
            route = f"/runtime/{self.profile}"
            first_patch, second_patch, third_patch = self.profile_patches(root)
            with first_patch, second_patch, third_patch:
                with self.assertRaises(HTTPException) as rejected:
                    plugin._authorize_board(self.profile, "GET", route, {}, self.signed(route, {}))
            self.assertEqual(rejected.exception.status_code, 409)
            self.assertFalse((home / "state" / "originpost-auth-nonces").exists())

    def test_symlinked_runtime_state_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            home = self.make_profile(root)
            outside = root / "outside"
            outside.mkdir()
            (home / "state").symlink_to(outside, target_is_directory=True)
            first_patch, second_patch, third_patch = self.profile_patches(root)
            with first_patch, second_patch, third_patch:
                with self.assertRaises(HTTPException) as rejected:
                    plugin._require_isolation(self.profile)
            self.assertEqual(rejected.exception.status_code, 409)

    def test_hardlinked_profile_credential_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            home = self.make_profile(root)
            outside = root / "shared-auth.json"
            outside.write_text("{}", encoding="utf-8")
            os.link(outside, home / "auth.json")
            first_patch, second_patch, third_patch = self.profile_patches(root)
            with first_patch, second_patch, third_patch:
                with self.assertRaises(HTTPException) as rejected:
                    plugin._require_isolation(self.profile)
            self.assertEqual(rejected.exception.status_code, 409)

    def test_pending_skill_seal_blocks_normal_routes_but_allows_idempotent_decision_recovery(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            home = self.make_profile(root)
            profile = json.loads((home / "profile.yaml").read_text(encoding="utf-8"))
            profile["description"] = profile["description"].replace(f"skill_manifest={self.sealed}", "skill_manifest=pending")
            (home / "profile.yaml").write_text(json.dumps(profile), encoding="utf-8")
            route = f"/pending/{self.profile}/skills/a1b2c3d4/decision"
            body = {"decision": "approve", "expectedSha256": "8" * 64, "idempotencyKey": "test-idempotency-key"}
            timestamp = str(int(time.time()))
            nonce = "9" * 32
            body_sha = hashlib.sha256(plugin._canonical_json(body).encode()).hexdigest()
            canonical = "\n".join(("POST", route, body_sha, timestamp, nonce, self.owner, self.memory, self.policy))
            signed = plugin.SignedHeaders(timestamp, nonce, hmac.new(self.api_key.encode(), canonical.encode(), hashlib.sha256).hexdigest(), self.owner, self.memory, self.policy)
            first_patch, second_patch, third_patch = self.profile_patches(root)
            with first_patch, second_patch, third_patch:
                with self.assertRaises(HTTPException) as blocked:
                    plugin._authorize_board(self.profile, "POST", route, body, signed)
                self.assertEqual(blocked.exception.status_code, 409)
                home_value, contract = plugin._authorize_board(self.profile, "POST", route, body, signed, allow_pending=True)
            self.assertEqual(home_value, home.resolve())
            self.assertEqual(contract["skillManifestSha256"], "pending")

    def test_child_environment_is_board_local_and_drops_ambient_secrets(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            with patch.dict(os.environ, {"PATH": "/bin", "OPENAI_API_KEY": "ambient", "CODEX_API_KEY": "ambient"}, clear=True):
                environment = plugin._child_environment(home)
            self.assertEqual(environment["HOME"], str(home / ".originpost-empty-home"))
            self.assertEqual(environment["HERMES_HOME"], str(home))
            self.assertEqual(environment["CODEX_HOME"], str(home / ".originpost-empty-codex-home"))
            self.assertNotIn("OPENAI_API_KEY", environment)
            self.assertNotIn("CODEX_API_KEY", environment)

    def test_child_environment_rejects_a_fallback_credential_store(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            fallback = home / ".originpost-empty-home" / ".hermes"
            fallback.mkdir(parents=True)
            (fallback / "auth.json").write_text("{}", encoding="utf-8")
            with self.assertRaises(HTTPException) as rejected:
                plugin._child_environment(home)
            self.assertEqual(rejected.exception.status_code, 409)
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            fallback = home / ".originpost-empty-codex-home"
            fallback.mkdir()
            (fallback / "auth.json").write_text("{}", encoding="utf-8")
            with self.assertRaises(HTTPException) as rejected:
                plugin._child_environment(home)
            self.assertEqual(rejected.exception.status_code, 409)

    def test_hardlinked_profile_state_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            home = self.make_profile(root)
            state = home / "state"
            state.mkdir()
            outside = root / "shared-state.json"
            outside.write_text("{}", encoding="utf-8")
            os.link(outside, state / "shared.json")
            first_patch, second_patch, third_patch = self.profile_patches(root)
            with first_patch, second_patch, third_patch:
                with self.assertRaises(HTTPException) as rejected:
                    plugin._require_isolation(self.profile)
            self.assertEqual(rejected.exception.status_code, 409)

    def test_worker_timeout_terminates_the_process_group(self):
        process = Mock()
        process.pid = 123
        process.communicate.side_effect = [subprocess.TimeoutExpired("worker", 1), (b"", b"")]
        with tempfile.TemporaryDirectory() as temporary, patch.object(plugin.subprocess, "Popen", return_value=process), patch.object(plugin, "_terminate_worker") as terminate, patch.object(plugin, "_child_environment", return_value={}):
            with self.assertRaises(HTTPException) as rejected:
                plugin._run_worker(self.profile, Path(temporary), "probe", {"provider": "openai-codex", "model": "gpt-5.5", "enabledSkillsSha256": self.enabled, "skillManifestSha256": self.sealed})
        self.assertEqual(rejected.exception.status_code, 504)
        terminate.assert_called_once_with(process)

    def test_runtime_rejects_dirty_exact_source(self):
        identity = {"version": worker.SUPPORTED_VERSION, "sha": worker.SUPPORTED_SHA, "source": "git"}
        checked = subprocess.CompletedProcess(["git"], 0, stdout=b"?? injected.py\n", stderr=b"")
        with patch.object(worker.sys, "dont_write_bytecode", True), patch("hermes_cli.build_info.get_code_identity", return_value=identity), patch.object(worker.inspect, "getfile", return_value="/tmp/hermes/hermes_cli/build_info.py"), patch.object(worker.shutil, "which", return_value="/usr/bin/git"), patch.object(worker.subprocess, "run", return_value=checked):
            with self.assertRaisesRegex(RuntimeError, "runtime_source_dirty"):
                worker._require_build()

    def test_runtime_rejects_ignored_executable_bytecode(self):
        clean = subprocess.CompletedProcess(["git"], 0, stdout=b"", stderr=b"")
        ignored = subprocess.CompletedProcess(["git"], 0, stdout=b"agent/__pycache__/agent.cpython-311.pyc\0", stderr=b"")
        with patch.object(worker.sys, "dont_write_bytecode", True), patch.object(worker.shutil, "which", return_value="/usr/bin/git"), patch.object(worker.subprocess, "run", side_effect=[clean, ignored]):
            with self.assertRaisesRegex(RuntimeError, "runtime_ignored_code"):
                worker._require_build()

    def test_final_agent_contract_rejects_bypassing_or_mutated_runtime(self):
        agent = Mock(provider="openai-codex", model="gpt-5.5", api_mode="codex_app_server", max_tokens=4_000)
        with self.assertRaisesRegex(RuntimeError, "agent_contract_drift"):
            worker._require_agent_contract(agent, "openai-codex", "gpt-5.5")
        agent.api_mode = "codex_responses"
        worker._require_agent_contract(agent, "openai-codex", "gpt-5.5")
        agent.max_tokens = 8_000
        with self.assertRaisesRegex(RuntimeError, "agent_contract_drift"):
            worker._require_agent_contract(agent, "openai-codex", "gpt-5.5")

    def test_exact_clean_runtime_constructs_the_pinned_codex_responses_tools(self):
        from hermes_cli.build_info import get_code_identity

        identity = get_code_identity(refresh=True)
        self.assertEqual(identity.get("version"), worker.SUPPORTED_VERSION)
        self.assertEqual(identity.get("sha"), worker.SUPPORTED_SHA)
        hermes_root = Path(__import__("hermes_cli").__file__).resolve().parent.parent
        bundled_skill = hermes_root / "skills" / "autonomous-ai-agents" / "hermes-agent"
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary) / self.profile
            home.mkdir()
            shutil.copy(DASHBOARD.parent / "tests" / "fixtures" / "compliant-config.yaml", home / "config.yaml")
            shutil.copytree(bundled_skill, home / "skills" / "hermes-agent")
            (home / "skills" / ".bundled_manifest").write_text("hermes-agent:test-fixture\n", encoding="utf-8")
            (home / "profile.yaml").write_text("name: runtime-test\n", encoding="utf-8")
            (home / ".env").write_text(f"API_SERVER_KEY={self.api_key}\n", encoding="utf-8")
            (home / "auth.json").write_text(json.dumps({
                "version": 1,
                "active_provider": "openai-codex",
                "providers": {"openai-codex": {"tokens": {"access_token": "test-access", "refresh_token": "test-refresh"}, "last_refresh": "2026-09-09T00:00:00Z", "auth_mode": "chatgpt"}},
            }), encoding="utf-8")
            environment = plugin._child_environment(home)
            environment["PYTHONPATH"] = str(hermes_root)
            payload = {
                "operation": "seal",
                "profile": self.profile,
                "home": str(home),
                "provider": "openai-codex",
                "model": "gpt-5.5",
                "enabledSkillsSha256": hashlib.sha256(b"").hexdigest(),
                "sealedSkillManifestSha256": "",
            }
            completed = subprocess.run(
                [sys.executable, str(DASHBOARD / "runtime_worker.py")],
                input=json.dumps(payload).encode(),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=environment,
                timeout=90,
                check=False,
            )
        marker = b"ORIGINPOST_RESULT:"
        encoded = next((line[len(marker):] for line in reversed(completed.stdout.splitlines()) if line.startswith(marker)), b"")
        result = json.loads(base64.b64decode(encoded, validate=True))
        self.assertEqual(completed.returncode, 0, completed.stderr.decode(errors="replace"))
        self.assertTrue(result.get("ok"), result)
        self.assertEqual(result.get("toolManifestSha256"), worker.EXPECTED_TOOL_MANIFEST_SHA256)


if __name__ == "__main__":
    unittest.main()
