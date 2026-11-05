# dsh-durable-wait

给 DSH 加一个“等到了再叫我”的持久等待。

很多任务不是不会做，而是**必须等外部事件**：等构建产物落地、等下载完成、等日志出现某一行、等子进程退出。  
普通做法是让 agent 反复 sleep 轮询，既浪费 token，也会把会话卡住。

这个插件让 agent 登记一次等待就结束当前轮次。条件成立后，DSH 会自动叫醒原会话继续干活。

- 仓库：https://github.com/Yyhy110421/dsh-durable-wait
- 许可证：MIT
- 宿主工具：wait_create、wait_list、wait_cancel
- 设置页：设置 → 守候
- 中文名：守候

## 它解决什么问题

没有这个插件时，agent 常见的坏行为是：

- 每 10 秒跑一次 `Test-Path`，把上下文烧在轮询上；
- 用 `Start-Sleep 300` 把当前回合卡死，用户没法插话；
- 浏览器或构建进程早结束了，agent 还在等；
- DSH 重启后等待丢了，任务断在半路。

装上以后：

1. agent 调用 `wait_create` 登记条件；
2. 工具立即返回，当前回合可以正常结束；
3. 插件每 2 秒检查一次，条件成立时叫醒原会话；
4. 叫醒消息带等待 ID、目标、备注，agent 继续原任务。

## 安装

在 DSH 里打开 设置 → 插件管理器，安装下面任一来源：

    github:Yyhy110421/dsh-durable-wait

或者本地目录：

    file:E:\DSH\projects\dsh-durable-wait

装完重启 DSH。用 `file:` 安装是实体拷贝，改源码后要卸载再装；插件管理器里的“更新”只适用于 npm 注册表插件，本插件不发布 npm。

## 用法

### 1. 等文件出现

    {
      "kind": "file-exists",
      "path": "E:\\build\\release\\app.exe",
      "note": "等构建产物",
      "timeoutMinutes": 30
    }

### 2. 等文件修改

    {
      "kind": "file-changed",
      "path": "E:\\logs\\build.log",
      "note": "等日志追加",
      "timeoutMinutes": 20
    }

`file-changed` 的基线是创建等待时的 mtime 和大小：

- 创建时文件已存在：mtime 或大小变化才算成立；
- 创建时文件不存在：文件出现就算成立。

### 3. 等进程退出

    {
      "kind": "process-exit",
      "pid": 12345,
      "note": "等渲染进程结束",
      "timeoutMinutes": 60
    }

只检查进程是否还存在，**不会杀进程**。  
PID 可能被系统复用；如果进程退出后 PID 立刻被别的进程占用，这个等待可能不会触发。需要强关联时，优先等产物文件或日志。

### 4. 查看和取消

    wait_list
    wait_cancel { "id": "wait-..." }

`wait_create` 返回的等待对象里带 `id`、`status`、`expiresAt`。

## 叫醒规则

条件成立后：

1. 会话在线且空闲：直接 `followup`，下一轮继续。
2. 会话在线但正在跑：保持“待叫醒”，等它空闲再叫；不会插队。
3. 会话不在线：尝试 `agents.resume` **一次**，失败就标 `undelivered`，不循环重试。
4. 自动叫醒关闭：条件成立只改状态，不叫醒。

被叫醒时消息以 `【守候】` 开头，包含：

- 等待 ID
- 条件类型和目标
- 备注
- 成立时间

agent 应该先 `wait_list` 确认，再继续原任务；不要重复创建同一个等待。

## 状态

| status | 含义 |
| --- | --- |
| active | 正在等 |
| fired | 条件已成立 |
| cancelled | 被 wait_cancel 取消 |
| expired | 超过 timeoutMinutes |

`delivery`：

| delivery | 含义 |
| --- | --- |
| pending | 条件已成立，等会话空闲 |
| delivered | 已叫醒 |
| undelivered | 叫醒失败（会话不在线且恢复失败，或 followup 抛错） |
| none | 不需要叫醒（已取消、已超时、创建时已满足、或关闭了自动叫醒） |

## 设置页

设置 → 守候：

- 默认超时（分钟）：新建等待不传 timeoutMinutes 时使用；
- 轮询间隔（秒）：2–60，默认 2；
- 最多同时等待：1–200，默认 50；
- 条件成立时自动叫醒会话：关掉后只记录状态；
- 等待列表：目标、状态、剩余时间、叫醒状态；
- 取消进行中的等待。

设置保存在 `DSH_HOME/data/durable-wait-settings.json`，等待状态保存在 `DSH_HOME/data/durable-wait.json`。  
状态落盘，DSH 重启后会继续检查；终态条目默认保留 7 天。

## 安全边界

- **只读系统**：文件类只做 `stat`，进程类只做 `process.kill(pid, 0)` 存在性检查。
- **不杀进程、不改目标文件、不读文件内容**。
- **只接受绝对路径**，避免相对路径随工作目录漂移。
- **备注限 500 字**，不要写验证码、密码、API Key。
- 最多同时 200 条等待，防止状态文件无限增长。
- 叫醒消息只包含等待目标和备注，不包含文件内容或进程输出。

## 开发

    npm test

`test/manual.mjs` 测纯逻辑：参数校验、文件快照、条件判断、PID 存活。  
`test/plugin.mjs` 测引擎：忙时排队、空闲叫醒、离线恢复一次、失败不重试、取消、设置保存。  
`test/index.mjs` 测宿主注册：三个工具、两个设置路由、系统提示段。

## 已知限制

- 进程退出用 PID 判断，存在 PID 复用误判；
- 只支持文件出现/修改和进程退出三类事件；
- 不监听文件系统事件，靠轮询，默认 2 秒；
- 会话恢复依赖宿主 `agents.resume`；某些 preset 恢复后工具集可能不完整；
- 叫醒是“下一轮用户消息”，不会打断正在执行的回合。
