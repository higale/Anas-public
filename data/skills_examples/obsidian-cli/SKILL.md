---
name: obsidian-cli
description: "Operate Obsidian vaults with the Obsidian CLI: read, create, search, and manage notes, tasks, and properties, or develop and debug plugins and themes. Use when the user asks to work with a vault or inspect, reload, test, or debug an Obsidian extension."
compatibility: "Requires Obsidian desktop with its command-line interface enabled and the obsidian command available to the host."
---

# Obsidian CLI

Invoke the registered `obsidian` CLI with the host's available command executor. It connects to Obsidian and may launch the app when needed.

Run `obsidian help` or `obsidian help <command>` before an unfamiliar operation; CLI help is the source of truth for the installed version. The [official CLI reference](https://help.obsidian.md/cli) documents installation and commands.

## Command Syntax

- Write parameters as `key=value`; quote values containing spaces.
- Write boolean flags without a value.
- Use `\n` and `\t` inside multiline content.
- Use `vault=<name-or-id>` before the command to target a vault. Otherwise the current-directory vault or active vault is used.
- Use `file=<name>` for wikilink-style resolution or `path=<vault-relative-path>` for an exact path.

```bash
obsidian create name="My Note" content="Hello world"
obsidian vault="My Vault" search query="test"
```

## Common Commands

```bash
obsidian read file="My Note"
obsidian create name="New Note" content="# Hello" template="Template"
obsidian append file="My Note" content="New line"
obsidian search query="search term" limit=10
obsidian daily:read
obsidian daily:append content="- [ ] New task"
obsidian property:set name="status" value="done" file="My Note"
obsidian tasks daily todo
obsidian tags sort=count counts
obsidian backlinks file="My Note"
```

Use `total` when the command's help lists that flag and only a count is needed. Add `--copy` when the user explicitly wants clipboard output.

## Safety and Errors

Use a read-only command first when the vault or target is uncertain. Mutate only the content the user asked to change. Confirm the exact target before permanent deletion, overwrite, publish, or unpublish operations; prefer the default trash behavior over `delete permanent`.

If `obsidian` is unavailable, ask the user to install a current Obsidian desktop build, enable the command-line interface in **Settings > General**, and restart the terminal. On command failure, report the relevant error and do not claim success.

## Plugin Development

After changing a plugin or theme, reload it, inspect errors, verify the UI, and check console output. Fix failures and repeat the cycle.

```bash
obsidian plugin:reload id=my-plugin
obsidian dev:errors
obsidian dev:screenshot path=screenshot.png
obsidian dev:dom selector=".workspace-leaf" text
obsidian dev:console level=error
obsidian eval code="app.vault.getFiles().length"
```
