# NetCore Fast 模式使用指南

面向大型 .NET / C# 单体或多项目解决方案：快速建索引、查项目依赖、猜发布服务、查 MQ 上下游。本指南对应本仓库魔改后的 `--netcore-fast` 能力，便于你本地验证。

## 能解决什么问题

| 场景 | 能力 |
|------|------|
| 改了一个类，不知道要发哪个服务 | `netcore impact` / `netcore release-candidates` 根据 `.csproj` 引用链向上找 **Host** 项目 |
| 项目之间互相引用，关系看不清 | fast index 里的 `projects`（`ProjectReference` + `referencedBy`） |
| AI 助手要查后台结构 | MCP 工具 `netcore_*` + 资源 `gitnexus://repo/{name}/netcore/...` |
| 全量 analyze 太慢、太吃内存 | `--netcore-fast`：轻量解析 + 只写 JSON，不走完整 LadybugDB / FTS / embeddings |

## 和完整 analyze 的区别

| 项目 | 完整 `gitnexus analyze` | `--netcore-fast` |
|------|-------------------------|------------------|
| 输出 | LadybugDB 图 + MCP 通用 `query`/`impact`/`context` | 主要是 `<repo>/.gitnexus/netcore-fast-index.json` |
| 调用图精度 | 较完整（含 process 等） | 精简节点，偏「文件/类/方法清单 + 项目图」 |
| 内存/时间 | 大仓库可能数小时、数十 GB | 目标：8GB 堆、分钟级（样本 `Server_DotNetCore` 约 1 分钟内） |
| parse cache | 会读写 | **不加载、不保存**（避免旧全量缓存把内存撑爆） |
| 语义搜索 | 可选 `--embeddings` | **不做** |

fast 模式仍会做 C# Tree-sitter 扫描；**不需要** `dotnet build`。项目关系来自 `.csproj` 的 `ProjectReference`，不是 MSBuild 编译结果。

---

## 前置条件

1. **Node.js**：建议 20+（本仓库在 Node 24 上验证过 C# grammar 加载）。
2. **构建 CLI**（在 GitNexus 源码仓里开发时）：

```powershell
cd C:\path\to\GitNexus\gitnexus
npm install
npm run build
```

3. **目标仓库**：你的 .NET 解决方案根目录（含多个 `.csproj` 的 git 仓库）。
4. **可选 `.gitnexusignore`**：排除 `bin/`、`obj/`、巨大生成目录，加快扫描。

---

## 第一步：建立 Fast 索引

在 **.NET 仓库根目录**执行（把路径换成你的）：

```powershell
cd C:\path\to\Server_DotNetCore

# 推荐：强制全量 + 仅索引（不写 AGENTS.md / skills）
node C:\path\to\GitNexus\gitnexus\dist\cli\index.js analyze . --netcore-fast --force --index-only
```

若已全局/本地安装 CLI，可写成：

```powershell
npx gitnexus analyze . --netcore-fast --force --index-only
```

### 常用参数

| 参数 / 环境变量 | 作用 |
|-----------------|------|
| `--netcore-fast` | 开启 fast 模式（等价 `GITNEXUS_NETCORE_FAST=1`） |
| `--force` | 忽略「已是最新」跳过逻辑，强制重跑 |
| `--index-only` | 不往 `AGENTS.md` / `CLAUDE.md` 注入统计 |
| `--worker-count N` | 解析线程数；fast 默认会倾向 **1** 以降低峰值内存 |
| `GITNEXUS_WORKER_COUNT` | 同上 |
| `GITNEXUS_WORKER_SUB_BATCH_MAX_BYTES` | 单批字节上限（fast 默认会调小） |
| `NODE_OPTIONS=--max-old-space-size=8192` | analyze 会自动尝试拉起 8GB 堆；若仍 OOM 可再加大 |

### 成功后产物

```
<你的仓库>/.gitnexus/
  netcore-fast-index.json   # 主数据：stats、projects、mq、nodes
  meta.json                 # 索引元信息（注册到 ~/.gitnexus/registry.json）
```

`netcore-fast-index.json` 结构概要：

- `stats`：文件数、节点数、边数
- `projects[]`：每个 `.csproj` 的路径、引用、`referencedBy`、是否 Host
- `mq.endpoints` / `mq.links`：MQ 生产/消费点与按 topic 聚合的链接
- `nodes[]`：精简符号（id、label、name、filePath、行号）

### Host 服务如何识别

满足其一即标记 `isHost: true`：

