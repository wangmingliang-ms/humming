# 用设计降低实现复杂度：Conversation Card 生命周期案例

**日期：** 2026-07-12

**主题：** 从局部修补转向领域建模，以更少的代码获得更简单、更鲁棒的实现

## 案例摘要

Conversation Card 生命周期最初是以功能和故障为单位逐点实现的：出现一个场景，
增加一段状态、分支或补偿逻辑；出现一个竞态，再增加一个标记、回调或时序保护。
每个改动在局部都可能合理，但系统没有统一回答“这些对象是什么、谁拥有状态、
哪些状态转换合法、谁是唯一事实来源”等全局问题。

结果是业务语义散落在 Gateway、Runtime、ACP Client、Presenter、定时器和 Card Action
路由中。同一张 Card 可能被多个组件理解和修改，`status`、`entries`、`meta`、
`cancellable` 等字段又可以独立组合，于是大量本应不可能的状态进入了运行时。

后来的关键转变不是继续修复某个 Bug，而是暂停实现，先建立统一的领域模型和规范：

```text
Topic
└── Turn[]
    ├── Request
    └── Response
        └── Card[] (ordered)
```

在这个模型中，Card 不再独立决定生命周期。Card 只是 Response 的投影；Topic 只允许
一个 Response 拥有执行权；一个 Response 只允许最后一张 Card 作为 tail；Cancel 权限
由执行所有权和 tail 身份推导，而不是由散落的布尔字段共同决定。

模型建立后，原先复杂的控制逻辑可以被更直接的对象关系、状态转换和投影规则替代。
决定性的切换提交 `36114f4` 增加 943 行、删除 3642 行，净减少 2699 行。减少的不只是
代码量，更是系统需要同时考虑的状态组合与分支数量。

## Spec 演进：两代设计的关键差异

相关设计文档保留在项目中：

- 最早的局部方案：
  [`2026-07-11-card-patch-failure-rollover-design.md`](./superpowers/specs/2026-07-11-card-patch-failure-rollover-design.md)
- 第一代语义生命周期设计：
  [`2026-07-12-conversation-card-semantic-lifecycle-design.md`](./superpowers/specs/2026-07-12-conversation-card-semantic-lifecycle-design.md)
- 最终规范：
  [`conversation-card-lifecycle.md`](./superpowers/specs/conversation-card-lifecycle.md)

### 阶段一：围绕 Card 交付故障设计

最初的问题是 Feishu 拒绝 patch 后，旧 Card 停留在错误状态并持续产生失败。方案以
`HummingClient` 和 `ConversationCardDelivery` 为中心，引入 active、abandoned、
replacement pending、epoch 和 single-flight replacement 等传输状态。

这个方案能够解决“某张 Card patch 失败后如何换一张 Card”，但它回答的仍然是一个
局部技术问题。`HummingClient` 继续拥有 timeline 和生命周期语义，Prompt、Response、
Card 以及执行所有权之间的领域关系并没有被建立。

### 阶段二：以 Prompt/Card 状态机为中心

第一代完整设计进一步引入了：

- 每条用户消息一个 `PromptCardLifecycle`；
- `PromptToken`、`SegmentToken`、`ActionToken`、`PermissionToken` 和
  `OwnershipToken`；
- `receipt / queued / interrupting / preparing / active / awaiting_permission /
archived / terminal` 等状态；
- reducer、effect、controller、delivery owner 和 presenter view；
- 单写者、事件排序、终态吸收和 action token 撤销。

这套设计已经比原始实现严谨很多，也能排除大量非法状态。但是它仍然把“一个 Prompt
的 Card 生命周期”作为顶层抽象。跨 Prompt 的问题——谁占用 Topic 的 Agent 执行槽、
新消息如何打断旧 Response、多条消息如何合并、Card Cancel 和 `/cancel` 的作用域有何
不同——仍然需要在多个 Prompt Controller 之外协调。

