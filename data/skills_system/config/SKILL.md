---
name: config
description: "Modify Anas application settings and the assistant avatar when the user asks to change appearance, conversation defaults, environment context, speech reply, assistant identity or behavior, avatar, or user profile details. Do not use for capability selection, model/provider definitions, projects, MCP servers, subagents, Skills, or temporary instructions for only the current conversation."
compatibility: "Requires Anas and its update_config tool implementing the settings schema in references/settings.md."
---

# Application Settings

Read [references/settings.md](references/settings.md) before changing a setting. It is the source of truth for supported keys, value types, ranges, and enum values.

Use `update_config` with `config: "settings"`, one dot-separated leaf key, and the complete replacement value. Pass `value` as its actual JSON type, never as serialized JSON text. For example, pass a string as `"dark"`, a boolean as `true`, and a number as `14`.

Only persist a change when the user explicitly asks for it. Modify only the requested keys. Do not edit `settings.json` through file tools, guess undocumented keys or enum values, or claim success unless the tool returns `ok: true`.

For assistant and user profile settings:

- Distinguish identity (`profile.assistant.role`) from lasting behavior (`profile.assistant.instructions`).
- To replace the assistant avatar, set `profile.assistant.new_avatar_path` to an absolute image path or a path relative to the active workspace. To restore the default avatar, set the same key to the exact string `"default"`. This is a one-time request: Anas applies it and clears the value before the tool returns. Do not retry a failed avatar update unless the user asks or supplies another value.
- Store user details only when the user explicitly asks to update their profile. Never infer personal details or store passwords, tokens, private keys, or other authentication secrets.
- Use memory rather than profile settings for ordinary facts the user asks the agent to remember without describing them as profile information.
