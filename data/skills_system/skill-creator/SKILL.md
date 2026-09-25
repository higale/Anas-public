---
name: skill-creator
description: "Create or improve portable Agent Skills in a user-selected or host-configured Skill directory. Use when the user asks to create, design, scaffold, or revise a Skill. Do not use merely to install an existing Skill."
compatibility: "Requires filesystem read and write access to the target Skill directory. Testing helper scripts also requires their declared runtimes or commands."
---

# Create Agent Skills

Create the smallest Skill that reliably changes an agent's decisions or execution. Do not reproduce generic knowledge, unrelated policy, or scaffolding the requested workflow does not need.

## Choose the Destination

- When updating, use the existing target Skill. For a new Skill, honor the user's explicit destination; otherwise use the host-provided personal Skill root for reusable work or its project Skill root for project-specific work.
- Resolve roots from the host's runtime context or documented configuration. Do not infer a writable destination from this Skill's own installation path. Ask only when the destination is missing or multiple roots remain ambiguous.
- Treat application-managed bundled and example copies as managed resources, not authoring destinations. Modify bundled source only when the user is developing the host application itself.
- Use a separately maintained external collection as a destination only when the user selects it for this task.

Skill availability and source-root configuration belong to the host. Do not put host-specific availability fields in a Skill or change host configuration merely to create one.

## Design Before Writing

1. Clarify the requests that should activate the Skill and the similar requests it should exclude.
2. Inspect neighboring Skills and any existing target Skill. When updating, read the complete `SKILL.md` and every resource relevant to the change before editing.
3. Decide whether the workflow needs only instructions or also reusable `scripts/`, conditional `references/`, or output `assets/`. Do not create empty directories or placeholder files.
4. Keep the entrypoint concise. Move substantial conditional details into a focused reference and link it where the agent needs to read it.

## Skill Format

Every Skill is one directory containing `SKILL.md`:

```text
skill-name/
|-- SKILL.md
|-- scripts/       optional executable helpers
|-- references/    optional detailed guidance
`-- assets/        optional output resources
```

Use [standard Agent Skills front matter](https://agentskills.io/specification):

```yaml
---
name: skill-name
description: "What the Skill does, when it applies, and a useful exclusion."
compatibility: "Only the runtimes, commands, network access, credentials, or host features actually required."
---
```

- `name` must equal the directory name, contain 1–64 lowercase letters, digits, or hyphens, and neither start/end with a hyphen nor contain consecutive hyphens.
- `description` must be non-empty, at most 1024 characters, and precise enough for automatic selection.
- Add `compatibility` only when the Skill has dependencies. Keep it non-empty and at most 500 characters. Declaring a dependency does not install it.
- Preserve supported standard fields such as `license`, `allowed-tools`, or `metadata` when updating. Do not invent host-specific front-matter keys.
- Do not create `agents/openai.yaml`, plugin manifests, marketplace entries, READMEs, or changelogs unless the user explicitly requests a separate integration that needs them.

## Write Useful Instructions

- Assume the agent already understands ordinary reasoning and tool use. Document non-obvious workflow, constraints, decision criteria, failure handling, and output expectations.
- Preserve the user's requested scope and the Skill's existing language. Do not turn one example or past failure into a universal rule.
- Use relative paths for Skill resources. Make every referenced file discoverable from `SKILL.md`.
- Put deterministic repeated operations in scripts, and test changed scripts. Declare every required runtime, external command, network endpoint class, environment variable, or filesystem capability in `compatibility`.
- Keep credentials out of Skill files, arguments, examples, and logs. Name required environment variables without including their values.
- Remove obsolete instructions and resources in the same change.

## Validate and Finish

Before reporting completion:

1. Confirm the destination is exact and no unrelated Skill was overwritten.
2. Validate front matter, directory/name agreement, any host-provided file size limit, LF line endings, relative links, and the absence of unfinished placeholders.
3. Run each changed script with a safe help or representative test invocation and verify its observable output.
4. Re-read the completed Skill for activation precision, portability, dependency accuracy, and unnecessary content.
5. Report the final path, created resources, declared dependencies, and any validation limitation. Creation does not guarantee model visibility: discovery requires a host catalog refresh, an included source root, the active Skill selection, and resolution of any same-name conflict. Report any remaining activation step without silently changing availability settings.
