alter table agent_runtime_profiles drop constraint agent_runtime_profiles_preset_check;
alter table agent_runtime_profiles add constraint agent_runtime_profiles_preset_check check (preset in ('openai','openrouter','ollama','custom','codex-local'));
