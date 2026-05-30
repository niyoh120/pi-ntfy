# pi-ntfy — Pi 扩展项目约定

## 1. 项目定位

本仓库是 pi（`@earendil-works/pi-coding-agent`）的 **扩展（Extension）** 项目，提供 ntfy.sh 通知服务的集成能力。

扩展文件放置在 `extensions/` 目录下，通过 `package.json` 的 `pi.extensions` manifest 加载，支持 pi 的 `/reload` 热重载。作为可分发的 pi 扩展包，安装后由 package manifest 自动识别。

## 2. 编程语言与工具链

- **语言**: TypeScript（`.ts` 文件），无需编译，pi 通过 `jiti` 运行时加载
- **运行时**: Node.js >= 18
- **包管理器**: `npm`
- **核心依赖**：
  - `@earendil-works/pi-coding-agent` — 扩展类型（ExtensionAPI, ExtensionContext, Event, getAgentDir 等）
  - `typebox` — 工具参数 schema 定义（仅当需要注册工具时）
  - `@earendil-works/pi-ai` — 工具函数（仅当需要 `StringEnum`、`defineTool` 时）

> 本项目当前仅订阅事件、注册命令，不注册工具，所以实际只导入 `ExtensionAPI` 类型和 `getAgentDir` 函数。`typebox` 和 `pi-ai` 列为 peerDependencies 以备后续扩展功能。

## 3. 代码规范

### 缩进与格式
- 使用 **Tab** 缩进，宽度 2 字符
- 语句末尾加分号
- 字符串使用双引号
- 保持代码简洁，每行不超过 100 字符

### 命名约定
- **文件/目录**: kebab-case（例如 `ntfy-notify.ts`）
- **导出函数**: camelCase
- **命令名**: 不含前缀 `/`（例如 `ntfy`）
- **类型/接口**: PascalCase
- **常量**: UPPER_SNAKE_CASE

### 导入规范
```typescript
// 类型导入使用 type 关键字
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// 运行时按需引入
import { getAgentDir } from "@earendil-works/pi-coding-agent";
```

### 扩展入口结构
```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export default function extension(pi: ExtensionAPI) {
  pi.registerCommand("ntfy", { ... });
  pi.on("session_start", async (_event, ctx) => { ... });
  pi.on("agent_start", async () => { ... });
  pi.on("agent_end", async (event, ctx) => { ... });
}
```

## 4. 扩展文件结构

```
pi-ntfy/
├── extensions/
│   └── ntfy.ts              # 主扩展入口
├── package.json             # pi manifest + peerDependencies
├── AGENTS.md                # 本文件
└── README.md
```

`package.json` 必须包含 `pi` manifest 以支持 `pi install`：
```json
{
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"]
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-ai": "*",
    "typebox": "*"
  }
}
```

peerDependencies 使用 `"*"` 范围——这些包由 pi 运行时捆绑，扩展无需自行安装版本。

## 5. 构建与测试

本项目为极简 pi 扩展（单文件、无 npm 运行时依赖），暂不设 build/test/lint scripts。

- **本地测试**: `pi -e extensions/ntfy.ts`
- **类型检查**: 可后续添加 `tsc --noEmit` script
- **测试框架**: Vitest（可后续添加）

## 6. 提交信息规范

使用 **Conventional Commits** 格式：

```
<type>(<scope>): <subject>
```

类型：`feat`、`fix`、`chore`、`docs`、`refactor`、`test`、`style`

示例：
```
feat(ntfy): add file-based config and /ntfy command
feat(ntfy): add Basic/Bearer auth support for self-hosted ntfy
fix(ntfy): handle fetch timeout with AbortController
docs: add auth examples to README
```

## 7. 扩展开发约定

### 事件订阅
- `session_start` — 重置状态（防 /reload 残留）、重新加载配置文件
- `agent_start` — 记录开始时间（仅 isActive() 时）
- `agent_end` — 触发通知（仅 isActive() 且 startedAt > 0 时）

### 配置方式
- 用户级配置文件：`~/.pi/agent/ntfy.json`（路径通过 `getAgentDir()` 获取）
- 配置文件格式为 JSON，含 `enabled`、`server`、`topic`、`minSeconds`、`timeoutMs`、`auth` 字段
- 不存在或损坏时使用内置默认值
- `/ntfy` 命令通过 TUI 编辑配置并即时写入文件
- 配置修改后通过 `loadConfig()` 立即反映到内存，无需 `/reload`
- topic 为空或 `enabled === false` 时静默跳过通知

### 认证支持
- `none` — 无认证 header
- `basic` — `Authorization: Basic <base64(user:pass)>`
- `bearer` — `Authorization: Bearer <token>`
- 缺少凭据时视为未配置认证（不发送 header）

### 状态管理
- 使用模块级 `let` 变量（`startedAt`、`runtimeCfg`）跟踪运行时状态
- **不使用 `pi.appendEntry()` 持久化**（通知行为不需要跨 session 恢复）
- `startedAt = 0` 作为 guard（0 = 无有效开始时间 → agent_end 跳过）
- `session_start` 和 `agent_end` 结尾都重置 `startedAt`

### 通知发送
- 使用 ntfy publish API：`POST {server}/{encodeURIComponent(topic)}`，headers 传 Title/Priority/Tags/Authorization，body 传纯文本
- `AbortController` + `setTimeout` 超时保护（使用 runtimeCfg.timeoutMs）
- 合并 `ctx.signal` 支持 Ctrl+C abort
- `try-catch` 静默吞掉所有错误（通知失败不影响 pi）

## 8. 文件操作限制
- `~/.pi/agent/ntfy.json` 是唯一写入的外部文件
- 不修改 `.git/`、`node_modules/` 等内容

## 9. 使用方式

本地测试：
```bash
pi -e extensions/ntfy.ts
```

通过 `pi install` 安装后自动加载：
```bash
pi install /path/to/pi-ntfy
pi   # 扩展自动加载，可使用 /reload 热重载
```

`pi install` 从远程安装：
```bash
pi install git:github.com/<user>/pi-ntfy
```