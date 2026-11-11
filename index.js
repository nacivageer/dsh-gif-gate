/**
 * dsh-gif-gate — 看动图前的策略闸门。
 *
 * 为什么存在：2026-11-08 20:42，`gif-reading` 技能和 Daily Chat 的 `AGENTS.md`
 * 规则同时落地，当晚出现了两种结果：
 *   - 有规则的工作区（Daily Chat）：20:50 收到 GIF，模型用 read 读了策略文档，
 *     再按流程拼条带判读；全程没有调 skill 工具。
 *   - 没有规则的工作区（framedelta）：21:03 catalog 刚刷新出 gif-reading，
 *     25 秒后（21:04）模型仍直接 read_animation 读了 .gif，没调技能也没读策略。
 * 事后扫 170 个会话 / 1401 轮：skill 工具共 121 次调用，gif-reading 0 次。
 * 结论不是「策略没人读」，而是：工作区规则能让人读，但只在那一个工作区；
 * 技能作为触发不可靠，换个工作区就失效。所以约束挂在工具入口，而不是描述上。
 *
 * 默认策略文档是包内自带的 strategy-template.md（一页检查单）；要换成自己的文档，
 * 用 DSH_GIF_STRATEGY 环境变量或配置 strategyPath 指过去。
 *
 * 行为：本会话第一次（以及第二次）读动图被拒绝，拒绝理由里带策略文档的开头；
 * 模型用 read 读过策略文档后自动放行，本会话后续不再拦。最多拦两次，防死锁。
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const DEFAULT_STRATEGY = fileURLToPath(
  new URL('./strategy-template.md', import.meta.url),
)
const ANIMATED = /\.(gif|webp)$/i
const DEFAULT_TOOLS = ['read_image', 'read_animation']
const MAX_DENIALS = 2
const SKELETON_LINES = 30

export const inject = ['tools']

export function apply(ctx, config = {}) {
  const strategyPath =
    process.env.DSH_GIF_STRATEGY || config.strategyPath || DEFAULT_STRATEGY
  const strategyName = strategyPath.split(/[\\/]/).pop()
  const guarded = new Set(config.tools || DEFAULT_TOOLS)
  const sessions = new Map()

  if (!existsSync(strategyPath)) {
    // 路径配错时仍然 fail-open，但必须留下可见痕迹：否则装了等于没装。
    console.warn(
      `[gif-gate] strategy document not found: ${strategyPath} — gate stays inactive`,
    )
  }

  const stateOf = (id) => {
    let state = sessions.get(id)
    if (state === undefined) {
      state = { read: false, denied: 0 }
      sessions.set(id, state)
    }
    return state
  }

  const pathOf = (args) => {
    if (args === null || typeof args !== 'object') return undefined
    for (const key of ['file_path', 'path', 'input']) {
      const value = args[key]
      if (typeof value === 'string' && value.length > 0) return value
    }
    return undefined
  }

  const skeletonOf = () => {
    try {
      return readFileSync(strategyPath, 'utf8')
        .split(/\r?\n/)
        .slice(0, SKELETON_LINES)
        .join('\n')
        .trimEnd()
    } catch {
      return ''
    }
  }

  const reasonOf = (attempt, skeleton) =>
    [
      `[gif-gate] 这是本会话第 ${attempt} 次拦下读动图。先过策略，再碰图。`,
      '',
      `策略文档：${strategyPath}`,
      '',
      skeleton === '' ? '（策略文档读取失败，请先 read 上面这个路径。）' : skeleton,
      '',
      `做法：用 read 工具读上面这个文件，然后重新调用原来的工具。读到这份策略后，本会话不再拦。`,
    ].join('\n')

  ctx.effect(() =>
    ctx.on('tools/pre-execute', async (exec, next) => {
      const target = pathOf(exec.arguments)
      const session = exec.agent?.id ?? 'anonymous'

      if (
        exec.name === 'read' &&
        typeof target === 'string' &&
        target.split(/[\\/]/).pop() === strategyName
      ) {
        stateOf(session).read = true
        return next()
      }

      if (!guarded.has(exec.name)) return next()
      if (typeof target !== 'string' || !ANIMATED.test(target)) return next()

      const state = stateOf(session)
      if (state.read) return next()
      if (!existsSync(strategyPath)) return next()
      if (state.denied >= MAX_DENIALS) return next()

      state.denied += 1
      return { kind: 'deny', reason: reasonOf(state.denied, skeletonOf()) }
    }),
  )
}