1. 项目目录在仓库内以 `Hosts/` 为前缀（例如 `Hosts/Foo/Bar.csproj` → `serviceName` 为 `Hosts/Foo`）
2. `.csproj` 使用 SDK `Microsoft.NET.Sdk.Web`

发布候选服务 = 从被改动的库项目沿 `referencedBy` **向上** 直到命中的 Host 项目。

---

## 第二步：CLI 查询（不启动 MCP 也能用）

以下命令默认 **当前目录** 为仓库根；也可用 `-r` 指定路径：

```powershell
cd C:\path\to\Server_DotNetCore
```

### 1. 总览

```powershell
npx gitnexus netcore summary
```

返回：项目数、Host 列表、MQ endpoint/topic 数量、已闭环 topic 数等。

### 2. 单点影响（类名 / 文件路径 / 项目名）

```powershell
# 按类名或文件
npx gitnexus netcore impact AIHelp.CommonApplication
npx gitnexus netcore impact Application/AIHelp.CommonApplication/SomeClass.cs

# 按 csproj 路径或项目名
npx gitnexus netcore impact AIHelp.CommonApplication.csproj
```

返回示例字段：

- `project`：归属 `.csproj`
- `releaseCandidates`：建议关注的 Host / 服务名
- `mq`：该文件或项目附近的 MQ 端点

### 3. MQ Topic 上下游

```powershell
npx gitnexus netcore mq OrderCreated
```

topic 会做归一化匹配（去掉 `QueueConfig`、`Consumer`、`Handler` 等后缀再比）。未精确命中时会给出 `related` 候选列表。

当前扫描的代码模式（正则，非 Roslyn）：

| 角色 | 模式 |
|------|------|
| RabbitMQ 发布 | `RabbitMQFactory.<Name>(...).PublishMsg*` |
| EventBus 发布 | `Bus.Publish(EventType.<Name>` |
| EventBus Helper | `EventBusPublishHelper.<Name>(` |
| 消费注册 | `Add*HostService<...>(`、`AddHostedService<...>`、`BindChannel(` 附近配置名 |

若你们封装命名不同，闭环率可能偏低，需要后续加规则。

### 4. 按 Git 变更猜发布服务（最贴近「改完发什么」）

```powershell
# 工作区未暂存改动（默认）
npx gitnexus netcore release-candidates

# 已暂存
npx gitnexus netcore release-candidates -s staged

# 相对某分支
npx gitnexus netcore release-candidates -s compare -b main
```

输出：

- `summary`：改动文件数、涉及项目数、候选服务数
- `releaseCandidates[]`：每个 Host 服务、关联改动文件、因哪些库项目牵进来
- `projects[]`：按库项目聚合的改动文件与对应 Host

**注意**：这是启发式结果（项目引用 + Host 规则），不是部署流水线里的权威清单；发布前仍要人工确认。

---

## 第三步：MCP（给 Cursor / Claude 等 AI 用）

### 启动 MCP

在任意目录（会服务 `~/.gitnexus/registry.json` 里已注册的仓库）：

```powershell
npx gitnexus mcp
```

Cursor 侧：执行一次 `gitnexus setup`，或手动在 MCP 配置里指向上述命令。

### 专用工具（只读）

| 工具 | 参数 | 说明 |
|------|------|------|
| `netcore_summary` | `repo?` | 同 CLI `summary` |
| `netcore_impact` | `target`（必填）, `repo?` | 同 CLI `impact` |
| `netcore_mq` | `topic`（必填）, `repo?` | 同 CLI `mq` |
| `netcore_release_candidates` | `repo?`, `scope?`, `base_ref?` | 同 CLI `release-candidates` |

`repo` 可以是注册名或仓库绝对路径。

### 专用资源（不拉全量 nodes）

| URI | 内容 |
|-----|------|
| `gitnexus://repo/<注册名>/netcore` | summary YAML |
| `gitnexus://repo/<注册名>/netcore/projects` | 项目依赖图 |
| `gitnexus://repo/<注册名>/netcore/mq` | MQ endpoints + links |

### 给 AI 的提示词示例

```
请先 netcore_summary 看我的 .NET 仓库有多少 Host。
我改了 Application/XXX/FooService.cs，请 netcore_impact target="FooService" 并列出 releaseCandidates。
再 netcore_release_candidates scope="unstaged" 对比 git 改动，合并成一份发布 checklist。
```

通用 GitNexus 工具（`gitnexus_query`、`gitnexus_impact` 等）依赖 **完整 LadybugDB 索引**；仅跑过 `--netcore-fast` 时，请优先用 `netcore_*` 系列。

---

## 推荐验证流程（你「找时间试一下」可按此走）

