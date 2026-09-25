# Anas Skills Guide

Languages: [English](./AGENT_SKILLS.en.md) | [中文](./AGENT_SKILLS.zh-CN.md) · [Back to the user guide](./USER_GUIDE.en.md)

A skill provides instructions an Agent reads when needed, optionally with scripts and reference material. Enabling a skill does not install dependencies or enable tool permissions.

## Add And Manage Skills

Use **Settings > Skills** to manage global sources and browse skill instructions and files. Files are read-only; click a Skill's location or a file's **Open** button to locate it in your file manager for editing.

- **Import skills**: Select the **User** group or one of its skills, then choose **Import**. Select one or more skill directories containing `SKILL.md` to copy into `skills/` under application data. Name conflicts prevent import without overwriting existing skills. The picker opens in the examples directory by default.
- **Add directory**: Select an external directory containing skill subdirectories. Anas references its files without copying them. External sources can be renamed, assigned shortcut aliases, reordered, or removed. Removing a source only removes its reference, not its files.
- **Project skills**: Place them in `.agents/skills/` under each project source folder. They appear in that project's capability choices and conversations, not on the global Skills page.

`~/.agents/skills` is a default external source and can be removed. Refresh after editing files; unreadable skills show an error.

## Choose Who Can Use Skills

**Available to model** and **Available to user** control separate uses:

- **Available to model** supplies the Agent with the name, description, and absolute `SKILL.md` path so it can read the instructions when relevant.
- **Available to user** allows explicit invocation with `/skill-name request` in the message input. Type `/` to see suggestions. Anas sends the complete, unchanged `SKILL.md` and its source path, with the text after the command as a separate user request; expand the skill entry in the conversation to inspect the actual submitted text.

Global switches provide defaults. In a project's **Customize capabilities > Skills**, **Use default** follows global settings; **Custom** selects each use independently, including enabling globally disabled skills. Turning the main Skills switch off preserves selections but stops providing the skill catalog and shortcuts. Skills with loading errors remain unavailable.

Subagents configure model use only, may enable **Project skills**, and follow the project's **Limit subagent capabilities** setting. See [Subagents](./USER_GUIDE.en.md#subagents).

Name conflicts are resolved separately for effective model and user selections: project source-folder order → User → external directory order → System. `/name` uses the preferred entry; `/name@alias` selects a source, for example `/name@user`. Edit external-source aliases on the Skills page.

## Script Auto-Approval

**Auto-approve all Skill scripts** at the top right and **Auto-approve scripts** on each Skill both default to off. Either setting grants the exemption. Individual choices remain saved while the global setting is on. A green Skill name marks its individual exemption; the global setting does not affect this color. Click the Skill location above its shortcut to reveal it in the file manager.

Scripts still use the existing Shell tool. Windows PowerShell and macOS system zsh recognize one literal interpreter–script–arguments invocation, such as `python scripts/query.py --month 2026-09`; relative paths use the tool's `working_dir`. Supported interpreters are Python (including Windows `py -3`), Node, Ruby, Perl, Lua, sh/bash/zsh, and PowerShell with explicit `-File`. Only a small set of known interpreter options is accepted. Inline code, modules, preloads, wrappers such as uv, extra commands, pipes, redirects, dynamic expansions and interactive terminals retain normal approval. Other Shells do not receive automatic exemptions.

This does not enable command execution, selected tools or Skills, or expand project/subagent capabilities. The actual script must be inside a Skill available to the current invocation. New or edited scripts retain the setting; the global setting also covers newly available Skills. It is not a filesystem or network sandbox. Revocation affects calls that have not started; it does not cancel running processes.

## System Skills And Examples

The application supplies these system skills in `skills_system/` under application data:

| Skill | Purpose |
| --- | --- |
| `config` | Changes application settings and the avatar; requires Update configuration capability. |
| `skill-creator` | Creates or improves skills; requires file writing. Testing scripts also needs their runtimes. |
| `skill-installer` | Installs skills from local directories or Git repositories; requires file reading and writing. Remote installation also needs Git and network access. |

`skills_examples/` contains examples that are not loaded by default. Import them into **User** before use:

| Example | Purpose and main dependencies |
| --- | --- |
| `baidu-search` | Baidu search; Python 3, network access, and `BAIDU_SEARCH_API_KEY`. |
| `bailian-image` | Qwen/Wan image generation and editing from local files or URLs; Python 3.10+, network access, `BAILIAN_IMAGE_API_KEY`, and a model set by `BAILIAN_IMAGE_MODEL` or `--model`. |
| `exiftool-photo-search` | Searches photo metadata; Python 3.9+, ExifTool, and access to local photos. |
| `edge-tts-gen` | Generates speech files; Python 3, network access, file writing, and either the `edge_tts` package, the `edge-tts` command, or `uvx`. |
| `weather` | Weather queries; Python 3 and network access to wttr.in. |
| `ip-location` | Public IP and approximate network location; Python 3.8+ and network access to ipinfo.io. |
| `obsidian-cli` | Operates Obsidian vaults; Obsidian desktop with its command-line interface enabled and an available `obsidian` command. |

System and example directories are restored from bundled files at startup. Copy or import a skill into User or a project skill directory before customizing it.

## Prepare To Run

- Check the skill's environment requirements and its `SETUP.md`, if supplied. Selecting a skill does not install Python, Git, ExifTool, or other programs.
- Edit application `.env` in **Settings > Environment**. Commands receive these variables only when the relevant Agent's **.env** capability is enabled. Configure model names, accounts, and service access for the service you actually use.
- Explicit invocation loads the complete `SKILL.md` directly. Autonomous skill loading and reading supporting files still need a file-reading tool or command execution; scripts usually need **Command execution**. The model must also support tool use with **Tool use** enabled. Operations follow the current access mode.

## Write A Skill

Anas uses the [Agent Skills format](https://agentskills.io/specification). Each skill directory must contain an exact uppercase `SKILL.md` file and may include `scripts/`, `references/`, `assets/`, and other resources.

For example, `photo-search/SKILL.md`:

```markdown
---
name: photo-search
description: Search local photos by metadata; not for recognizing image contents.
compatibility: Requires Python 3 and ExifTool.
---

Describe the steps, arguments, and results here.
```

- `name` must match the directory name, use lowercase English letters, numbers, and single hyphens, and be at most 64 characters. It must not start or end with a hyphen.
- `description` is required, at most 1024 characters, and describes the purpose and applicable tasks.
- `compatibility` is optional; when present, it must be nonempty and at most 500 characters, describing environment dependencies.
- Resolve relative paths from the directory containing `SKILL.md`. User setup instructions may go in `SETUP.md`.
- Explicit invocation preserves the front matter and body without substituting placeholders such as `$ARGUMENTS` or `$0`. Describe how to act on the user’s request in the skill instructions. `SKILL.md` is limited to 1 MiB.

Model and user availability switches are stored in Anas configuration, not in skill files.
