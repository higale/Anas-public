import { writeJsonFileAtomic } from './atomicJson'
import { mirrorBundledDirectories } from './bundledDirectories'
import { getAppConfigSnapshot } from './config/appConfig'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, cp, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { SKILL_ROOT_DISPLAY_NAME_MAX_LENGTH, SKILL_SHORTCUT_ALIAS_MAX_LENGTH, SKILL_SHORTCUT_ALIAS_PATTERN } from '@shared/types'
import type {
  SkillAvailabilityUpdate,
  SkillFileNode,
  SkillFilePreview,
  SkillImportError,
  SkillInvocationResult,
  SkillLoadIssue,
  SkillRootKind,
  SkillRootSummary,
  SkillRootUpdate,
  SkillSnapshot,
  SkillSummary
} from '@shared/types'
import {
  getBundledConfigFile,
  getBundledDataDir,
  getConfigFile,
  getSkillExamplesDir,
  getSkillsDir,
  getSystemSkillsDir,
  skillsConfigFileName
} from './config/dataDir'
import { getProject } from './projectStore'
import { defaultCapabilities, effectiveProjectCapabilities, type SkillSelection } from '@shared/agentCapabilities'
import { isSameOrInsideDirectory, samePath } from './pathContainment'

interface ParsedSkill {
  name: string
  description: string
  compatibility?: string
  body: string
}

interface ExternalSkillDirectory {
  id: string
  name: string
  shortcut_alias: string
  path: string
}

interface StoredAvailability {
  model_available: boolean
  user_available: boolean
}

interface SkillsConfigFile {
  script_auto_approve: boolean
  script_auto_approve_skills: string[]
  external_directories: ExternalSkillDirectory[]
  availability: Record<string, StoredAvailability>
}

interface LoadedSkill {
  summary: SkillSummary
}

interface RootScan {
  root: SkillRootSummary
  skills: LoadedSkill[]
}

interface SkillDirectory {
  name: string
  path: string
  linked: boolean
  linkTarget?: string
  resolvedPath?: string
}

const ignoredDirectories = new Set(['.git', '.svn', '__pycache__', 'node_modules', '.backup', '__history', '__recovery'])
const binaryExtensions = new Set(['.7z', '.avi', '.bin', '.bmp', '.db', '.dmg', '.doc', '.docx', '.gif', '.gz', '.ico', '.jpeg', '.jpg', '.mov', '.mp3', '.mp4', '.pdf', '.png', '.ppt', '.pptx', '.sqlite', '.tar', '.tgz', '.wav', '.webp', '.xls', '.xlsx', '.zip'])
const maxPreviewBytes = 1024 * 1024
const maxTreeDepth = 24
const maxSkillDirectoriesPerRoot = 2048
const maxTreeEntriesPerDirectory = 4096
const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const reservedAliases = new Set(['system', 'user', 'project'])
let initialization: Promise<void> | undefined
let configMutationTail: Promise<void> = Promise.resolve()
let skillImportTail: Promise<void> = Promise.resolve()

type SkillImportFailureCode = 'already_exists' | 'invalid_directory' | 'invalid_skill'

class SkillImportFailure extends Error {
  constructor(
    readonly code: SkillImportFailureCode,
    message: string,
    readonly skillName?: string,
    readonly issue?: SkillLoadIssue
  ) {
    super(message)
    this.name = 'SkillImportFailure'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (reason) {
    if ((reason as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw reason
  }
}

async function entryExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (reason) {
    if ((reason as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw reason
  }
}

function expandHome(path: string): string {
  const trimmed = path.trim()
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return join(homedir(), trimmed.slice(2))
  return trimmed
}

function externalPath(path: string): string {
  return resolve(expandHome(path))
}

function normalizeRootDisplayName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!name || name.length > SKILL_ROOT_DISPLAY_NAME_MAX_LENGTH || /[\r\n\t]/.test(name)) {
    throw new Error('Skill directory display name is invalid.')
  }
  return name
}

function normalizeShortcutAlias(value: unknown): string {
  const alias = typeof value === 'string' ? value.trim() : ''
  if (alias.length > SKILL_SHORTCUT_ALIAS_MAX_LENGTH || !SKILL_SHORTCUT_ALIAS_PATTERN.test(alias)) {
    throw new Error('Skill directory shortcut alias is invalid.')
  }
  return alias
}

function normalizeExternalDirectory(value: unknown): ExternalSkillDirectory {
  if (!isRecord(value)) throw new Error('External Skill directory must be an object.')
  const id = typeof value.id === 'string' ? value.id.trim() : ''
  const name = normalizeRootDisplayName(value.name)
  const shortcutAlias = normalizeShortcutAlias(value.shortcut_alias)
  const path = typeof value.path === 'string' ? value.path.trim() : ''
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id) || id === 'system' || id === 'user' || id.startsWith('project-') || !path) {
    throw new Error('External Skill directory configuration is invalid.')
  }
  return { id, name, shortcut_alias: shortcutAlias, path }
}