因此，虽然局部状态机很完整，整体实现仍需要大量事件、Token、Ownership generation
和编排分支。它是一次重要改进，但还没有找到最能解释业务的领域边界。

### 阶段三：以 Topic/Turn/Response 数据模型为中心

最终规范首先定义的不是 Card 状态，而是领域关系：

```text
Topic
└── Turn[]
    ├── Request
    └── Response
        └── Card[] (ordered)
```

在这个模型中：

- `TopicConversation` 是聚合根，统一维护 Topic 级不变量；
- 每条用户消息形成一个 `Turn = Request + Response`；
- Agent 的一次处理生命周期属于 `Response`，而不是 Card；
- Card 只是 Response 的有序显示切片和确定性投影；
- Topic 显式保存唯一的 `executionOwnerResponseId`；
- Response 的最后一张 Card 是 tail，其余 Card 自动成为不可操作的 intermediate；
- `CancelAuthority` 由 Response 所有权和 tail 身份推导；
- `PendingRequestBatch` 显式表达打断期间收集的消息及最新 carrier Response；
- Permission 是独立 artifact，不再扭曲 Response Card 的所有权。

### 两代完整设计对照

| 维度         | 第一代 Prompt/Card 生命周期                      | 最终 Topic/Response 模型                  |
| ------------ | ------------------------------------------------ | ----------------------------------------- |
| 顶层抽象     | 单个 Prompt 的 Card Controller                   | 整个 Topic 的 Conversation 聚合           |
| 核心生命周期 | Card segment 的状态变化                          | Response 的执行生命周期                   |
| Card 的角色  | 生命周期状态本身                                 | Response 状态的显示投影                   |
| 跨消息协调   | 多个 Controller 外部编排                         | Topic 聚合内部维护                        |
| 执行所有权   | Ownership Token 和编排规则隐式协调               | `executionOwnerResponseId` 显式表达       |
| 多条打断消息 | 依赖 queued/interrupting 事件组合                | `PendingRequestBatch` + carrier Response  |
| Cancel       | Action Token 绑定 Prompt/Segment                 | Response-scoped authority，由聚合统一验证 |
| Permission   | Prompt 状态机中的特殊阶段和交接                  | Response 下的独立 Permission artifact     |
| UI 规则      | 多种 Card View union 分支                        | 从 response + tail + owner 统一投影       |
| 主要复杂度   | reducer、effect、controller、delivery generation | 对象关系、少量状态转换、确定性投影        |

最关键的变化是：**第一代在努力设计一套更安全的控制流，最终版则先设计了正确的数据
模型。** 当 Topic、Response、Card 及其所有权关系被准确表达后，原来需要控制流维持的
许多规则，变成了对象结构天然具有的不变量。

## 1. 原来的情况

### 1.1 功能实现：围绕场景逐点增加逻辑

早期实现主要从可见功能出发：

- 收到消息后展示处理中状态；
- Agent 输出时持续更新 Card；
- 内容过长、等待超时或遇到 Permission 时切换 Card；
- Prompt 完成、失败、中断或取消时更新最终状态；
- Feishu patch 失败时创建替代 Card；
- 新消息打断旧任务时转移 Cancel 和执行权。

这些能力分别落在不同模块中，通过回调、计时器、布尔标记、Token、Card ID 和异步
patch 连接起来。实现关注的是“这个场景下一步做什么”，而不是“领域中有哪些对象，
状态属于谁，以及对象之间允许发生什么”。

### 1.2 问题出现：缺少统一语义和唯一所有者

主要问题不是某一段代码写错，而是缺少全局模型：

- 生命周期语义分散，多个模块都能改变同一张 Card 的含义；
- Card 的状态和操作权由多个可独立变化的字段表达，非法组合很容易出现；
- 业务状态与 Feishu 网络 patch 的成功或失败耦合；
- Prompt、Response、Card、Permission 和执行所有权的边界不清；
- 异步回调不知道自己属于哪一代 Response 或 Card；
- 终态没有在模型层成为不可逆状态，迟到事件仍可能覆盖最终结果。

