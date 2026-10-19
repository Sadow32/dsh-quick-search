import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeConfig } from '../policy.js'
import {
  buildQueries,
  createSearchTool,
  dedupeSources,
  extractText,
  formatSearchText,
  rankSources,
  searchAll,
} from '../search.js'

test('quick 档只构造一个查询', () => {
  assert.deepEqual(buildQueries('What is DSH?', [], 'quick', 4), ['What is DSH?'])
})

test('standard 档补一个限定查询', () => {
  const queries = buildQueries('What is DSH?', [], 'standard', 2)
  assert.equal(queries.length, 2)
  assert.equal(queries[0], 'What is DSH?')
  assert.match(queries[1], /official documentation/)
})

test('deep 档优先使用 focus 子问题', () => {
  const queries = buildQueries('Compare A and B', ['A pricing', 'B pricing'], 'deep', 4)
  assert.equal(queries[0], 'Compare A and B')
  assert.ok(queries.includes('A pricing'))
  assert.ok(queries.includes('B pricing'))
  assert.ok(queries.length <= 4)
})

test('中文问题用中文限定词补齐', () => {
  const queries = buildQueries('什么是向量数据库', [], 'standard', 2)
  assert.match(queries[1], /官方文档/)
})

test('URL 去重并合并缺失字段', () => {
  const result = dedupeSources([
    { url: 'https://a.example/x', title: 'A' },
    { url: 'https://a.example/x', snippet: 'S' },
    { url: 'https://b.example/y', title: 'B' },
  ])
  assert.equal(result.length, 2)
  assert.equal(result[0].snippet, 'S')
})

test('来源排序优先官方域名并降权聚合站', () => {
  const ranked = rankSources([
    { url: 'https://medium.com/post', title: 'medium', snippet: 'long enough snippet text' },
    { url: 'https://github.com/org/repo', title: 'github', snippet: 'long enough snippet text' },
  ], '')
  assert.equal(ranked[0].url, 'https://github.com/org/repo')
})

test('偏好中点名的域名优先', () => {
  const ranked = rankSources([
    { url: 'https://github.com/org/repo', title: 'github', snippet: 'long enough snippet text' },
    { url: 'https://internal.example.com/page', title: 'internal', snippet: 'long enough snippet text' },
  ], '优先 internal.example.com')
  assert.equal(ranked[0].url, 'https://internal.example.com/page')
})

test('单个查询失败时保留其他结果', async () => {
  const ctx = {
    web: {
      async search({ query }) {
        if (query === 'bad') throw new Error('boom')
        return { sources: [{ url: `https://example.com/${query}`, title: query }], content: 'answer' }
      },
    },
  }
  const result = await searchAll(ctx, ['good', 'bad'], 4)
  assert.equal(result.sources.length, 1)
  assert.equal(result.degraded.length, 1)
  assert.match(result.degraded[0], /boom/)
})

test('HTML 正文转纯文本', () => {
  const text = extractText({ kind: 'html', content: '<script>x</script><p>Hello &amp; world</p>' }, 100)
  assert.equal(text, 'Hello & world')
})

test('search_answer 返回编号来源和正文摘录', async () => {
  const ctx = {
    web: {
      async search() {
        return {
          sources: [
            { url: 'https://docs.example.com/a', title: 'A', snippet: 'snippet' },
            { url: 'https://medium.com/b', title: 'B', snippet: 'snippet' },
          ],
          content: 'summary',
          truncated: false,
        }
      },
      async fetch() {
        return {
          url: 'https://docs.example.com/a',
          statusCode: 200,
          body: { kind: 'html', content: '<p>hello evidence</p>' },
          truncated: false,
        }
      },
    },
  }
  const tool = createSearchTool(ctx, normalizeConfig({ defaultDepth: 'standard' }))
  const result = await tool.execute(
    { question: 'question' },
    { signal: new AbortController().signal },
  )
  assert.equal(result.depth, 'standard')
  assert.ok(result.sources.length >= 2)
  assert.equal(result.sources[0].id, 'S1')
  assert.match(result.text, /\[S1\]/)
  assert.match(result.text, /正文摘录/)
  assert.equal(result.queries.length, 2)
})

test('空结果明确标注', () => {
  const text = formatSearchText({
    question: 'q',
    depth: 'quick',
    queries: ['q'],
    sources: [],
    evidence: [],
    answers: [],
    degraded: [],
  })
  assert.match(text, /No results found/)
})

test('工具结果提供 web 卡片元数据', async () => {
  const ctx = {
    web: {
      async search() {
        return {
          sources: [{ url: 'https://docs.example.com/a', title: 'A', snippet: 'snippet' }],
          content: 'summary',
          truncated: false,
        }
      },
      async fetch() {
        return {
          url: 'https://docs.example.com/a',
          statusCode: 200,
          body: { kind: 'text', content: 'evidence' },
          truncated: false,
        }
      },
    },
  }
  const tool = createSearchTool(ctx, normalizeConfig({ defaultDepth: 'quick' }))
  const result = await tool.execute({ question: 'q' }, { signal: new AbortController().signal })
  const meta = tool.output.presentationMeta(null, result)
  assert.equal(meta.sources.length, 1)
  const view = tool.presentResult({ question: 'q' }, { isError: false, meta })
  assert.equal(view.card, 'web')
  assert.equal(view.kind, 'search')
  assert.equal(view.sources[0].url, 'https://docs.example.com/a')
})

test('记录来源编号供引用校验', async () => {
  const citations = new Map()
  const ctx = {
    web: {
      async search() {
        return {
          sources: [
            { url: 'https://docs.example.com/a', title: 'A' },
            { url: 'https://docs.example.com/b', title: 'B' },
          ],
          truncated: false,
        }
      },
      async fetch() {
        return { statusCode: 404, body: { kind: 'text', content: '' }, truncated: false }
      },
    },
  }
  const tool = createSearchTool(ctx, normalizeConfig({ defaultDepth: 'quick' }), citations)
  await tool.execute(
    { question: 'q' },
    { agent: { id: 'agent-1' }, signal: new AbortController().signal },
  )
  assert.deepEqual([...citations.get('agent-1')].sort(), ['S1', 'S2'])
})
