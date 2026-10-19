# 快问搜索（Quick Search）

一个 DeepSeek Harness Host 插件：在指定的“快问目录”里把会话切换成只检索模式，按档位搜索并给出带来源的简短结论。

## 功能

- 快问目录可配置，默认使用系统默认目录。
- 新会话可选自动切换到快问目录，支持 `never`、`when-default`、`always` 三种策略。
- 三档搜索：`quick`、`standard`、`deep`，每档可独立覆盖查询数、结果数、抓页数和来源数。
- 一段自由文本偏好，控制回答语言、来源优先级和回答风格。
- 结果固定为“结论 / 依据 / 来源”，每条依据带 `[S#]`，来源链接可点击。
- 聊天里以 Web 来源卡片展示检索结果。
- 回答完成后检查无效 `[S#]`，在同一轮内提醒模型修正一次，避免编造来源。
- 快问会话内禁用文件读写、命令执行、子代理和工作流工具。
- 插件自身不读取快问目录里的任何文件。

## 安装

当前已安装在 `desktop` profile。重新安装或迁移时：

```text
plugin_manager install_bundle target=/绝对路径/quick-search
```

安装后插件行 id 为 `quick-search`。

## 配置

在 profile 的用户 patch 层覆盖插件配置，升级插件不会丢失：

`~/.dsh/profiles/desktop/cordis.patch.yml`

```yaml
- id: quick-search
  config:
    workDirectory: "~/QA"
    autoSwitchWorkDirectory: when-default
    activateOn: exact
    additionalDirectories:
      - "~/Downloads/quick-qa"
    defaultDepth: standard
    answerLanguage: auto
    preferences: |
      用简体中文回答；先一句话结论，再给 2–4 条依据。
      技术问题优先官方文档、GitHub、RFC；不引用内容农场。
      价格、版本、日期必须注明信息时间；不确定就直说。
    depthOverrides:
      deep:
        queries: 4
        maxResults: 8
        fetchPages: 4
        maxSources: 8
    fetchMaxChars: 6000
    timeoutMs: 45000
    citationCheck: true
    extraDenyTools: []
```

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `workDirectory` | string \| null | `null` | 快问目录；`null` 表示自动选择系统默认目录 |
| `autoSwitchWorkDirectory` | `never` \| `when-default` \| `always` | `when-default` | 新会话是否自动切换到快问目录 |
| `activateOn` | `exact` \| `subtree` | `exact` | 快问目录的生效范围 |
| `additionalDirectories` | string[] | `[]` | 额外生效目录 |
| `defaultDepth` | `quick` \| `standard` \| `deep` | `standard` | 默认搜索档位 |
| `answerLanguage` | `auto` \| `zh-CN` \| `en` | `auto` | 回答语言 |
| `preferences` | string | 内置中文默认 | 自由文本偏好 |
| `depthOverrides` | object | `{}` | 覆盖某一档的查询数、结果数、抓页数、来源数 |
| `fetchMaxChars` | number | `6000` | 单页正文最多注入的字符数 |
| `timeoutMs` | number | `45000` | 单次工具调用的总预算 |
| `citationCheck` | boolean | `true` | 检查回答中的无效 `[S#]`，在同一轮内提醒一次 |
| `extraDenyTools` | string[] | `[]` | 追加禁用的工具名 |

配置覆盖会替换整份 config，未写出的字段由插件补默认值。配置非法时插件在激活阶段报错，不会带着错误配置运行。

## 档位

| 档位 | 查询数 | 单次结果上限 | 抓取页面 | 来源数 | 适用 |
|---|---|---|---|---|---|
| `quick` | 1 | 4 | 0 | 2–3 | 名词解释、事实确认 |
| `standard` | 2–3 | 6 | ≤ 2 | 3–5 | 默认，大部分小问题 |
| `deep` | 3–4 | 8 | ≤ 4 | 5–8 | 对比、争议、时效性强的信息 |

- `quick` 只发一次查询，不抓页面。
- `standard` 用原问题加一个限定查询；有关键词时优先使用。
- `deep` 优先使用模型提供的 `focus` 子问题；不足时用“官方文档 / 最新进展 / 对比”补齐。
- 单个查询失败不会拖垮整次调用，失败原因写入结果的“降级说明”。

## 来源排序

优先级从高到低：

1. 用户 `preferences` 中明确点名的域名。
2. 官方文档、标准组织和政府/大学站点。
3. 代码托管站点（GitHub、GitLab）。
4. 有摘要、有发布时间的来源。
5. 其他来源。

内容农场和聚合站降权，但不会完全丢弃。通用代码托管不再压过官方文档。

## 引用校验

每次 `search_answer` 会记录本次来源编号。回答完成后，插件在 `agent/turn-stopping` 读取本轮最后一条 assistant 文本：

- 只检查 `[S#]` 形式的引用；
- 发现不在本次来源集合中的编号时，向下一步注入一条运行时上下文提醒；
- 每个 turn 最多提醒一次，提醒只要求修正编号或删除依据，不重新搜索；
- 提醒使用 `agent.inject`，不会唤醒新一轮会话。

`citationCheck: false` 可以关闭。

## 文件隔离

快问会话内只保留：

```text
search_answer
ask_user_question
todo_write
get_goal
create_goal
update_goal
```

文件、命令、子代理、工作流和插件管理类工具被移除。`subagent` 属于会话作用域注册，`restrict` 无法从 schema 中移除，但 guard 会拒绝执行；系统提示也会明确禁止。

已知边界：Harness 会自动加载工作目录下的 `AGENTS.md`，这不是文件工具读取，插件不拦截。

## 验证

```bash
node --check index.js
node --check search.js
node --check citation.js
node --check policy.js
node --test test/search.test.mjs test/policy.test.mjs test/citation.test.mjs
```

手动验证：

1. 在快问目录新建会话，问一个时效性问题。
2. 确认回答包含“结论 / 依据 / 来源”，依据句末有 `[S#]`。
3. 要求模型读取目录里的文件，确认被拒绝。
4. 在子目录或普通项目目录新建会话，确认没有 `search_answer`、文件工具正常可用。
5. 分别用 `quick` 和 `deep` 问同一问题，对比来源数、抓页数和回答长度。
6. 让模型引用一个不存在的 `[S9]`，确认它收到引用校验提醒并修正。

## 卸载

```text
plugin_manager remove_bundle target=@local/quick-search
```

卸载后插件注册的工具、提示词和限制会随插件上下文一起释放。

## 当前阶段

- 阶段 1：骨架、目录识别、文件隔离、最小搜索。
- 阶段 2：三档策略、抓页、来源排序、文字偏好、提示词拆分。
- 阶段 3：引用校验、Web 来源卡片、Windows 路径测试、官方来源权重调整。