因此会出现历史 Card 仍可取消新任务、终态被迟到的 running render 覆盖、多个 Card
同时看起来可操作、Prompt 已结束后又出现 Waiting Card 等矛盾状态。

### 1.3 修复困境：局部正确导致全局回归

在没有统一模型时，修复只能围绕现象增加条件：

- 为阻止一个迟到回调，增加一个标记；
- 为处理另一个异常顺序，再增加一个 generation 或 guard；
- 为兼容 patch 失败，增加替代路径和回滚逻辑；
- 为避免旧 Cancel 生效，在多个入口重复检查状态；
- 为修复一个时序，把等待或所有权转移到另一个模块。

这些修复通常只覆盖当前复现路径。一个分支被压下去，另一个分支又因为状态共享、
异步竞态或所有权不明确而冒出来。测试也逐渐围绕实现细节膨胀，却仍难以证明全局
不变量。

### 1.4 严重后果：分支爆炸与代码膨胀

最终表现为：

- Controller 和 Lifecycle reducer 体积持续增大；
- 状态、传输、渲染、路由和补偿逻辑互相穿透；
- 同一业务规则在不同入口重复实现；
- 为了兼容旧路径，需要保留更多并行状态与特殊分支；
- Bug 层出不穷，修复成本和回归风险不断上升；
- 代码量增长，但系统可解释性和可靠性没有同步提升。

## 2. 后来的改进

### 2.1 解决方式：先定义概念、关系和不变量

改进过程先停止追逐具体 Bug，转而完成以下设计：

1. **建立概念模型：** 明确 Topic、Turn、Request、Response、Card、Permission、
   Execution Owner 和 Cancel Authority。
2. **明确对象关系：** 一个 Turn 对应一个 Request 和一个 Response；一个 Response
   拥有有序 Card；Card 只是 Response 的显示投影。
3. **定义唯一所有者：** Topic 同一时刻最多只有一个 Execution Owner Response；
   生命周期状态只由聚合对象修改。
4. **定义状态机和不变量：** terminal 不可逆；只有 Response tail 可以显示标题和
   Metadata；只有拥有执行权的 in-progress tail 可以拥有 Cancel Authority。
5. **分离语义与外部副作用：** 领域状态转换立即完成；Feishu patch 只是对状态的
   展示，失败不能回滚业务语义。
6. **建立投影层：** Presenter 不再自行判断生命周期，而是渲染由领域快照推导出的
   合法 View。
7. **最后再连接应用服务：** `TopicConversationSession` 负责把 ACP 回调和 Feishu
   Action 翻译成领域命令，不再成为第二套业务状态机。

这使实现从“在所有路径中维护许多彼此相关的字段”，转变为“让少量领域对象维护自身
不变量，再从当前数据推导视图”。

### 2.2 效果：状态空间缩小，问题更容易定位

重构后的直接效果包括：

- 非法状态被类型和对象边界提前排除，而不是等到渲染时补救；
- 执行权、Cancel 权限和 Card tail 都有唯一来源；
- 终态吸收迟到事件，旧 Action Token 无法影响新 Response；
- Feishu patch 失败只形成展示诊断，不再污染业务生命周期；
- View 是数据的确定性投影，同一快照不会得到互相矛盾的 UI；
- 出现 Bug 时，可以沿“输入命令 → 聚合状态 → 快照 → 投影 → 传输”单向溯源；
- 测试可以围绕状态转换和不变量，而不是穷举所有实现分支。

### 2.3 核心原因：复杂度从控制流移入了正确的数据模型

改进并不是简单地“把函数改成类”，也不是面向对象本身自动解决了问题。真正有效的
是让代码结构忠实表达领域事实：

- 哪些概念真实存在；
- 每个概念拥有什么数据和能力；
- 哪个对象有权改变哪些状态；
- 对象之间是什么关系；
- 哪些不变量在任何路径下都必须成立；
- 哪些结果可以从已有数据推导，不应被重复存储。

