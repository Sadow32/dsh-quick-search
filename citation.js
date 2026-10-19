/**
 * 引用校验：检查模型回答中的 [S#] 是否来自本次 search_answer 的来源集合。
 * 只做文本解析和提醒消息构造，不依赖 Cordis。
 */
import { randomUUID } from 'node:crypto'

const CITATION_PATTERN = /\[S(\d+)\]/g

/** 提取文本中的全部来源编号，返回 `S1`、`S2` 形式。 */
export function extractCitationIds(text) {
  const ids = new Set()
  if (typeof text !== 'string') return ids
  for (const match of text.matchAll(CITATION_PATTERN)) {
    ids.add(`S${match[1]}`)
  }
  return ids
}

/** 找出不在已知来源集合中的编号。 */
export function findInvalidCitations(text, knownIds) {
  const known = knownIds instanceof Set ? knownIds : new Set(knownIds ?? [])
  return [...extractCitationIds(text)].filter((id) => !known.has(id))
}

/**
 * 读取本轮最后一条带文本的 assistant 消息。
 * 生产环境的 Session 暴露 deriveMessages() 而不是 events 数组；
 * events 数组仅用于测试和兼容旧结构。
 */
export function lastAssistantText(session, turn) {
  if (session && Array.isArray(session.events)) {
    const text = fromEvents(session.events, turn)
    if (text.length > 0) return text
  }
  if (session && typeof session.deriveMessages === 'function') {
    try {
      const text = fromMessages(session.deriveMessages())
      if (text.length > 0) return text
    } catch {
      // 读取失败时退化为空文本，引用校验直接跳过。
    }
  }
  return ''
}

function fromEvents(events, turn) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (!event || event.type !== 'assistant/message') continue
    const data = event.data
    if (!data || data.turn !== turn) continue
    const text = textOf(data.message)
    if (text.length > 0) return text
  }
  return ''
}

function fromMessages(messages) {
  if (!Array.isArray(messages)) return ''
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || message.role !== 'assistant') continue
    const text = textOf(message)
    if (text.length > 0) return text
  }
  return ''
}

function textOf(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/**
 * 构造一条用户角色提醒。它进入下一步的 inbox，不唤醒会话，
 * 因此只在当前 turn 内追加一次纠正机会，不会无限循环。
 * source 必须是普通 user 而非 runtime-context：后者会被循环当作
 * 挂载运行时上下文，消息本身不会进入对话。
 */
export function createCitationReminder(invalidIds, knownIds) {
  const known = [...knownIds].sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)))
  const knownText = known.length > 0 ? known.map((id) => `[${id}]`).join('、') : '没有可用来源'
  const invalidText = invalidIds.map((id) => `[${id}]`).join('、')
  return {
    id: randomUUID(),
    role: 'user',
    source: { kind: 'user' },
    content: [{
      type: 'text',
      text: `引用校验：你的回答引用了 ${invalidText}，但本次 search_answer 只返回了 ${knownText}。请只修正引用编号或删除无法支持的依据，不要重新搜索。`,
    }],
  }
}
