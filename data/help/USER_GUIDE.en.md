# Anas User Guide

Languages: [English](./USER_GUIDE.en.md) | [中文](./USER_GUIDE.zh-CN.md)

GitHub: [higale/Anas-public](https://github.com/higale/Anas-public) · License: [MIT](https://github.com/higale/Anas-public/blob/main/LICENSE)

Anas is a local desktop agent. Configure context, tools, skills, and subagents for each project. Settings, conversations, and memory stay on your computer; content needed for a task is sent to your configured model provider.

Choose Help from the lower-left menu to read this guide in the right workspace. Use Contents to jump to sections and links to open related guides. Closing, maximizing, or switching tabs does not interrupt chat.

## Quick Start

1. Add a provider in Settings > Model, including its address, model name, and key.
2. Select a model in the toolbar at the bottom of the message input box.
3. Type and send a message. Add attachments or select a project as needed.

## Projects And Capabilities

Enable **Customize capabilities** in the project editor to choose the project prompt, context, tools, skills, and subagents. Turning it off uses **Settings > Capabilities** and preserves your custom choices. These defaults are not master switches: customized projects can independently enable or disable capabilities. **Coding mode** separately changes the development workflow; it does not enable tools or increase access permissions.

- File read, File write, Memory, and Custom tools expand into individual choices. Use each group switch to select or clear all items. Saved selections that are deleted or unavailable can still be deselected.
- Every tool listed below requires a model that supports tool use with **Tool use** enabled. Context-only capabilities do not require tool use. Using a skill also requires tools for reading its instructions and performing its task.
- Capabilities select available tools; the conversation's access mode determines when an operation needs approval. Disabling File read, File write, or Network access removes those specific tools. Commands and MCP tools may still provide similar operations.
- Changes apply to tasks started afterward. Running tasks and tasks awaiting recovery retain their original selection.

The bulk actions at the top differ from individual switches:

- **Enable all** enables built-in capabilities and current custom tools, sets MCP to All tools, and switches Skills and Subagents to Use default. In project or default capability settings, it also clears Limit subagent capabilities. It does not start globally disabled MCP servers.
- **Disable all** turns capabilities off and clears built-in, custom, and MCP tool selections. Custom skill and subagent lists are retained.

In **Settings > Tools**, select a capability group, Custom tools, or MCP on the left to view its tools. Select a built-in or MCP tool name to inspect its parameters and full description.

### Profile

Supplies the assistant's name, role, instructions, and user information from **Settings > General**, so the Agent can follow your preferences. It has no separate tool and does not allow profile edits; tool-based edits require **Update configuration**. A subagent receives profile information according to its own capabilities and any project limits.

### Runtime Environment Information

Supplies the system, date, directory, command environment, and custom information selected in **Settings > Environment**. It provides context without installing programs or enabling command execution.

Bundled rg instructions require both **Command execution** and **Bundled commands** in environment settings. Turning runtime information off does not remove available programs. See [Runtime Environment And Variables](#runtime-environment-and-variables) for automatic detection of empty custom information.

### Project Information

Supplies the current project name, source folders, and path instructions, with no separate tool. Turning it off leaves the source folders in use as working directories and for access checks. The project prompt is controlled separately.

### .env

Controls whether commands and custom tools additionally receive variables from the application data directory's `.env` file. Edit the file in **Settings > Environment**.

It has no separate tool. Turning it off preserves inherited system environment variables and the `.env` file. It does not change model connections or shared MCP server configuration.

### Background Tools

Allows long-running built-in, custom, and MCP tool calls to continue in the background so the Agent can inspect, wait for, or cancel them. The following tools depend on one another and are enabled or disabled as a group, not selected individually. Turning this off makes new calls wait for completion; it does not cancel existing calls.

| Tool | Function |
| --- | --- |
| `read_call` | Inspect this conversation's background call status, progress, and terminal information. |
| `read_call_output` | Read ranges of output and results. |
| `wait_call` | Wait for a call to finish or for the wait to time out. |
| `cancel_call` | Request cancellation of a background call. |
| `write_call` | Send text or keys to an interactive terminal, or resize it. |

`write_call` requires **Command execution** or a selected interactive custom tool, with a terminal allocated at launch. A normal command cannot gain interactive input afterward. Background subagent tasks are controlled separately by **Subagents**.

Calls queue automatically when tools are busy; do not submit them again. Calls that take longer to wait or execute return an ID so the Agent can check their results later.

### Planning

Provides `write_todos` to create and update the current task's plan and completion status. Useful for multi-step work. A plan does not execute commands or edit files; those actions still require the relevant capabilities.

### Command Execution

Runs programs, scripts, searches, tests, and builds through the system command interpreter. The tool uses its actual program name, such as `zsh` on macOS or `pwsh` or `powershell` on Windows. A supported command interpreter must be available.

Bundled rg supports file and text searches without a separate installation. Script runtimes such as Python or Node.js must still be installed as needed. Follow-up terminal input requires **Background tools**; application `.env` variables are controlled separately by **.env**. Commands follow the conversation's access mode.

### Network Access

Provides `http_request` for HTTP/HTTPS requests, API calls, uploads, and downloads. The destination must be reachable and any required authentication must be supplied. This is not browser automation.

The tool can upload or download files independently of **File read** and **File write**, while still following file access approval rules. This switch does not control MCP connections or network access through commands.

### Update Configuration

Provides `update_config` to change supported application settings at your request, such as the theme, font size, and profile. It currently supports application settings fields, not arbitrary changes to project, model, or MCP configuration files.

It does not require **File write**. Each call requires approval in **Allow read-only** and **Strict approval** modes; **Full access** permits execution without that prompt.

### User Interaction

Provides `request_user_input` so the Agent can present questions with choices or a text answer. Useful for missing information, clarification, and decisions. You can cancel; ordinary questions may also time out.

It does not require **Background tools**. When disabled, the Agent can still ask in chat but cannot open this question dialog. Execution approval dialogs are controlled separately.

### File Read

Reads and inspects local files without requiring **Command execution**. The conversation's access mode determines whether reading outside project folders needs approval.

| Tool | Function |
| --- | --- |
| `read_file` | Read one UTF-8 text file, optionally by line range; binary contents are not supported. |
| `read_multiple_files` | Read several text files with individual results. |
| `view_image` | Send one local image to the current model for visual inspection. |
| `view_multiple_images` | Inspect up to 10 images in order, labeled by path, with per-file errors. |
| `list_directory` | List a directory's immediate children. |
| `directory_tree` | Inspect a directory tree in pages, up to 64 levels, without following symlinks. |
| `get_file_info` | Inspect type, byte size and timestamps; automatically include image dimensions/orientation or audio/video duration and tracks. |

Image tools require a vision-capable model with vision enabled in its configuration. They support PNG, JPEG and WebP without Command execution. Original images are sent without resizing or re-encoding; limits are 8 MiB per image and 16 MiB of image data per batch.

`get_file_info` reads file information without interpreting image contents. No extra media analysis program is required.

For text searches, use rg through **Command execution**. This group has no separate search tool.

### File Write

Creates, changes, moves, or deletes local files without requiring **Command execution**. Select only the tools needed. Enable a suitable reading tool when the Agent should inspect existing content first. Writes outside project folders usually need approval; see [Tools And Approval](#tools-and-approval).

| Tool | Function |
| --- | --- |
| `apply_patch` | Locate and edit content using surrounding text; supports a preview without writing. |
| `write_file` | Create a text file or explicitly replace the entire contents of an existing file. |
| `restore_file_edit` | Undo a complete recorded `apply_patch` or `write_file` operation. Recovery data must still be available; conflicting edits are not overwritten. |
| `get_file_edit_diff` | Inspect recorded Agent file changes, rather than Git working-tree changes. This tool itself is read-only. |
| `create_directory` | Create a directory and missing parents. |
| `move_file` | Move or rename files and directories. |
| `delete_file` | Delete files or directories. |

### Memory

Stores preferences, facts, and experience globally or for the current project. The following four items are independent choices.

| Item | Function and dependencies |
| --- | --- |
| Automatic recall | Finds records relevant to the current user message and supplies them to the model. It calls no tool and does not automatically save memories. |
| `read_memory` | Search or list global and current-project records. |
| `save_to_memory` | Create or update a record with global or current-project scope. |
| `forget_memory` | Delete a record by ID; search first if the ID is unknown. |

Select only **Automatic recall** to use relevant existing memories, or leave it off and enable search or save tools. Clearing selections does not delete records. Search, edit, or delete them in **Settings > Memory**.

### Custom Tools

Provides your configured programs or scripts as tools for the model. Prepare their programs, dependencies, and accounts. **Command execution** is not required; interactive tools also need **Background tools**. See [Manage Custom Tools](#manage-custom-tools) for setup and selection.

### MCP

For each server, select **All tools** or choose specific tools. All tools follows the server's current and future tool list. With it off, only explicitly selected tools are allowed. Selecting every current tool individually still excludes tools added later. Switching modes preserves the previous specific selection.

The server must be enabled in **Settings > MCP** and connected successfully. Selecting it in a project does not start a globally disabled server. Tool functions, parameters, required software, and accounts depend on the server. They do not require similarly named built-in file or network capabilities. Saved selections remain removable when unavailable.

### Subagents

Delegates independent tasks to other Agents for parallel investigation and division of work. The following tools depend on one another and are enabled or disabled as a group, not selected individually.

| Tool | Function |
| --- | --- |
| `start_subagent` | Start an allowed subagent. |
| `read_subagent` | Inspect a subtask's status and progress. |
| `wait_subagent` | Wait for progress, completion, or a request for approval. |
| `cancel_subagent` | Cancel a specified subtask. |

Configure subagents in **Settings > Subagents**. The capability list selects which subagents may be called. **Use default** selects globally default-enabled entries; Custom may include entries that are off by default. An empty list prevents launches. Turning this capability off preserves the list. It does not require **Background tools**.

Subagents keep their own capability settings rather than inheriting Settings > Capabilities. Subagents may delegate further, but their choices cannot exceed the original project's allowed set. **Limit subagent capabilities** separately constrains context, tools, and skills at every level: when selected, only capabilities allowed by both the project and the subagent remain available. Otherwise, the subagent uses its own configuration. It receives the delegated task, not the complete parent conversation automatically.

### Skills

Supplies the names, purposes, and instruction paths of available skills, or lets you invoke them with `/name`. Skills are instructions, not separate callable tools, and do not grant file, command, or network capabilities.

The Skills switch enables or disables the capability without selecting every skill. Turning it off preserves the default/custom mode and individual choices.

**Use default** follows global availability. Custom mode independently selects user shortcuts and model availability, including skills off by default. Subagents configure model availability only.

Explicit invocation sends the unchanged skill file and its source path, keeping the user request separate; expand the skill entry to inspect the submitted text. Autonomous loading and reading supporting files require `read_file`, `read_multiple_files`, or **Command execution** capable of reading files. Scripts also need their command interpreter, runtime, tools, and accounts. Selecting a skill does not satisfy those dependencies automatically. Manage global sources and availability in **Settings > Skills**; put project skills in `.agents/skills/` under source folders. See the [Skills Guide](./AGENT_SKILLS.en.md) for importing, name conflicts, and authoring, and each skill's `SETUP.md`, if supplied, for installation requirements.

## Models

OpenAI-compatible and Anthropic-compatible services are supported. Manage models in Settings > Model and switch between them below the message input.

Set Vision and Tool use to match the model's actual capabilities. Turning Tool use off prevents calls to built-in tools, MCP tools, and subagents. Profile, runtime information, project information, skill listings, and automatic memory recall still follow capability settings; saved choices are unchanged.

## Tools And Approval

Project Customize capabilities selects available tools; the model's Tool use setting determines whether it can call them. See [Projects And Capabilities](#projects-and-capabilities) for functions and dependencies.

Conversations offer three access modes:

- **Allow read-only**: the default. Files outside projects can be read directly; external writes and commands that cannot be verified as supported read-only operations require confirmation.
- **Strict approval**: external reads also require confirmation. Only supported read-only commands targeting project files run without a prompt.
- **Full access**: skips pre-execution approval. Revoke it from the conversation's More menu; operations already started are not interrupted.

An external operation with an uncertain outcome still requires confirmation before retrying. A conversation awaiting confirmation cannot accept messages, history edits, regeneration, or compression. Other conversations remain available.

Subagents can work in the background. Select a subagent status entry to view its task, tool calls, and result. Unfinished subagents, including those awaiting approval, are cancelled when the main task ends.

## Runtime Environment And Variables

Bundled commands in Runtime Environment is enabled by default and gives the Agent instructions for bundled rg. Detect System Environment updates information about system commands; bundled rg needs no detection.

Custom Environment Information is enabled by default. If selected and empty at startup, it is filled by background detection without blocking startup. Existing content is preserved; deselecting it during detection discards the result.

Edit the application `.env` in Settings > Environment to prepare variables for commands, custom tools, and skill scripts. The relevant Agent's .env capability determines whether they receive these variables.

## Manage Custom Tools

Select **Custom tools** in **Settings > Tools** to add, edit, delete, reorder, import, and refresh tools. Double-click a tool to edit it; Open locates its directory. Deleting moves the entire tool directory to the trash.

Each directory contains `TOOL.json` and scripts or resources. User tools live in the application data directory's `tools/`; project tools live in `.agents/tools/` under source folders and are available only to that project. The editor configures names, descriptions, JSON parameter rules, and commands; it does not generate scripts or install dependencies.

**Import tools** accepts multiple directories and opens the bundled examples by default. The examples provide text reading, file SHA-256, and JSON formatting, all requiring Python 3. Imports copy into user tools without overwriting existing tools.

After adding or importing a tool, select it under **Custom tools** in default, project, or subagent capabilities. Subagents use independent selections, may enable **Use current project tools**, and follow project limits. For duplicate names, the first valid, enabled entry wins: project source folders in order, then user tools.

Commands run in the tool directory, where relative paths resolve, for example `scripts/run.py {{args}}`. A `.py` entry automatically selects an available Python 3; an explicit interpreter is also supported. A standalone `{{args}}` receives complete JSON; `{{tool_dir}}` supplies the absolute tool directory. A command starts one program with fixed arguments, without pipelines or redirection. Standard output is returned to the model; pass large inputs through files.

**Interactive terminal (PTY)** supports programs needing follow-up input and requires **Background tools**, without requiring **Command execution**. Leave it off for ordinary text results. A blank timeout means no limit; positive seconds set an execution limit, including time spent waiting for input. Cancellation or timeout terminates the process tree but does not undo changes already made.

## MCP Setup

Add and edit servers in Settings > MCP using stdio, HTTP, or SSE. The server must be enabled and connected, the model must have Tool use enabled, and the project must allow the relevant tools.

Disabled servers remain editable; editing a running server stops it first. The tool catalog in Settings > Tools groups tools by server. Projects can further select available tools.

## Attachments And Voice Input

Sending an attachment saves a local copy, so moving or deleting the original does not prevent viewing it. Attachments apply to the current turn by default; pin one to keep using it in later turns of the same conversation.

Text extraction supports text files, PDFs, and docx files. Images require a model with Vision enabled; text-only models cannot receive or view image content. Unsupported files are marked as not sent to the model.

The microphone button invokes Windows voice typing or macOS Dictation. The system controls starting, stopping, and recognition language. On macOS, enable Dictation in System Settings > Keyboard > Dictation first. Confirm that system dictation has started, then review the recognized text before sending. Anas does not record or save audio.

Spoken replies connect directly to Microsoft Edge online speech services and require internet access. Text to be read is sent to Microsoft. Choose the voice and speed in settings. Audio is buffered only in memory; stopping playback or switching conversations cancels unfinished synthesis and releases queued audio.

## Conversations And Context

The Agent page has projects and conversations on the left, chat in the center, and a right workspace for Help, subagents, and File changes. Drag the divider to resize or maximize the right pane; narrow windows use a drawer. Collapsing the pane or switching conversations preserves tabs and view positions. Closing a subagent tab does not stop its task.

In **File changes**, choose a comparison scope and file to view a read-only diff. The top toolbar switches inline/side-by-side views and folds unchanged regions. Git comparisons support the working tree, staging area, branches, tags, and commits. Missing history, binary files, and files over 1 MB show why their diff is unavailable.

**Run changes** shows recorded file edits in the current conversation, including subagent edits, and also works outside Git repositories. By default, each file compares its contents before the turn's first edit with its last recorded result. **Compare with current file** uses current disk content instead, which may include later edits. The message's **Run changes** shortcut opens that turn directly.

Choose **Review selected scope** to have the Agent review the diff. The submitted message shows the actual review instructions and diff content.

Conversations are saved automatically. The sidebar counts user turns, and earlier messages can be loaded as needed. Task progress shows tool calls, approval requests, failure reasons, and elapsed time. New output scrolls into view automatically. Scroll up or expand details to pause; scroll back down or click Scroll to bottom to resume.

Long conversations are compressed automatically. You can also compress manually using the context indicator beside the input. It shows estimated usage by category; reserved output space is displayed separately and is not counted as used context.

Preview request in the project editor shows the context and tools that would be supplied for the current project.

## Local Data And Backups

The default data directory is `~/.gale<program-name>/`; standard Anas uses `~/.galeAnas/`. Copying and renaming the application gives it a separate data directory.

You can also specify a directory at launch, for example `Anas.exe "D:\Anas Data\Research"` or `--data-dir <path>`. Relative paths use the launch directory; filesystem roots are not allowed.

ZIP backups include user tools and skills. Back up project source folders and externally referenced skills separately. Backups exclude runtime logs, temporary files, developer request traces, and interface caches and sign-in state. Data cleanup in Settings > General removes completed, unpinned conversations. Pinned, running, and approval-pending conversations are kept.

## Troubleshooting

Settings > Dev provides developer tools, logs, and Start in console. Console startup preserves the data directory and restarts the app in a system terminal to show startup and runtime output.

- **Model request fails**: check the service address, model name, key, and network connection.
- **Skill fails**: check its instructions, environment variables, and required programs.
- **MCP tools are missing**: confirm that the server is enabled and connected, the model has Tool use enabled, and the project allows the tools.
- **Operation awaits confirmation**: allow or reject it as prompted. If the outcome is uncertain, retry only when repeating the operation is acceptable.

### Startup Recovery

If startup data cannot load, the recovery page lists affected files. View error details, open logs, and choose:

- **Repair**: corrects identifiable invalid fields with defaults while keeping valid settings. Data that cannot be reliably repaired is left unchanged.
- **Reset**: restores the selected configuration to defaults. **Resetting `projects.json` also deletes every project's conversations, messages, execution records, task recovery information, and memory**. Other settings, skills, project source files, and attachment files are kept.

Before changes, original data is saved beside the data directory under `Anas-Recovery/timestamp-random-suffix/`. If that fails, no changes are made. Restart after recovery.