当这些问题有了明确答案，大量 `if`、并行布尔状态、回滚补偿和跨模块协商就不再需要。
因此，代码减少是设计变简单后的结果，而不是重构的目标本身。

## 3. 可复用的经验

复杂 Feature 不应直接从任务列表进入编码。更可靠的顺序是：

```text
业务场景
  -> 领域概念
  -> 概念关系与所有权
  -> 状态、能力和不变量
  -> 模块边界与依赖方向
  -> 外部副作用边界
  -> 实现与测试
```

尤其当一个功能同时具有异步事件、多生命周期、外部系统、并发或失败恢复时，应先问：

1. 系统中的核心实体和值对象是什么？
2. 谁拥有生命周期，谁只是观察者或投影？
3. 哪些数据是唯一事实来源，哪些数据可以推导？
4. 哪些状态组合必须从结构上变得不可表达？
5. 哪些转换合法，终态是否不可逆？
6. 外部失败会改变业务事实，还是只影响事实的展示？
7. 每个模块允许知道什么、修改什么？

## 4. Design-First Skill 构想

这个案例可以沉淀为一个面向 AI 编程的 **Design-First Skill**。它不应一收到需求就
生成代码，而应先帮助用户和 AI 共同建立足够完整的全局模型。

### 4.1 Skill 的目标

在复杂功能进入实现前，引导完成四件事：

1. **理解整体架构：** 现有模块、依赖方向、数据流和外部系统边界。
2. **识别问题领域的概念：** 找出真实存在的实体、值对象、事件、状态和服务。
3. **定义概念之间的关系：** 明确包含、引用、所有权、生命周期和基数关系。
4. **分配能力与责任：** 明确每个概念能做什么、不能做什么，以及谁维护不变量。

### 4.2 建议的引导流程

Skill 可以分为六个阶段，并在前一阶段没有形成稳定结论时阻止过早编码：

| 阶段       | AI 引导的问题                              | 产物                |
| ---------- | ------------------------------------------ | ------------------- |
| 架构扫描   | 功能经过哪些模块、入口、存储和外部系统？   | Context Map、数据流 |
| 概念发现   | 需求中的名词、事件和生命周期分别是什么？   | 领域词汇表          |
| 关系建模   | 谁包含谁、谁引用谁、谁拥有谁？             | 概念关系图          |
| 能力分配   | 哪个对象执行行为并维护规则？               | 职责与能力表        |
| 不变量设计 | 什么必须永远成立，哪些状态必须不可表达？   | 状态机、不变量清单  |
| 实现映射   | 概念如何映射到模块、类型、类、接口和测试？ | 模块设计与实现计划  |

### 4.3 Skill 的关键约束

- 不把用户需求中的每个名词机械地变成一个类；
- 不预设必须使用面向对象，允许使用代数数据类型、纯函数或状态机；
- 类和模块的划分必须来自所有权、生命周期和不变量，而不是代码长度；
- 对可推导状态不重复存储，避免制造新的同步问题；
- 在设计中明确正常路径、异常路径、并发路径和外部失败边界；
- AI 在编码前必须复述模型，并说明每个核心规则由哪里保证；
- 实现完成后，必须反向检查代码是否仍符合概念模型，而不只是测试通过。

### 4.4 Skill 的完成标准

当以下问题都有清晰且一致的答案时，才进入编码：

- 是否存在统一的领域词汇？
- 是否能画出核心概念及其关系？
- 每份可变状态是否只有一个明确所有者？
- 是否列出了关键生命周期和合法转换？
- 是否列出了必须始终成立的不变量？
- 业务语义是否与网络、存储、UI 等副作用分离？
- 模块依赖方向是否单向、可解释？
- 测试是否能围绕模型和不变量组织？

这个 Skill 的核心价值不是替 AI 做更多设计文档，而是改变 AI 的默认工作方式：
从“看到问题立即补代码”，转变为“先建立全局模型，再用代码表达模型”。