1. **建索引**  
   `analyze . --netcore-fast --force --index-only`  
   记录耗时、任务管理器内存峰值。

2. **看结构**  
   `netcore summary` → 确认 `hosts` 数量是否符合预期。

3. **挑一个你常改的类**  
   `netcore impact <类名>` → 看 `releaseCandidates` 是否是你会部署的服务。

4. **本地改几行代码不提交**  
   `netcore release-candidates` → 对比你心里想的发布列表。

5. **挑一个 MQ 配置名**  
   `netcore mq <topic>` → 看 provider/consumer 是否成对。

6. **（可选）Cursor 里**  
   让 Agent 调 `netcore_release_candidates`，看能否生成发布说明草稿。

### 样本命令（PowerShell）

```powershell
$repo = "C:\path\to\Server_DotNetCore"
$cli = "C:\path\to\GitNexus\gitnexus\dist\cli\index.js"

node $cli analyze $repo --netcore-fast --force --index-only
Set-Location $repo
node $cli netcore summary -r $repo
node $cli netcore impact "你的类名" -r $repo
node $cli netcore release-candidates -r $repo
```

---

## 已知限制（验证时心里有数）

1. **不是 dotnet build 依赖分析**：`ProjectReference` 路径解析错误时，上游 Host 会偏。
2. **调用链简化**：fast 模式不做完整 call graph / execution flow；深度「谁调谁」仍要用全量 analyze 或人工跟代码。
3. **MQ 靠正则**：未匹配到的发布/订阅不会出现在 `mq.links`；topic 归一化可能把不同业务 topic 误合并，需人工核对。
4. **跨仓库**：单仓库 fast index 不包含 group 级 `gitnexus group sync`；多 repo 微服务要另配 group（见 [microservices-grpc.md](./microservices-grpc.md)）。
5. **增量更新**：fast 模式会写 `meta.json`，但策略偏「force 全量重跑」更稳；日常 CI 可固定 `--netcore-fast --force`。
6. **与 AGENTS.md 里 GitNexus 统计**：`--index-only` 不会更新文档里的 symbol 计数；MCP 通用资源可能显示「索引存在但图较空」——以 `netcore_*` 为准。

---

## 故障排查

| 现象 | 处理 |
|------|------|
| `netcore-fast-index.json` 不存在 | 先成功跑完 `analyze --netcore-fast` |
| analyze OOM | 加 `--worker-count 1`；`NODE_OPTIONS=--max-old-space-size=8192`；删 `.gitnexus/parse-cache` 后 `--force` |
| C# 文件全被 skip | 检查 tree-sitter-c-sharp 是否装好；`npm install` 在 `gitnexus/` 重试 |
| `impact` 找不到项目 | 用 `.csproj` 名、相对路径或 `netcore summary` 里的 `hosts` 路径再试 |
| `release-candidates` 为空 | 确认在 git 仓库内、改动扩展名为 `.cs` 等会被 diff 列出的文件 |
| MCP 工具报错找不到 repo | `gitnexus list` 看注册名；`analyze` 时可用 `--name MyBackend` |

---

## 和「公司一人全栈」工作流怎么接

1. **Morning**：`analyze --netcore-fast`（或 nightly CI 生成 index 提交 artifact 到 `.gitnexus/`——需你们自定策略）。
2. **开发中**：改代码 → `netcore release-candidates` → 复制 `releaseCandidates` 到发布单 / 飞书。
3. **AI 结对**：Cursor 规则里写一句：「改 .NET 后台前必须先 `netcore_impact` 或 `netcore_release_candidates`」。
4. **仍要深度 review**：对高风险改动再跑全量 `analyze`（无 `--netcore-fast`）+ 原有 `gitnexus_impact`。

---

## 相关源码（便于二次魔改）

| 文件 | 作用 |
|------|------|
| `gitnexus/src/core/run-analyze.ts` | fast 写 index、`discoverNetcoreProjects` / `discoverNetcoreMq` |
| `gitnexus/src/core/netcore-fast-index.ts` | 加载与查询逻辑（CLI + MCP 共用） |
| `gitnexus/src/cli/netcore.ts` | CLI 子命令 |
| `gitnexus/src/mcp/tools.ts` | MCP 工具定义 |
| `gitnexus/src/mcp/local/local-backend.ts` | MCP 实现 |
| `gitnexus/src/mcp/resources.ts` | MCP 资源 URI |

---

## 变更记录

| 日期 | 说明 |
|------|------|
| 2026-05-25 | 初版：fast 索引、CLI `netcore`、MCP `netcore_*`、release-candidates |
