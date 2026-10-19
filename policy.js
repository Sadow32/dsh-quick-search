/**
 * quick-search 的纯策略函数：目录解析、生效判定、档位默认值和配置校验。
 * 本文件不依赖 Cordis，便于在单元测试中直接调用。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DEPTHS = ['quick', 'standard', 'deep']
export const SWITCH_MODES = ['never', 'when-default', 'always']
export const ACTIVATE_MODES = ['exact', 'subtree']

/**
 * 快问模式下仍然保留的工具。它们不读写本地文件，也不启动子代理。
 * search_answer 是会话作用域工具，不在此列也会自动可见。
 */
export const KEEP_TOOLS = [
  'ask_user_question',
  'todo_write',
  'get_goal',
  'create_goal',
  'update_goal',
]

export const DEFAULT_PREFERENCES = `用简体中文回答；先一句话结论，再给 2–4 条依据。
技术问题优先官方文档、GitHub、RFC；不引用内容农场和聚合站。
价格、版本、日期必须注明信息时间；不确定就直说，不要猜。
回答保持简短，不重复问题，不写免责声明。`

/** 每档的默认预算；配置里的 depthOverrides 只覆盖显式给出的字段。 */
export const DEFAULT_DEPTH_LIMITS = {
  quick: { queries: 1, maxResults: 4, fetchPages: 0, maxSources: 3 },
  standard: { queries: 2, maxResults: 6, fetchPages: 2, maxSources: 5 },
  deep: { queries: 4, maxResults: 8, fetchPages: 4, maxSources: 8 },
}

/** 展开 `~` 和 `~/` 前缀；pathApi 允许测试注入 Windows 路径语义。 */
export function expandHome(value, home = os.homedir(), pathApi = path) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  if (trimmed === '~') return home
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return pathApi.join(home, trimmed.slice(2))
  }
  return trimmed
}

/** 路径比较统一先 resolve，避免尾部斜杠和相对片段造成误判。 */
export function samePath(left, right, pathApi = path) {
  return pathApi.resolve(left) === pathApi.resolve(right)
}

export function isDirectory(candidate) {
  try {
    return fs.statSync(candidate).isDirectory()
  } catch {
    return false
  }
}

/**
 * 默认快问目录。Windows 优先用户目录下的 Desktop，其次兼容 OneDrive 重定向。
 * 目录不存在时仍返回默认路径，由调用方决定是否报告错误。
 */
export function defaultQuickDirectory(home = os.homedir(), isDir = isDirectory, pathApi = path) {
  const direct = pathApi.join(home, 'Desktop')
  if (isDir(direct)) return direct
  const oneDrive = pathApi.join(home, 'OneDrive', 'Desktop')
  if (isDir(oneDrive)) return oneDrive
  return direct
}

/**
 * 解析快问目录。
 * 显式配置不存在或不是目录时回退默认快问目录，并在返回值中带上可读错误。
 */
export function resolveWorkDirectory(config, deps = {}) {
  const home = deps.home ?? os.homedir()
  const isDir = deps.isDirectory ?? isDirectory
  const pathApi = deps.path ?? path
  const configured = config?.workDirectory
  if (configured !== undefined && configured !== null && String(configured).trim() !== '') {
    const expanded = expandHome(String(configured), home, pathApi)
    const resolved = pathApi.isAbsolute(expanded) ? pathApi.resolve(expanded) : pathApi.resolve(home, expanded)
    if (isDir(resolved)) return { path: resolved, source: 'config' }
    const fallback = pathApi.resolve(defaultQuickDirectory(home, isDir, pathApi))
    return {
      path: fallback,
      source: 'fallback',
      error: `workDirectory 不存在或不是目录：${resolved}`,
    }
  }
  const defaultPath = pathApi.resolve(defaultQuickDirectory(home, isDir, pathApi))
  if (!isDir(defaultPath)) {
    return { path: defaultPath, source: 'default', error: `未找到默认快问目录：${defaultPath}` }
  }
  return { path: defaultPath, source: 'default' }
}

/**
 * 解析额外生效目录。不存在的目录被忽略，不影响主目录。
 * 返回绝对路径数组，供 isActive 使用。
 */
export function resolveAdditionalDirectories(config, deps = {}) {
  const home = deps.home ?? os.homedir()
  const isDir = deps.isDirectory ?? isDirectory
  const pathApi = deps.path ?? path
  const paths = []
  for (const raw of config?.additionalDirectories ?? []) {
    const expanded = expandHome(raw, home, pathApi)
    if (!expanded) continue
    const resolved = pathApi.isAbsolute(expanded) ? pathApi.resolve(expanded) : pathApi.resolve(home, expanded)
    if (isDir(resolved)) paths.push(resolved)
    else deps.warn?.(`additionalDirectories 不存在或不是目录：${resolved}`)
  }
  return paths
}