export function normalizeSkillsConfig(value: unknown): SkillsConfigFile {
  if (!isRecord(value) || !Array.isArray(value.external_directories) || !isRecord(value.availability)) {
    throw new Error('Skills configuration is invalid.')
  }
  const directories = value.external_directories.map(normalizeExternalDirectory)
  const ids = new Set<string>()
  const aliases = new Set(reservedAliases)
  for (const directory of directories) {
    if (ids.has(directory.id)) throw new Error(`Duplicate external Skill directory ID: ${directory.id}`)
    if (aliases.has(directory.shortcut_alias)) throw new Error(`Duplicate Skill shortcut alias: ${directory.shortcut_alias}`)
    ids.add(directory.id)
    aliases.add(directory.shortcut_alias)
  }
  const availability: Record<string, StoredAvailability> = {}
  for (const [id, raw] of Object.entries(value.availability)) {
    if (!isRecord(raw) || typeof raw.model_available !== 'boolean' || typeof raw.user_available !== 'boolean') {
      throw new Error(`Skill availability is invalid: ${id}`)
    }
    availability[id] = { model_available: raw.model_available, user_available: raw.user_available }
  }
  if (value.script_auto_approve !== undefined && typeof value.script_auto_approve !== 'boolean') throw new Error('Skill script approval setting must be a boolean.')
  const scriptSkills = value.script_auto_approve_skills ?? []
  if (!Array.isArray(scriptSkills) || scriptSkills.some(id => typeof id !== 'string' || !id.trim())) throw new Error('Skill script approval entries must be Skill IDs.')
  return { external_directories: directories, availability, script_auto_approve: value.script_auto_approve === true,
    script_auto_approve_skills: [...new Set(scriptSkills)] }
}

async function ensureSkillsConfig(): Promise<void> {
  const target = getConfigFile(skillsConfigFileName)
  if (await pathExists(target)) return
  await mkdir(dirname(target), { recursive: true })
  await copyFile(getBundledConfigFile(skillsConfigFileName), target)
}

async function readSkillsConfig(): Promise<SkillsConfigFile> {
  await initializeSkillsStore()
  return normalizeSkillsConfig(JSON.parse(await readFile(getConfigFile(skillsConfigFileName), 'utf8')))
}

export async function validateSkillsConfigFile(path: string): Promise<void> {
  normalizeSkillsConfig(JSON.parse(await readFile(path, 'utf8')))
}

async function writeSkillsConfig(config: SkillsConfigFile): Promise<void> {
  await writeJsonFileAtomic(getConfigFile(skillsConfigFileName), normalizeSkillsConfig(config))
}

function mutateSkillsConfig<T>(mutation: (config: SkillsConfigFile) => Promise<T>): Promise<T> {
  const result = configMutationTail.then(async () => mutation(await readSkillsConfig()))
  configMutationTail = result.then(() => undefined, () => undefined)
  return result
}

function inspectSkillText(content: string, expectedName: string): ParsedSkill | SkillLoadIssue {
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  if (lines[0]?.trim() !== '---') return { code: 'missing_frontmatter' }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (end < 0) return { code: 'missing_frontmatter', detail: 'The closing front matter delimiter is missing.' }
  let frontmatter: unknown
  try {
    frontmatter = parseYaml(lines.slice(1, end).join('\n'))
  } catch (reason) {
    return { code: 'yaml_parse_failed', detail: reason instanceof Error ? reason.message : String(reason) }
  }
  if (!isRecord(frontmatter)) return { code: 'missing_frontmatter' }
  const name = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : ''
  const description = typeof frontmatter.description === 'string' ? frontmatter.description.trim() : ''
  if (!name) return { code: 'missing_name' }
  if (!skillNamePattern.test(name) || name.length > 64) return { code: 'invalid_name', name }
  if (name !== expectedName) return { code: 'name_mismatch', name, expected: expectedName }
  if (!description) return { code: 'missing_description' }
  if (description.length > 1024) return { code: 'description_too_long' }
  const compatibility = frontmatter.compatibility
  if (compatibility !== undefined && (typeof compatibility !== 'string' || !compatibility.trim() || compatibility.length > 500)) {
    return { code: 'invalid_frontmatter_field', name: 'compatibility' }
  }
  return {
    name,
    description,
    ...(typeof compatibility === 'string' ? { compatibility: compatibility.trim() } : {}),
    body: lines.slice(end + 1).join('\n').replace(/^\n+|\n+$/g, '')
  }
}

