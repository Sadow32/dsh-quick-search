import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import {
  defaultQuickDirectory,
  expandHome,
  isActive,
  normalizeConfig,
  resolveAdditionalDirectories,
  resolveWorkDirectory,
  samePath,
  shouldSwitch,
} from '../policy.js'

const macHome = '/Users/test'
const win = path.win32
const winHome = 'C:\\Users\\test'
const winDesktop = 'C:\\Users\\test\\Desktop'

function isOnly(target) {
  return (candidate) => path.resolve(candidate) === path.resolve(target)
}

test('展开主目录路径', () => {
  assert.equal(expandHome('~/QA', macHome), '/Users/test/QA')
  assert.equal(expandHome('~/QA', winHome, win), 'C:\\Users\\test\\QA')
  assert.equal(expandHome(undefined, macHome), undefined)
})

test('macOS 默认快问目录', () => {
  assert.equal(defaultQuickDirectory(macHome, isOnly('/Users/test/Desktop')), '/Users/test/Desktop')
})

test('Windows 默认快问目录与 OneDrive 回退', () => {
  const direct = defaultQuickDirectory(winHome, (candidate) => candidate === winDesktop, win)
  assert.equal(direct, winDesktop)

  const oneDrive = 'C:\\Users\\test\\OneDrive\\Desktop'
  const fallback = defaultQuickDirectory(winHome, (candidate) => candidate === oneDrive, win)
  assert.equal(fallback, oneDrive)
})

test('显式目录存在时直接使用', () => {
  const target = '/Users/test/QA'
  const result = resolveWorkDirectory({ workDirectory: '~/QA' }, {
    home: macHome,
    isDirectory: isOnly(target),
  })
  assert.equal(result.path, target)
  assert.equal(result.source, 'config')
  assert.equal(result.error, undefined)
})

test('显式目录不存在时回退并报告错误', () => {
  const result = resolveWorkDirectory({ workDirectory: '~/missing' }, {
    home: macHome,
    isDirectory: isOnly('/Users/test/Desktop'),
  })
  assert.equal(result.path, '/Users/test/Desktop')
  assert.equal(result.source, 'fallback')
  assert.match(result.error, /missing/)
})

test('Windows 路径解析可注入 path.win32', () => {
  const result = resolveWorkDirectory({ workDirectory: '~/QA' }, {
    home: winHome,
    path: win,
    isDirectory: (candidate) => candidate === 'C:\\Users\\test\\QA',
  })
  assert.equal(result.path, 'C:\\Users\\test\\QA')
  assert.equal(result.source, 'config')
})

test('额外目录过滤不存在项并告警', () => {
  const warnings = []
  const paths = resolveAdditionalDirectories({ additionalDirectories: ['~/QA', '~/missing'] }, {
    home: macHome,
    isDirectory: isOnly('/Users/test/QA'),
    warn: (message) => warnings.push(message),
  })
  assert.deepEqual(paths, ['/Users/test/QA'])
  assert.equal(warnings.length, 1)
})

test('exact 与 subtree 生效范围', () => {
  const target = '/Users/test/Desktop'
  assert.equal(isActive(target, target, { activateOn: 'exact' }), true)
  assert.equal(isActive(`${target}/project`, target, { activateOn: 'exact' }), false)
  assert.equal(isActive(`${target}/project`, target, { activateOn: 'subtree' }), true)
  assert.equal(isActive('/Users/test/QA', '/Users/test/Desktop', {
    activateOn: 'exact',
    additionalDirectories: ['/Users/test/QA'],
  }), true)
})

test('Windows 路径比较和生效判定', () => {
  assert.equal(samePath(winDesktop, 'C:/Users/test/Desktop', win), true)
  assert.equal(isActive('C:\\Users\\test\\Desktop\\sub', winDesktop, { activateOn: 'exact', path: win }), false)
  assert.equal(isActive('C:\\Users\\test\\Desktop\\sub', winDesktop, { activateOn: 'subtree', path: win }), true)
})

test('三种目录切换策略', () => {
  const target = '/Users/test/QA'
  const defaults = ['/Users/test', '/Users/test/Desktop']
  assert.equal(shouldSwitch('/Users/test/Desktop', target, 'never', defaults), false)
  assert.equal(shouldSwitch('/Users/test/Desktop', target, 'when-default', defaults), true)
  assert.equal(shouldSwitch('/Users/test/Desktop/project', target, 'when-default', defaults), false)
  assert.equal(shouldSwitch('/Users/test/Desktop/project', target, 'always', defaults), true)
  assert.equal(shouldSwitch(target, target, 'always', defaults), false)
})

test('Windows 切换策略', () => {
  const target = 'C:\\Users\\test\\QA'
  const defaults = [winHome, winDesktop]
  assert.equal(shouldSwitch(winDesktop, target, 'when-default', defaults, win), true)
  assert.equal(shouldSwitch('C:\\Users\\test\\Desktop\\project', target, 'when-default', defaults, win), false)
})

test('配置默认值与覆盖', () => {
  const defaults = normalizeConfig({})
  assert.equal(defaults.defaultDepth, 'standard')
  assert.equal(defaults.autoSwitchWorkDirectory, 'when-default')
  assert.equal(defaults.activateOn, 'exact')
  assert.equal(defaults.depthOverrides.deep.maxSources, 8)
  assert.equal(defaults.citationCheck, true)

  const custom = normalizeConfig({
    defaultDepth: 'deep',
    autoSwitchWorkDirectory: 'always',
    depthOverrides: { quick: { maxResults: 2 } },
  })
  assert.equal(custom.defaultDepth, 'deep')
  assert.equal(custom.autoSwitchWorkDirectory, 'always')
  assert.equal(custom.depthOverrides.quick.maxResults, 2)
  assert.equal(custom.depthOverrides.quick.fetchPages, 0)
})

test('非法配置在激活阶段抛错', () => {
  assert.throws(() => normalizeConfig({ workDirectory: 42 }), /workDirectory/)
  assert.throws(() => normalizeConfig({ fetchMaxChars: 0 }), /fetchMaxChars/)
  assert.throws(() => normalizeConfig({ additionalDirectories: 'x' }), /additionalDirectories/)
  assert.throws(() => normalizeConfig({ citationCheck: 'yes' }), /citationCheck/)
})
