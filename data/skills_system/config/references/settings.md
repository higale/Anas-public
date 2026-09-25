# Settings Configuration Reference

Call `update_config` with `config: "settings"` and one key below. Use the stored English tokens exactly even when the user speaks another language.

## Assistant and user profile

| Key | Value | Meaning |
| --- | --- | --- |
| `profile.assistant.name` | non-empty string | Assistant display name. |
| `profile.assistant.role` | string | Who the assistant is: identity, purpose, abilities, and character. Empty clears it. |
| `profile.assistant.instructions` | string | Persistent behavioral instructions. Empty clears them. |
| `profile.assistant.new_avatar_path` | non-empty image path string or `"default"` | One-time avatar request. Use an absolute path or a path relative to the active workspace to replace the avatar; use the exact string `"default"` to restore the default avatar. Supported image formats are PNG, JPG, WebP, GIF, and BMP. Anas clears this value after the attempt. |
| `profile.user.preferred_name` | string | How the assistant should address the user. Empty uses a neutral form of address. |
| `profile.user.personal_info` | string | Free-form profile information the user explicitly chose to store. Empty clears it. Never store authentication secrets. |

For an avatar request, report success only when the tool returns `ok: true` and `avatar_updated: true`. A handled failure is cleared and is not retried by later configuration refreshes; retry only after the user asks or provides another path.

## Speech reply

| Key | Value |
| --- | --- |
| `speech_reply.enabled` | boolean |
| `speech_reply.voice` | non-empty speech voice ID string |
| `speech_reply.speed` | number from `0.25` through `4` |

## Appearance and language

| Key | Value |
| --- | --- |
| `language` | `"system"` or an installed language-pack code; bundled codes are `"en"` and `"zh-CN"` |
| `theme` | `"system"`, `"light"`, or `"dark"` |
| `font_size` | integer from `11` through `18` |
| `chat_content_width` | `"narrow"`, `"wide"`, or `"adaptive"` |
| `sidebar_visible` | boolean |
| `sidebar_width` | integer from `220` through `420` |
| `workspace_panel_width` | safe integer of at least `320`; the UI limits the displayed width to available space |
| `sidebar_collapsed_sections.projects` | boolean |
| `sidebar_collapsed_sections.simple_chats` | boolean |
| `diff_view_mode` | `"inline"` or `"side_by_side"` |
| `diff_fold_unchanged` | boolean |
| `diff_word_wrap` | boolean |

## Conversation and attachments

| Key | Value |
| --- | --- |
| `new_thread_model_selection` | `"prompt"`, `"default"`, or `"current"` |
| `default_model_id` | exact configured model ID string, or `null` to clear the default |
| `attachment_text_max_chars` | integer from `1000` through `2000000` |
| `attachment_text_overflow` | `"truncate"` or `"error"` |
| `max_model_calls_per_run` | integer from `0` through `9999`; `0` means no application limit |

Do not guess a model ID. Change `default_model_id` only when the exact configured ID is available.

## Runtime environment context

Every switch below takes a boolean. `environment_context.custom_information` takes a string.

- `environment_context.operating_system`
- `environment_context.power_shell`
- `environment_context.bundled_commands` — include bundled command instructions (currently rg) when command execution tools are available
- `environment_context.current_date`
- `environment_context.application_data_directory`
- `environment_context.user_home_directory`
- `environment_context.custom_information_enabled`
- `environment_context.custom_information`

## Logs and storage

| Key | Value |
| --- | --- |
| `log_level` | `"trace"`, `"debug"`, `"info"`, `"warn"`, `"error"`, or `"off"` |
| `log_retention_days` | integer from `0` through `3650` |
| `backup_dir` | empty string for the default, or an absolute directory path |