export function toSkillImportError(reason: unknown): SkillImportError {
  if (reason instanceof SkillImportFailure) {
    if (reason.code === 'already_exists' && reason.skillName) {
      return { code: 'already_exists', name: reason.skillName }
    }
    if (reason.code === 'invalid_skill' && reason.issue) {
      return { code: 'invalid_skill', issue: reason.issue }
    }
    if (reason.code === 'invalid_directory') return { code: 'invalid_directory' }
  }
  const code = (reason as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOENT' || code === 'ENOTDIR') return { code: 'invalid_directory' }
  return { code: 'failed' }
}

async function validateBundledSkill(dirPath: string, expectedName: string): Promise<void> {
  const info = await lstat(dirPath)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Bundled Skill must be a regular directory: ${dirPath}`)
  const parsed = inspectSkillText(await readBoundedTextFile(join(dirPath, 'SKILL.md')), expectedName)
  if ('code' in parsed) throw new Error(`Invalid bundled Skill ${expectedName}: ${parsed.code}`)
}

async function mirrorBundledSkills(sourceName: 'skills_system' | 'skills_examples', target: string): Promise<void> {
  await mirrorBundledDirectories(join(getBundledDataDir(), sourceName), target, validateBundledSkill)
}

export async function initializeSkillsStore(): Promise<void> {
  if (!initialization) {
    initialization = Promise.allSettled([
      ensureSkillsConfig(),
      mkdir(getSkillsDir(), { recursive: true }),
      mirrorBundledSkills('skills_system', getSystemSkillsDir()),
      mirrorBundledSkills('skills_examples', getSkillExamplesDir())
    ]).then((results) => {
      // A failed initialization must retain ownership of every started mirror
      // until it settles, so a retry cannot overwrite its staging directories.
      const failure = results.find((result) => result.status === 'rejected')
      if (failure) throw failure.reason
    })
    initialization.catch(() => { initialization = undefined })
  }
  await initialization
}

export async function validateRestoredSkillsDirectory(skillsDir: string): Promise<void> {
  if (!(await pathExists(skillsDir))) return
  const info = await lstat(skillsDir)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Restored Skills path must be a regular directory.')
  for (const entry of await readdir(skillsDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    if (!entry.isDirectory()) throw new Error(`Restored Skills contains a non-directory entry: ${entry.name}`)
    const parsed = inspectSkillText(await readFile(join(skillsDir, entry.name, 'SKILL.md'), 'utf8'), entry.name)
    if ('code' in parsed) throw new Error(`Invalid skill ${entry.name}: ${parsed.code}`)
  }
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'skills'
}

function projectRootId(path: string): string {
  return `project-${createHash('sha256').update(resolve(path)).digest('hex').slice(0, 16)}`
}

async function resolveSkillRoots(projectId?: string, sourceFolders?: string[]): Promise<SkillRootSummary[]> {
  const config = await readSkillsConfig()
  const roots: SkillRootSummary[] = [
    { id: 'system', kind: 'system', name: 'System', shortcutAlias: 'system', path: getSystemSkillsDir(), removable: false, available: true },
    { id: 'user', kind: 'user', name: 'User', shortcutAlias: 'user', path: getSkillsDir(), removable: false, available: true }
  ]
  let folders = sourceFolders
  if (folders === undefined && projectId) {
    const project = await getProject(projectId)
    if (project.kind === 'workspace') folders = project.sourceFolders
  }
  if (folders) {
    const used = new Set([
      ...roots.map((root) => root.shortcutAlias),
      ...config.external_directories.map((directory) => directory.shortcut_alias)
    ])
    folders.forEach((folder, index) => {
      const base = index === 0 ? 'project' : `project-${slug(basename(folder))}`
      let alias = base
      let suffix = 2
      while (used.has(alias)) alias = `${base}-${suffix++}`
      used.add(alias)
      roots.push({
        id: projectRootId(folder),
        kind: 'project',
        name: basename(folder),
        shortcutAlias: alias,
        path: join(folder, '.agents', 'skills'),
        removable: false,
        available: true
      })
    })
  }
  roots.push(...config.external_directories.map((directory) => ({
    id: directory.id,
    kind: 'external' as const,
    name: directory.name,
    shortcutAlias: directory.shortcut_alias,
    path: externalPath(directory.path),
    removable: true,
    available: true
  })))
  return roots
}

function invalidSkill(root: SkillRootSummary, directory: SkillDirectory, issue: SkillLoadIssue, config: SkillsConfigFile): LoadedSkill {
  const name = directory.name
  const id = `${root.id}:${name}`
  const availability = config.availability[id]
  return {
    summary: {
      id,
      rootId: root.id,
      name,
      description: '',
      modelAvailable: availability?.model_available ?? true,
      userAvailable: availability?.user_available ?? true,
      scriptAutoApprove: config.script_auto_approve_skills.includes(id),
      dirPath: directory.path,
      linked: directory.linked,
      ...(directory.linkTarget ? { linkTarget: directory.linkTarget } : {}),
      ...(directory.resolvedPath ? { resolvedDirPath: directory.resolvedPath } : {}),
      relativePath: name,
      source: root.kind,
      rootName: root.name,
      shortcutAlias: root.shortcutAlias,
      loadError: issue
    }
  }
}

async function skillDirectories(rootPath: string): Promise<SkillDirectory[]> {
  const entries = await readdir(rootPath, { withFileTypes: true })
  if (entries.length > maxSkillDirectoriesPerRoot) {
    throw new Error(`Skill root contains more than ${maxSkillDirectoriesPerRoot} entries.`)
  }
  const result: SkillDirectory[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith('.')) continue
    const path = join(rootPath, entry.name)
    if (entry.isDirectory()) result.push({ name: entry.name, path, linked: false, resolvedPath: await realpath(path).catch(() => undefined) })
    else if (entry.isSymbolicLink()) {
      const linkTarget = await readlink(path)
      const target = await stat(path).catch(() => undefined)
      if (target?.isDirectory()) {
        result.push({ name: entry.name, path, linked: true, linkTarget, resolvedPath: await realpath(path) })
      } else if (!target) {
        result.push({ name: entry.name, path, linked: true, linkTarget })
      }
    }
  }
  return result
}

async function scanRoot(root: SkillRootSummary, config: SkillsConfigFile): Promise<RootScan> {
  let directories
  try {
    const info = await stat(root.path)
    if (!info.isDirectory()) return { root: { ...root, available: false, issue: 'not_directory' }, skills: [] }
    directories = await skillDirectories(root.path)
  } catch (reason) {
    const code = (reason as NodeJS.ErrnoException).code
    return { root: { ...root, available: false, issue: code === 'ENOENT' ? 'not_found' : 'unreadable' }, skills: [] }
  }
  const skills: LoadedSkill[] = []
  for (const directory of directories) {
    if (directory.linked && !directory.resolvedPath) {
      skills.push(invalidSkill(root, directory, { code: 'missing_skill_file', detail: 'The linked Skill directory target is unavailable.' }, config))
      continue
    }
    let content: string | undefined
    try {
      content = await readBoundedTextFile(join(directory.path, 'SKILL.md'))
    } catch (reason) {
      const error = reason as NodeJS.ErrnoException
      if (error.code !== 'ENOENT') {
        skills.push(invalidSkill(root, directory, { code: 'unreadable_skill_file', detail: error.message }, config))
        continue
      }
    }
    if (content === undefined) {
      skills.push(invalidSkill(root, directory, { code: 'missing_skill_file' }, config))
      continue
    }
    const parsed = inspectSkillText(content, directory.name)
    if ('code' in parsed) {
      skills.push(invalidSkill(root, directory, parsed, config))
      continue
    }
    const id = `${root.id}:${directory.name}`
    const availability = config.availability[id]
    skills.push({
      summary: {
        id,
        rootId: root.id,
        name: parsed.name,
        description: parsed.description,
        ...(parsed.compatibility ? { compatibility: parsed.compatibility } : {}),
        modelAvailable: availability?.model_available ?? true,
        userAvailable: availability?.user_available ?? true,
        scriptAutoApprove: config.script_auto_approve_skills.includes(id),
        dirPath: directory.path,
        linked: directory.linked,
        ...(directory.linkTarget ? { linkTarget: directory.linkTarget } : {}),
        ...(directory.resolvedPath ? { resolvedDirPath: directory.resolvedPath } : {}),
        relativePath: directory.name,
        source: root.kind,
        rootName: root.name,
        shortcutAlias: root.shortcutAlias
      }
    })
  }
  return { root, skills }
}

function precedence(kind: SkillRootKind): number {
  return kind === 'project' ? 0 : kind === 'user' ? 1 : kind === 'external' ? 2 : 3
}

function resolveConflicts(scans: RootScan[]): LoadedSkill[] {
  const rootOrder = new Map(scans.map((scan, index) => [scan.root.id, index]))
  const skills = scans.flatMap((scan) => scan.skills).sort((left, right) => (
    precedence(left.summary.source) - precedence(right.summary.source)
    || (rootOrder.get(left.summary.rootId) ?? 0) - (rootOrder.get(right.summary.rootId) ?? 0)
    || left.summary.name.localeCompare(right.summary.name)
  ))
  const modelWinners = new Map<string, LoadedSkill>()
  const userWinners = new Map<string, LoadedSkill>()
  for (const skill of skills) {
    if (skill.summary.loadError) continue
    const name = skill.summary.name.toLowerCase()
    if (skill.summary.modelAvailable && !modelWinners.has(name)) modelWinners.set(name, skill)
    if (skill.summary.userAvailable && !userWinners.has(name)) userWinners.set(name, skill)
  }
  return skills.map((skill) => {
    const name = skill.summary.name.toLowerCase()
    const modelWinner = modelWinners.get(name)
    const userWinner = userWinners.get(name)
    return {
      ...skill,
      summary: {
        ...skill.summary,
        ...(!skill.summary.loadError && skill.summary.userAvailable
          ? { shortcut: userWinner?.summary.id === skill.summary.id ? `/${skill.summary.name}` : `/${skill.summary.name}@${skill.summary.shortcutAlias}` }
          : {}),
        ...(skill.summary.modelAvailable && modelWinner && modelWinner.summary.id !== skill.summary.id ? { modelShadowedBy: modelWinner.summary.rootName } : {}),
        ...(skill.summary.userAvailable && userWinner && userWinner.summary.id !== skill.summary.id ? { userShadowedBy: userWinner.summary.rootName } : {})
      }
    }
  })
}

async function loadCatalog(projectId?: string, selection?: SkillSelection, sourceFolders?: string[]): Promise<{ roots: SkillRootSummary[]; skills: LoadedSkill[]; scriptAutoApprove: boolean }> {
  const [roots, config] = await Promise.all([resolveSkillRoots(projectId, sourceFolders), readSkillsConfig()])
  const scans = await Promise.all(roots.map((root) => scanRoot(root, config)))
  if (selection) {
    for (const scan of scans) for (const skill of scan.skills) {
      const entry = selection.entries.find((entry) => entry.id === skill.summary.id)
      skill.summary.modelAvailable = selection.enabled && (selection.mode === 'default' ? skill.summary.modelAvailable : Boolean(entry?.model))
      skill.summary.userAvailable = selection.enabled && (selection.mode === 'default' ? skill.summary.userAvailable : Boolean(entry?.shortcut))
    }
  }
  return { roots: scans.map((scan) => scan.root), skills: resolveConflicts(scans), scriptAutoApprove: config.script_auto_approve }
}

export async function listSkillSnapshot(projectId?: string, sourceFolders?: string[]): Promise<SkillSnapshot> {
  if (sourceFolders !== undefined && (!Array.isArray(sourceFolders) || sourceFolders.some((folder) => typeof folder !== 'string' || !isAbsolute(folder)))) {
    throw new Error('Skill source folders must be absolute directory paths.')
  }
  const folders = sourceFolders === undefined ? undefined : [...new Set(sourceFolders.map((folder) => resolve(folder)))]
  const catalog = await loadCatalog(projectId, undefined, folders)
  return { ...(projectId ? { projectId } : {}), roots: catalog.roots, skills: catalog.skills.map((skill) => skill.summary), scriptAutoApprove: catalog.scriptAutoApprove }
}

export async function updateSkillScriptApproval(projectId: string | undefined, skillId: string | undefined, enabled: boolean): Promise<SkillSnapshot> {
  if (typeof enabled !== 'boolean') throw new Error('Skill script approval setting must be a boolean.')
  if (skillId !== undefined) await findSkill(projectId, skillId)
  return mutateSkillsConfig(async config => {
    if (skillId === undefined) config.script_auto_approve = enabled
    else config.script_auto_approve_skills = [...new Set([
      ...config.script_auto_approve_skills.filter(id => id !== skillId), ...(enabled ? [skillId] : [])
    ])]
    await writeSkillsConfig(config)
    return listSkillSnapshot(projectId)
  })
}

export interface SkillScriptScope {
  projectId?: string
  sourceFolders?: string[]
  selection: SkillSelection
  allowUserInvocation: boolean
}

export interface SkillScriptInvocation { name: string; sourceAlias?: string }

/** A current exemption, not execution permission or a persisted capability. */
export async function findSkillScriptExemption(scriptPath: string, scope: SkillScriptScope, invocation?: SkillScriptInvocation) {
  if (!scope.selection.enabled || !isAbsolute(scriptPath)) return undefined
  const catalog = await loadCatalog(scope.projectId, scope.selection, scope.sourceFolders)
  const skills = catalog.skills.map(item => item.summary).filter(skill => !skill.loadError)
  const explicit = scope.allowUserInvocation && invocation ? skills.find(skill => skill.userAvailable
    && skill.name.toLowerCase() === invocation.name.toLowerCase()
    && (!invocation.sourceAlias || skill.shortcutAlias === invocation.sourceAlias)) : undefined
  const script = await realpath(scriptPath)
  if (!(await stat(script)).isFile()) return undefined
  for (const skill of skills) {
    if (!(catalog.scriptAutoApprove || skill.scriptAutoApprove)
      || !(skill.modelAvailable && !skill.modelShadowedBy || skill.id === explicit?.id)) continue
    const root = await realpath(skill.dirPath)
    if (!samePath(root, script) && isSameOrInsideDirectory(root, script)) return { skillId: skill.id, root, script }
  }
  return undefined
}

async function findSkill(projectId: string | undefined, skillId: string): Promise<LoadedSkill> {
  const skill = (await loadCatalog(projectId)).skills.find((candidate) => candidate.summary.id === skillId)
  if (!skill) throw new Error(`Skill was not found: ${skillId}`)
  return skill
}

function safeRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!normalized || isAbsolute(value) || normalized.split('/').some((part) => part === '..' || part === '')) {
    throw new Error('Skill file path is invalid.')
  }
  if (normalized.split('/').length > maxTreeDepth) throw new Error('Skill tree path is too deep.')
  return normalized
}

function lexicalSkillPath(skill: LoadedSkill, value: string): string {
  const safe = safeRelativePath(value)
  const path = resolve(skill.summary.dirPath, safe)
  const rel = relative(resolve(skill.summary.dirPath), path)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Skill file path is outside the Skill directory.')
  return path
}

function fileKind(name: string): 'text' | 'binary' {
  const dot = name.lastIndexOf('.')
  return dot >= 0 && binaryExtensions.has(name.slice(dot).toLowerCase()) ? 'binary' : 'text'
}

async function readBoundedTextFile(path: string): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error('Skill file is not a regular file.')
    if (info.size > maxPreviewBytes) throw new Error(`Skill file exceeds ${maxPreviewBytes} bytes.`)
    const buffer = Buffer.allocUnsafe(maxPreviewBytes + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > maxPreviewBytes) throw new Error(`Skill file exceeds ${maxPreviewBytes} bytes.`)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

export async function listSkillFiles(projectId: string | undefined, skillId: string, relativePath?: string): Promise<SkillFileNode[]> {
  const skill = await findSkill(projectId, skillId)
  const directory = relativePath ? lexicalSkillPath(skill, relativePath) : skill.summary.dirPath
  const directoryInfo = await stat(directory)
  if (!directoryInfo.isDirectory()) throw new Error('Skill tree node is not a directory.')
  const entries = await readdir(directory, { withFileTypes: true })
  if (entries.length > maxTreeEntriesPerDirectory) {
    throw new Error(`Skill directory contains more than ${maxTreeEntriesPerDirectory} entries.`)
  }
  const nodes = await Promise.all(entries
    .filter((entry) => !ignoredDirectories.has(entry.name.toLowerCase()))
    .map(async (entry): Promise<SkillFileNode> => {
      const childPath = join(directory, entry.name)
      const childRelative = relativePath ? `${safeRelativePath(relativePath)}/${entry.name}` : entry.name
      const linkInfo = await lstat(childPath)
      const targetInfo = linkInfo.isSymbolicLink() ? await stat(childPath).catch(() => undefined) : linkInfo
      const kind = linkInfo.isSymbolicLink()
        ? 'symlink'
        : targetInfo?.isDirectory()
          ? 'directory'
          : fileKind(entry.name)
      return {
        name: entry.name,
        path: childPath,
        relativePath: childRelative,
        kind,
        ...(!targetInfo?.isDirectory() && targetInfo ? { size: targetInfo.size } : {}),
        ...(linkInfo.isSymbolicLink() ? {
          linkTarget: await readlink(childPath),
          resolvedPath: await realpath(childPath).catch(() => undefined),
          linkDirectory: targetInfo?.isDirectory() ?? false
        } : {})
      }
    }))
  return nodes.sort((left, right) => (
    Number(right.kind === 'directory' || right.linkDirectory) - Number(left.kind === 'directory' || left.linkDirectory)
    || left.name.localeCompare(right.name)
  ))
}

export async function readSkillFile(projectId: string | undefined, skillId: string, relativePath: string): Promise<SkillFilePreview> {
  const skill = await findSkill(projectId, skillId)
  const lexicalPath = lexicalSkillPath(skill, relativePath)
  const [linkInfo, resolvedPath] = await Promise.all([lstat(lexicalPath), realpath(lexicalPath)])
  const handle = await open(resolvedPath, 'r')
  let info
  let data: Buffer
  try {
    info = await handle.stat()
    if (!info.isFile()) throw new Error('Skill tree node is not a file.')
    if (info.size > maxPreviewBytes) throw new Error(`Skill file exceeds ${maxPreviewBytes} bytes.`)
    const buffer = Buffer.allocUnsafe(maxPreviewBytes + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > maxPreviewBytes) throw new Error(`Skill file exceeds ${maxPreviewBytes} bytes.`)
    data = buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
  const binary = fileKind(resolvedPath) === 'binary' || data.includes(0)
  return {
    skillId,
    name: basename(lexicalPath),
    path: lexicalPath,
    relativePath: safeRelativePath(relativePath),
    resolvedPath,
    ...(linkInfo.isSymbolicLink() ? { linkTarget: await readlink(lexicalPath) } : {}),
    size: info.size,
    kind: binary ? 'binary' : 'text',
    ...(!binary ? { content: data.toString('utf8') } : {})
  }
}

export async function updateSkillAvailability(projectId: string | undefined, skillId: string, update: SkillAvailabilityUpdate): Promise<SkillSnapshot> {
  const hasModelAvailable = typeof update?.modelAvailable === 'boolean'
  const hasUserAvailable = typeof update?.userAvailable === 'boolean'
  if (!hasModelAvailable && !hasUserAvailable) throw new Error('Skill availability update is empty or invalid.')
  if (update.modelAvailable !== undefined && !hasModelAvailable) throw new Error('Skill model availability is invalid.')
  if (update.userAvailable !== undefined && !hasUserAvailable) throw new Error('Skill user availability is invalid.')
  const currentSkill = await findSkill(projectId, skillId)
  return mutateSkillsConfig(async (config) => {
    const current = config.availability[skillId] ?? {
      model_available: currentSkill.summary.modelAvailable,
      user_available: currentSkill.summary.userAvailable
    }
    config.availability[skillId] = {
      model_available: update.modelAvailable ?? current.model_available,
      user_available: update.userAvailable ?? current.user_available
    }
    await writeSkillsConfig(config)
    return listSkillSnapshot(projectId)
  })
}

interface SkillImportSource {
  name: string
  path: string
}

async function inspectSkillImportSource(sourcePath: string): Promise<SkillImportSource> {
  const selectedPath = resolve(sourcePath)
  const name = basename(selectedPath)
  if (!skillNamePattern.test(name) || name.length > 64) {
    throw new SkillImportFailure('invalid_directory', `Invalid Skill directory name: ${name}`)
  }
  let canonicalPath: string
  try {
    const info = await stat(selectedPath)
    if (!info.isDirectory()) throw new SkillImportFailure('invalid_directory', `Skill source is not a directory: ${selectedPath}`)
    canonicalPath = await realpath(selectedPath)
  } catch (reason) {
    if (reason instanceof SkillImportFailure) throw reason
    const code = (reason as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new SkillImportFailure('invalid_directory', `Skill source does not exist: ${selectedPath}`)
    }
    throw reason
  }
  let content: string
  try {
    const skillFile = join(canonicalPath, 'SKILL.md')
    const info = await stat(skillFile)
    if (!info.isFile()) throw new SkillImportFailure('invalid_skill', `SKILL.md is not a regular file: ${skillFile}`, name, { code: 'unreadable_skill_file' })
    if (info.size > maxPreviewBytes) {
      throw new SkillImportFailure('invalid_skill', `SKILL.md exceeds ${maxPreviewBytes} bytes: ${skillFile}`, name, { code: 'unreadable_skill_file', detail: `The file exceeds ${maxPreviewBytes} bytes.` })
    }
    content = await readFile(skillFile, 'utf8')
  } catch (reason) {
    if (reason instanceof SkillImportFailure) throw reason
    const code = (reason as NodeJS.ErrnoException).code
    const issue: SkillLoadIssue = code === 'ENOENT'
      ? { code: 'missing_skill_file' }
      : { code: 'unreadable_skill_file', detail: reason instanceof Error ? reason.message : String(reason) }
    throw new SkillImportFailure('invalid_skill', `Cannot read Skill definition: ${selectedPath}`, name, issue)
  }
  const parsed = inspectSkillText(content, name)
  if ('code' in parsed) throw new SkillImportFailure('invalid_skill', `Invalid Skill definition: ${name}`, name, parsed)
  return { name, path: canonicalPath }
}

async function importSkillDirectoriesExclusive(sourcePaths: readonly string[], projectId?: string): Promise<{ names: string[]; snapshot: SkillSnapshot }> {
  if (!Array.isArray(sourcePaths) || sourcePaths.length === 0 || sourcePaths.some((path) => typeof path !== 'string' || !path.trim())) {
    throw new SkillImportFailure('invalid_directory', 'At least one Skill directory is required.')
  }
  await initializeSkillsStore()
  const sources = await Promise.all(sourcePaths.map(inspectSkillImportSource))
  const names = new Set<string>()
  for (const source of sources) {
    if (names.has(source.name) || await entryExists(join(getSkillsDir(), source.name))) {
      throw new SkillImportFailure('already_exists', `Skill already exists: ${source.name}`, source.name)
    }
    names.add(source.name)
  }

  const stageRoot = join(getSkillsDir(), `.import.${process.pid}.${randomUUID()}.tmp`)
  const installed: string[] = []
  await mkdir(stageRoot)
  try {
    for (const source of sources) {
      const staged = join(stageRoot, source.name)
      await cp(source.path, staged, { recursive: true, dereference: false, errorOnExist: true, force: false, verbatimSymlinks: true })
      await inspectSkillImportSource(staged)
    }
    for (const source of sources) {
      const target = join(getSkillsDir(), source.name)
      if (await entryExists(target)) {
        throw new SkillImportFailure('already_exists', `Skill already exists: ${source.name}`, source.name)
      }
      await rename(join(stageRoot, source.name), target)
      installed.push(target)
    }
    return { names: sources.map((source) => source.name), snapshot: await listSkillSnapshot(projectId) }
  } catch (reason) {
    await Promise.all(installed.map((path) => rm(path, { recursive: true, force: true }).catch(() => undefined)))
    throw reason
  } finally {
    await rm(stageRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}

export function importSkillDirectories(sourcePaths: readonly string[], projectId?: string): Promise<{ names: string[]; snapshot: SkillSnapshot }> {
  const result = skillImportTail.then(async () => importSkillDirectoriesExclusive(sourcePaths, projectId))
  skillImportTail = result.then(() => undefined, () => undefined)
  return result
}

function uniqueAlias(config: SkillsConfigFile, name: string): string {
  const used = new Set([...reservedAliases, ...config.external_directories.map((item) => item.shortcut_alias)])
  const base = slug(name)
  let candidate = base
  let suffix = 2
  while (used.has(candidate)) candidate = `${base}-${suffix++}`
  return candidate
}

function defaultExternalDirectoryName(path: string): string {
  if (path === join(homedir(), '.agents', 'skills')) return '~/.agents/skills'
  const leaf = basename(path)
  if (leaf.toLowerCase() !== 'skills') return leaf || path
  const parent = dirname(path)
  const parentName = basename(parent)
  if (parentName === '.agents' || parentName === '.codex') return basename(dirname(parent)) || leaf
  return parentName || leaf
}

async function reservedSkillRootPaths(projectId?: string): Promise<string[]> {
  const paths = [getSystemSkillsDir(), getSkillsDir(), getSkillExamplesDir()]
  if (projectId) {
    const project = await getProject(projectId)
    if (project.kind === 'workspace') {
      paths.push(...project.sourceFolders.map((folder) => join(folder, '.agents', 'skills')))
    }
  }
  return Promise.all(paths.map(async (path) => realpath(path).catch(() => resolve(path))))
}

export async function addExternalSkillDirectory(path: string, projectId?: string): Promise<SkillSnapshot> {
  const absolute = externalPath(path)
  const info = await stat(absolute)
  if (!info.isDirectory()) throw new Error('Selected Skill root is not a directory.')
  const canonical = await realpath(absolute)
  if ((await reservedSkillRootPaths(projectId)).includes(canonical)) {
    throw new Error('This Skill directory is already managed by Anas.')
  }
  return mutateSkillsConfig(async (config) => {
    for (const existing of config.external_directories) {
      const candidate = externalPath(existing.path)
      const resolvedCandidate = await realpath(candidate).catch(() => candidate)
      if (resolvedCandidate === canonical) throw new Error('Skill directory is already configured.')
    }
    const name = defaultExternalDirectoryName(absolute)
    config.external_directories.push({ id: randomUUID(), name, shortcut_alias: uniqueAlias(config, name), path: absolute })
    await writeSkillsConfig(config)
    return listSkillSnapshot(projectId)
  })
}

export async function removeExternalSkillDirectory(rootId: string, projectId?: string): Promise<SkillSnapshot> {
  return mutateSkillsConfig(async (config) => {
    const index = config.external_directories.findIndex((directory) => directory.id === rootId)
    if (index < 0) throw new Error('External Skill directory was not found.')
    config.external_directories.splice(index, 1)
    config.script_auto_approve_skills = config.script_auto_approve_skills.filter(id => !id.startsWith(`${rootId}:`))
    for (const id of Object.keys(config.availability)) if (id.startsWith(`${rootId}:`)) delete config.availability[id]
    await writeSkillsConfig(config)
    return listSkillSnapshot(projectId)
  })
}

export async function updateExternalSkillDirectory(rootId: string, update: SkillRootUpdate, projectId?: string): Promise<SkillSnapshot> {
  const name = normalizeRootDisplayName(update?.name)
  const shortcutAlias = normalizeShortcutAlias(update?.shortcutAlias)
  return mutateSkillsConfig(async (config) => {
    const directory = config.external_directories.find((candidate) => candidate.id === rootId)
    if (!directory) throw new Error('External Skill directory was not found.')
    if (reservedAliases.has(shortcutAlias) || config.external_directories.some((candidate) => candidate.id !== rootId && candidate.shortcut_alias === shortcutAlias)) {
      throw new Error('Skill directory shortcut alias is already in use.')
    }
    directory.name = name
    directory.shortcut_alias = shortcutAlias
    await writeSkillsConfig(config)
    return listSkillSnapshot(projectId)
  })
}

export async function moveExternalSkillDirectory(rootId: string, direction: -1 | 1, projectId?: string): Promise<SkillSnapshot> {
  if (direction !== -1 && direction !== 1) throw new Error('Skill directory move direction is invalid.')
  return mutateSkillsConfig(async (config) => {
    const index = config.external_directories.findIndex((directory) => directory.id === rootId)
    if (index < 0) throw new Error('External Skill directory was not found.')
    const nextIndex = index + direction
    if (nextIndex >= 0 && nextIndex < config.external_directories.length) {
      const [directory] = config.external_directories.splice(index, 1)
      config.external_directories.splice(nextIndex, 0, directory)
      await writeSkillsConfig(config)
    }
    return listSkillSnapshot(projectId)
  })
}

export async function buildUserSkillInvocation(projectId: string | undefined, name: string, sourceAlias: string | undefined, args: string): Promise<SkillInvocationResult> {
  const project = projectId ? await getProject(projectId) : undefined
  const selection = project?.kind === 'workspace' ? effectiveProjectCapabilities(project, (await getAppConfigSnapshot()).defaultCapabilities).skills : defaultCapabilities.skills
  const catalog = await loadCatalog(projectId, selection)
  const named = catalog.skills.filter((skill) => !skill.summary.loadError && skill.summary.name.toLowerCase() === name.trim().toLowerCase())
  if (!named.length) return { handled: false, promptText: '', displayText: '' }
  const command = `/${name}${sourceAlias ? `@${sourceAlias}` : ''}`
  if (sourceAlias && !catalog.roots.some((root) => root.shortcutAlias === sourceAlias)) {
    return { handled: true, promptText: '', displayText: command, errorCode: 'source_not_found', errorName: name }
  }
  const candidates = sourceAlias ? named.filter((skill) => skill.summary.shortcutAlias === sourceAlias) : named
  if (sourceAlias && candidates.length === 0) {
    return { handled: true, promptText: '', displayText: command, errorCode: 'source_skill_not_found', errorName: name }
  }
  const skill = candidates.find((candidate) => candidate.summary.userAvailable)
  if (!skill) return { handled: true, promptText: '', displayText: command, errorCode: 'user_unavailable', errorName: name }
  const trimmedArgs = args.trim()
  const displayText = `${command}${trimmedArgs ? ` ${trimmedArgs}` : ''}`
  const skillPath = join(skill.summary.dirPath, 'SKILL.md')
  const contents = await readBoundedTextFile(skillPath)
  const parsed = inspectSkillText(contents, skill.summary.name)
  if ('code' in parsed) throw new Error(`Skill ${skill.summary.name} could not be loaded: ${parsed.code}`)
  if (!parsed.body.trim()) throw new Error(`Skill instructions are empty: ${skill.summary.name}`)
  return {
    handled: true,
    displayText,
    promptText: [
      displayText,
      '',
      '<skill>',
      `<name>${skill.summary.name}</name>`,
      `<path>${skillPath}</path>`,
      contents,
      '</skill>'
    ].join('\n')
  }
}

// Filesystem Skill guidance from OpenAI Codex (Apache-2.0); see data/licenses/codex.
const skillsIntro = "A skill is a set of local instructions to follow that is stored in a `SKILL.md` file. Below is the list of skills that can be used. Each entry includes a name, description, and the absolute path to its `SKILL.md` file."
const skillsUsage = "- Discovery: The list above is the skills available in this session (name + description + absolute path). Skill bodies live on disk at the listed paths.\n- Trigger rules: If the user names a skill (with `$SkillName` or plain text) OR the task clearly matches a skill's description shown above, you must use that skill for that turn. Multiple mentions mean use them all. Do not carry skills across turns unless re-mentioned.\n- Missing/blocked: If a named skill isn't in the list or the path can't be read, say so briefly and continue with the best fallback.\n- How to use a skill (progressive disclosure):\n  1) After deciding to use a skill, the main agent must open the listed absolute path and read its `SKILL.md` completely before taking task actions. If a read is truncated or paginated, continue until EOF.\n  2) When `SKILL.md` references relative paths (e.g., `scripts/foo.py`), resolve them relative to the directory containing that `SKILL.md` first, and only consider other paths if needed.\n  3) If `SKILL.md` points to extra folders such as `references/`, use its routing instructions to identify the files required for the task. The main agent must read each required instruction or reference file itself before acting on it. Do not delegate reading, summarizing, or interpreting skill instructions to a subagent. Subagents may still perform task work when the selected skill allows it.\n  4) If `scripts/` exist, prefer running or patching them instead of retyping large code blocks.\n  5) If `assets/` or templates exist, reuse them instead of recreating from scratch.\n- Coordination and sequencing:\n  - If multiple skills apply, choose the minimal set that covers the request and state the order you'll use them.\n  - Announce which skill(s) you're using and why (one short line). If you skip an obvious skill, say why.\n- Context hygiene:\n  - Progressive disclosure applies to selecting relevant files, not partially reading a selected instruction file. Do not load unrelated references, scripts, or assets.\n  - Avoid deep reference-chasing: prefer opening only files directly linked from `SKILL.md` unless you're blocked.\n  - When variants exist (frameworks, providers, domains), pick only the relevant reference file(s) and note that choice.\n- Safety and fallback: If a skill can't be applied cleanly (missing files, unclear instructions), state the issue, pick the next-best approach, and continue."

export async function buildSkillsPrompt(projectId?: string, selection: SkillSelection = defaultCapabilities.skills, sourceFolders?: string[]): Promise<string> {
  const catalog = await loadCatalog(projectId, selection, sourceFolders)
  const winners = catalog.skills.filter((skill) => (
        !skill.summary.loadError
        && skill.summary.modelAvailable
        && !skill.summary.modelShadowedBy
      ))
  if (!selection.enabled || !catalog.skills.some((skill) => !skill.summary.loadError && (skill.summary.modelAvailable || skill.summary.userAvailable))) return ''
  return [
    '<skills_instructions>',
    '',
    '## Skills',
    skillsIntro,
    '### Available skills',
    ...winners.map(({ summary: skill }) => `- ${skill.name}: ${skill.description} (file: ${join(skill.dirPath, 'SKILL.md')})`),
    '### How to use skills',
    skillsUsage,
    '',
    '</skills_instructions>'
  ].join('\n')
}
