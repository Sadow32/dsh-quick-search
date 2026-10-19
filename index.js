/**
 * quick-search Host 插件入口。
 *
 * 只在“快问目录”会话里注册搜索工具、提示词和文件隔离；其他目录的会话
 * 完全不受影响。所有按会话注册都保存在 active 表里，agent 销毁或插件卸载时清理。
 */
import os from 'node:os'

import { createCitationReminder, findInvalidCitations, lastAssistantText } from './citation.js'
import { buildPrompt } from './prompt.js'
import {
  KEEP_TOOLS,
  defaultQuickDirectory,
  isActive,
  normalizeConfig,
  resolveAdditionalDirectories,
  resolveWorkDirectory,
  shouldSwitch,
} from './policy.js'
import { createSearchTool } from './search.js'

export const name = 'quick-search'
export const inject = ['tools', 'web', 'systemPrompt', 'workingDirectory']

const PROMPT_SECTION_NAME = 'quick-search:mode'
const PROMPT_ORDER = 500

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const home = os.homedir()
  const defaultDirectory = defaultQuickDirectory(home)
  const harnessDefault = ctx.workingDirectory.defaultDirectory
  const active = new Map()
  const warned = new Set()
  const citations = new Map()
  const reminded = new Map()

  ctx.effect(() => () => {
    for (const disposers of active.values()) disposeAll(disposers)
    active.clear()
    citations.clear()
    reminded.clear()
  })

  ctx.on('agent/disposed', ({ agent }) => {
    citations.delete(agent.id)
    reminded.delete(agent.id)
    const disposers = active.get(agent.id)
    if (!disposers) return
    active.delete(agent.id)
    disposeAll(disposers)
  })

  ctx.on('agent/created', async ({ agent }) => {
    if (active.has(agent.id)) return
    try {
      const cwd = await ctx.workingDirectory.ensure(agent)
      const target = resolveWorkDirectory(config, { home })
      if (target.error && !warned.has(target.error)) {
        warned.add(target.error)
        console.warn(`[quick-search] ${target.error}`)
      }

      const extraDirectories = resolveAdditionalDirectories(config, {
        home,
        warn: (message) => {
          if (warned.has(message)) return
          warned.add(message)
          console.warn(`[quick-search] ${message}`)
        },
      })

      let effectiveCwd = cwd
      const defaults = [home, harnessDefault, defaultDirectory]
      if (shouldSwitch(cwd, target.path, config.autoSwitchWorkDirectory, defaults)) {
        try {
          effectiveCwd = await ctx.workingDirectory.set(agent, target.path)
        } catch (error) {
          console.warn(`[quick-search] 无法切换工作目录到 ${target.path}：${errorMessage(error)}`)
        }
      }

      if (!isActive(effectiveCwd, target.path, {
        activateOn: config.activateOn,
        additionalDirectories: extraDirectories,
      })) {
        return
      }

      const disposers = []
      try {
        disposers.push(agent.ctx.tools.register(createSearchTool(ctx, config, citations)))
        disposers.push(agent.ctx.systemPrompt.section({
          name: PROMPT_SECTION_NAME,
          order: PROMPT_ORDER,
          text: buildPrompt(config),
        }))

        const visible = new Set(agent.ctx.tools.schemas(agent).map((schema) => schema.name))
        const keep = KEEP_TOOLS.filter((toolName) => visible.has(toolName))
        if (keep.length > 0) {
          disposers.push(agent.ctx.tools.restrict({ allow: keep }))
        }

        const allowed = new Set(['search_answer', ...keep, ...KEEP_TOOLS])
        const denied = new Set(config.extraDenyTools)
        disposers.push(agent.ctx.tools.guard((execution) => {
          if (denied.has(execution.name)) {
            return `quick-search：${execution.name} 已被快问模式禁用。`
          }
          if (allowed.has(execution.name)) return undefined
          return `quick-search：当前为快问搜索模式，已禁用工具 ${execution.name}。`
        }))

        disposers.push(agent.ctx.on('agent/turn-stopping', async ({ turn }) => {
          if (!config.citationCheck) return
          const known = citations.get(agent.id)
          if (!known) return
          const text = lastAssistantText(agent.session, turn)
          if (text.length === 0) return
          const invalid = findInvalidCitations(text, known)
          if (invalid.length === 0) return
          const turns = reminded.get(agent.id) ?? new Set()
          if (turns.has(turn)) return
          turns.add(turn)
          reminded.set(agent.id, turns)
          try {
            agent.inject(createCitationReminder(invalid, known))
          } catch (error) {
            console.warn(`[quick-search] 引用提醒注入失败：${errorMessage(error)}`)
          }
        }))

        active.set(agent.id, disposers)
      } catch (error) {
        disposeAll(disposers)
        throw error
      }
    } catch (error) {
      console.warn(`[quick-search] 会话初始化失败：${errorMessage(error)}`)
    }
  })
}

function disposeAll(disposers) {
  for (const dispose of disposers) {
    try {
      dispose()
    } catch {
      // 注册可能已被 agent 作用域自动清理，重复释放不应影响其他资源。
    }
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