/** 判断会话目录是否落在快问目录内。exact 只匹配根目录，subtree 包含子目录。 */
export function isActive(cwd, targetPath, options = {}) {
  const pathApi = options.path ?? path
  const directories = [targetPath, ...(options.additionalDirectories ?? [])].filter(Boolean)
  const mode = options.activateOn === 'subtree' ? 'subtree' : 'exact'
  return directories.some((directory) => {
    if (mode === 'exact') return samePath(cwd, directory, pathApi)
    const relative = pathApi.relative(pathApi.resolve(directory), pathApi.resolve(cwd))
    return relative === '' || (!relative.startsWith('..') && !pathApi.isAbsolute(relative))
  })
}

/**
 * 是否把新会话切到快问目录。
 * when-default 只覆盖“用户没有明确选择项目目录”的默认位置。
 */
export function shouldSwitch(cwd, targetPath, mode, defaults = [], pathApi = path) {
  if (mode === 'never') return false
  if (samePath(cwd, targetPath, pathApi)) return false
  if (mode === 'always') return true
  return defaults.filter(Boolean).some((directory) => samePath(cwd, directory, pathApi))
}

function positiveInteger(value, fallback, field) {
  if (value === undefined || value === null) return fallback
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`quick-search: ${field} 必须是正整数`)
  }
  return value
}

function nonNegativeInteger(value, fallback, field) {
  if (value === undefined || value === null) return fallback
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`quick-search: ${field} 必须是非负整数`)
  }
  return value
}

function normalizeDepthOverrides(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const result = {}
  for (const depth of DEPTHS) {
    const defaults = DEFAULT_DEPTH_LIMITS[depth]
    const override = input[depth] && typeof input[depth] === 'object' ? input[depth] : {}
    result[depth] = {
      queries: positiveInteger(override.queries, defaults.queries, `depthOverrides.${depth}.queries`),
      maxResults: positiveInteger(override.maxResults, defaults.maxResults, `depthOverrides.${depth}.maxResults`),
      fetchPages: nonNegativeInteger(override.fetchPages, defaults.fetchPages, `depthOverrides.${depth}.fetchPages`),
      maxSources: positiveInteger(override.maxSources, defaults.maxSources, `depthOverrides.${depth}.maxSources`),
    }
  }
  return result
}

/**
 * 校验并补全配置。非法配置在这里抛错，让插件在激活阶段就失败，
 * 而不是等到会话中才出现难以定位的行为差异。
 */
export function normalizeConfig(raw = {}) {
  const input = raw && typeof raw === 'object' ? raw : {}

  if (input.workDirectory !== undefined && input.workDirectory !== null && typeof input.workDirectory !== 'string') {
    throw new Error('quick-search: workDirectory 必须是字符串或 null')
  }
  if (input.preferences !== undefined && input.preferences !== null && typeof input.preferences !== 'string') {
    throw new Error('quick-search: preferences 必须是字符串')
  }
  if (input.additionalDirectories !== undefined && !Array.isArray(input.additionalDirectories)) {
    throw new Error('quick-search: additionalDirectories 必须是字符串数组')
  }
  if (input.extraDenyTools !== undefined && !Array.isArray(input.extraDenyTools)) {
    throw new Error('quick-search: extraDenyTools 必须是字符串数组')
  }

  const additionalDirectories = (input.additionalDirectories ?? [])
    .filter((item) => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim())
  const extraDenyTools = (input.extraDenyTools ?? [])
    .filter((item) => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim())

  const defaultDepth = DEPTHS.includes(input.defaultDepth) ? input.defaultDepth : 'standard'
  const autoSwitchWorkDirectory = SWITCH_MODES.includes(input.autoSwitchWorkDirectory)
    ? input.autoSwitchWorkDirectory
    : 'when-default'
  const activateOn = ACTIVATE_MODES.includes(input.activateOn) ? input.activateOn : 'exact'
  const answerLanguage = ['auto', 'zh-CN', 'en'].includes(input.answerLanguage)
    ? input.answerLanguage
    : 'auto'

  if (input.citationCheck !== undefined && typeof input.citationCheck !== 'boolean') {
    throw new Error('quick-search: citationCheck 必须是布尔值')
  }

  return {
    workDirectory: typeof input.workDirectory === 'string' ? input.workDirectory.trim() : null,
    autoSwitchWorkDirectory,
    activateOn,
    additionalDirectories,
    defaultDepth,
    answerLanguage,
    preferences: typeof input.preferences === 'string' && input.preferences.trim().length > 0
      ? input.preferences
      : DEFAULT_PREFERENCES,
    depthOverrides: normalizeDepthOverrides(input.depthOverrides),
    fetchMaxChars: positiveInteger(input.fetchMaxChars, 6000, 'fetchMaxChars'),
    timeoutMs: positiveInteger(input.timeoutMs, 45000, 'timeoutMs'),
    citationCheck: input.citationCheck !== false,
    extraDenyTools,
  }
}
