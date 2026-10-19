import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createCitationReminder,
  extractCitationIds,
  findInvalidCitations,
  lastAssistantText,
} from '../citation.js'

test('提取 [S#] 编号并去重', () => {
  const ids = extractCitationIds('结论见 [S1]，补充 [S2]，再次 [S1]。')
  assert.deepEqual([...ids].sort(), ['S1', 'S2'])
})

test('没有引用时返回空集合', () => {
  assert.equal(extractCitationIds('没有引用').size, 0)
  assert.equal(extractCitationIds(undefined).size, 0)
})

test('找出不在来源集合中的编号', () => {
  const invalid = findInvalidCitations('用 [S1] 和 [S9]', new Set(['S1', 'S2']))
  assert.deepEqual(invalid, ['S9'])
})

test('全部有效时不报错', () => {
  assert.deepEqual(findInvalidCitations('用 [S1] 和 [S2]', new Set(['S1', 'S2'])), [])
})

test('读取本轮最后一条文本消息', () => {
  const session = {
    events: [
      { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'old [S1]' }] } } },
      {
        type: 'assistant/message',
        data: {
          turn: 2,
          message: {
            content: [
              { type: 'tool-call', name: 'search_answer' },
              { type: 'text', text: 'new [S9]' },
            ],
          },
        },
      },
    ],
  }
  assert.equal(lastAssistantText(session, 2), 'new [S9]')
  assert.equal(lastAssistantText(session, 1), 'old [S1]')
  assert.equal(lastAssistantText(session, 3), '')
})

test('引用提醒是用户角色消息', () => {
  const reminder = createCitationReminder(['S9'], new Set(['S2', 'S1']))
  assert.equal(reminder.role, 'user')
  assert.equal(reminder.source.kind, 'user')
  assert.match(reminder.content[0].text, /\[S9\]/)
  assert.match(reminder.content[0].text, /\[S1\]、\[S2\]/)
  assert.match(reminder.content[0].text, /不要重新搜索/)
})
