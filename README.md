# dsh-gif-gate

看动图前的策略闸门。Host-only，无 UI。

## 为什么

2026-11-08 20:42，`gif-reading` 技能和 Daily Chat 的 `AGENTS.md` 规则同时落地，当晚出现了两种结果：

- **有规则的工作区（Daily Chat）**：20:50 收到一张 GIF，模型用 `read` 读了策略文档，再按流程拼条带判读；全程没有调 `skill` 工具。
- **没有规则的工作区（framedelta）**：21:03 catalog 刚把 `gif-reading` 刷新进来，25 秒后（21:04）模型仍直接 `read_animation` 读了 `D:\Desktop\88A9….gif`——没调技能，也没读策略。

事后扫了 170 个会话 / 1401 轮：`skill` 工具共 121 次调用，`gif-reading` 0 次。所以问题不是「策略没人读」，而是：**工作区规则能让人读，但只在那一个工作区；技能作为触发不可靠，换个工作区就失效。** 约束因此挂到工具入口。

## 行为

- 监听 `tools/pre-execute`，只看 `read_image` / `read_animation`（可配）、只对 `.gif` / `.webp`
- 本会话未读策略时拒绝，拒绝理由里附策略文档前 30 行
- 用 `read` 读过策略文档后放行——状态按 **agent** 计，同一会话里的子代理各自过一次闸（见「限制」）
- 最多拦两次，之后放行 —— 防死锁，也防模型无视两次还卡住
- 默认策略文档是包内自带的 [`strategy-template.md`](strategy-template.md)（一页检查单），装上就能跑
- 策略文档不存在时放行，并在启动日志里 warning（fail-open，但不再静默）
- **`guardStatic: true` 时按工具拦、不看扩展名**：凡 `read_image` / `read_animation` 调用都先过闸。它不是为了「顺手把静态图也管上」，而是补一类**按扩展名必然漏掉的例外**——**APNG：文件叫 `.png`，内容是动图**。默认模式按后缀认 `.gif` / `.webp`，APNG 永远漏网，模型会把它当静态图读第一帧就下结论；heic 动图、无后缀截图、大写扩展名同理。代价是所有读图动作都变贵一次。默认 `false`

## 安装

```sh
# 本地目录（未发布时）
dsh plugin --profile <profile> add link:/absolute/path/to/dsh-gif-gate

# GitHub（发布后）
dsh plugin --profile <profile> add github:nacivageer/dsh-gif-gate
```

没有 `dsh` CLI 时，用 Plugin Manager 的 `install_bundle` 指向本目录绝对路径。

## 用你自己的策略文档

自带的模板只是示例。复制 `strategy-template.md`，改成你的判读流程，然后二选一：

- 环境变量：`DSH_GIF_STRATEGY=<绝对路径>`
- profile 的 patch 行：`strategyPath: <绝对路径>`

路径指向任意 `.md`。插件靠**文件名**判断「模型读的是不是这份文档」，所以读一份同名文件也会放行；换了文件名就照新名字匹配。

开了 `guardStatic` 的话，这份文档就是所有识图动作的入口——把「先查什么库、什么条件下才开图、看完登记到哪」写在最前面，因为拦截提示只展开前 30 行。

## 配置

不声明 `Config`，用环境变量或 patch 行覆盖：

| 键 | 默认 |
|---|---|
| `strategyPath` / `DSH_GIF_STRATEGY` | 包内 `strategy-template.md` |
| `tools` | `['read_image', 'read_animation']` |
| `guardStatic` / `DSH_GIF_GATE_STATIC=1` | `false`（只拦动图） |

## 限制

- 只拦已知的看图工具；将来若换工具名需要同步改 `tools`
- 动图模式下只覆盖**按文件路径读** `.gif` / `.webp`。贴进聊天框的动图由 `dsh-read-animation` 在附件入库时解成胶片条，不经过 `read_image`，这里拦不到
- `guardStatic` 模式下判断依据是**工具**不是扩展名：只要走 `read_image` / `read_animation` 就拦，因此动画 WebP、APNG 也会一起被拦（本来也该拦），副作用是「读图」这个动作变贵了一次
- 拦截状态在内存，重启后重置；状态按 **agent** 计，不是按会话：主会话读过策略后放行，同一会话里新起的**子代理状态是空的**——它第一次读图会被拦一次，并自己读一遍策略。这是有意的（子代理有自己的上下文），但派子代理去读图时会计入这份成本
- 「读过」的判定是**调用过 `read` 且文件名匹配**，不是读完了：带 `offset` / `limit` 的部分读、以及读取失败（文件不存在或不可读）的调用，同样放行该 agent。判断发生在 `tools/pre-execute`（执行之前），那里只看得到参数，看不到读回来多少
- 拦的是"读动图"这个动作，不校验模型读完策略后是否真按策略做了
- 截至 2026-11-13，真实任务仍无拦截记录；现有拦截都来自探针（2026-11-08 22:30 安装验证、2026-11-11 重启后配置验证、2026-11-13 子代理实测）

## English

A host-only gate for DeepSeek Harness: the first `read_image` / `read_animation` of a
`.gif` / `.webp` for an agent is denied once, with the opening lines of a strategy
document in the reason. After the model reads that document, that agent is released (gate
state is per agent — a subagent starts unread); "reads" means the `read` tool was called on
that file name, not that the file was read whole — a partial read with `offset` / `limit`,
or a read that fails, releases it too. Two denials at most, then it fails open.

It ships a one-page `strategy-template.md` so it works out of the box; point it at your
own document with `DSH_GIF_STRATEGY` or `strategyPath`. It only covers reads by file
path; GIFs pasted into the composer are decoded by `dsh-read-animation` before any tool
runs and are out of scope.

With `guardStatic: true` (off by default) the gate stops filtering by extension: every
`read_image` / `read_animation` call is gated. The point is not to sweep in static images for
their own sake — it closes an exception an extension filter can never catch: **APNG, a
`.png` that is really an animation**. Static images, heic and extension-less screenshots are
covered as a side effect.

Gate state is per **agent**, not per session: a subagent starts unread, is denied once on its
own first image read, and reads the document itself. That is deliberate — a subagent has its
own context — but it is a cost to expect when delegating image work.

## License

[MIT](LICENSE) © 2026 72NG
