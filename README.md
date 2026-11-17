# 修订可证明的物化缓存（Revision-Proof Cache）

服务端物化聚合结果 + 浏览器下载缓存，两者都绑定到可验证的版本证明；源记录
修订后沿依赖关系失效。**失效通知丢失时，读取路径会失败关闭（fail closed），
绝不长期把已知过期的数据当作最新返回。**

```
┌──────────────┐   写记录   ┌──────────────┐   durable outbox   ┌───────────────┐
│  网页 / API  │ ─────────▶ │  SQLite 源表 │ ─────────────────▶ │  失效接收器   │
│ (源记录编辑) │            │  + 变更序号  │                    │ (独立进程/循环)│
└──────────────┘            └──────────────┘                    └───────┬───────┘
                                    ▲                                   │ 按依赖标记
                                    │ 快照读取                          ▼
                            ┌───────┴────────┐   发布代次 gN     ┌───────────────┐
                            │   缓存构建器   │ ────────────────▶ │ 磁盘物化产物  │
                            │ (独立进程/循环)│  原子 rename      │ + manifest    │
                            └───────┬────────┘                   └───────┬───────┘
                                    │ onPublished                        │
                                    ▼                                    ▼
                            ┌──────────────────────────────────────────────────┐
                            │ 结果服务：读时重算证明 + 水位线/全量校验 + 下载缓存 │
                            └──────────────────────────────────────────────────┘
```

三个角色在代码里是三个独立组件（`src/cache/invalidator.js`、
`src/cache/builder.js`、`src/cache/result-service.js`），可分别以独立进程运行，
只通过 SQLite 与产物目录通信。

---

## 1. 可验证的策略：水位线 + 定期全量校验

每次读取都携带一份**读取时重新计算**的版本证明（`result-proof-v1`），
而不是复制构建时看到的数字。证明里有：

| 字段 | 含义 |
| --- | --- |
| `outputDigest` | 聚合输出的规范 JSON 的 SHA-256 |
| `depsDigest` | 该聚合**能观察到**的源切片（相关字段 + 过滤成员关系 + 记录 id） |
| `dataHash` | 磁盘产物字节的 SHA-256 |
| `builtSeq` / `requiredSeq` | 产物快照序号 / 要求达到的序号（持久水位线） |
| `generation` / `buildId` | 产物代次与构建标识 |
| `readSeq` | 本次读取时的全局变更序号 |
| `proofHash` | 上述内容的规范化哈希 |

读取路径做两级检查：

1. **低成本水位线（每次读取）**
   `requiredSeq <= builtSeq` 且产物命名空间等于当前配置版本。
   水位线（`spec_state.required_seq`）与记录写在**同一个事务性存储**里，
   因此任何被投递过的失效都会推进它；只有被消费的失效才会推进，
   未消费的 outbox 事件会让读取直接走全量校验（`invalidationLag > 0`）。
2. **高成本全量校验（有界间隔，默认 2s / 每次源变化）**
   从源表重算一次聚合并比较 `outputDigest` 与 `depsDigest`。
   这是"通知从未到达数据库"的兜底。结果按（聚合，代次，源序号）缓存，
   N 个读者只付一次聚合成本。

`GET /api/specs/:id/result?policy=watermark|strict`

- `watermark`（默认）：水位线检查 + 有界间隔的全量校验。**不会**返回已知过期的字节。
- `strict`：每次读取都做全量校验，用于对账与演示。

读取结果只有三种：`200 fresh`（附证明）、`409 stale`（附证明与原因）、
`503 miss`（并自动排入重建）。**没有"静默返回旧数据"这条路径。**

### 成本 vs 正确性

| 策略 | 每次读取成本 | 能发现 | 遗漏 |
| --- | --- | --- | --- |
| 仅水位线 | 两次索引查找 | 任何被投递的失效、积压未消费事件 | 从未写入 outbox 的越权修改 |
| 水位线 + 定期全量 | 摊薄的一次聚合 | 同上 + outbox 完全丢失 | 校验间隔内的窗口（默认 2s） |
| 每次全量（strict） | 一次聚合 | 全部 | 无（代价最高） |

---

## 2. 修订后沿依赖关系失效

依赖字段 = 分组字段 ∪ 过滤字段 ∪ 指标所读的数值字段。
`name` / `notes` 不在其中：改名字**不会**重建任何缓存（有测试证明代次不变）。

失效判定基于**前后真实快照**，而非写入方声明的字段列表：

- 记录出现/消失且（曾）在筛选范围内 → 失效
- 在/不在筛选范围发生变化 → 失效
- 在范围内且任一依赖字段变化 → 失效
- 完全在范围外，或只改了不依赖的字段 → 不失效

判定逻辑：`src/cache/dependencies.js`，测试：`test/invalidation.test.js`。

---

## 3. 四种难场景

### 重建中再次修订

构建先取快照（`snapshotSeq`），构建期间的新修订把 `requiredSeq` 推得更高。
旧构建发布后 `stillStale=true`，泵循环立刻用更新的快照再建一次。
**读者在追上之前始终看到 409 stale**，不会看到半新半旧的结果。
（`test/rebuild-races.test.js` 第 1 例）

### 旧重建晚完成

代次在快照前分配；发布时在**文件锁**内比较"快照序号 + 代次"：
较旧的快照或相同快照下的更小代次一律被拒绝，标记为 `superseded`，
产物指针不动。因此服务的字节**永远不会倒退**。
（`test/rebuild-races.test.js` 第 2 例，使用第二个 app 实例模拟第二个构建进程）

### 下载中途失效

下载被**钉在代次 gN** 上：

- 尚未开始传输的下载在发布新代次时立即作废（没有理由再发已知过期的字节）。
- 已开始传输的允许把 gN 的字节传完（这些字节内部自洽）；完成时服务端
  重新校验哈希与长度，并标记 `superseded`、给出 `currentGeneration`，
  客户端必须重新下载才能声称最新。
- 中断后可 `resume`，但跨代次会被 409 拒绝。
- 客户端上报的哈希/长度不符 → 422，并记录失败，服务端自己的副本不被信任为
  "客户端说对就对"。

（`test/downloads.test.js` 全部 6 例）

### 失效通知丢失

- **消费者暂停**（网页"断开通知"）：源写入继续进 outbox，`invalidationLag>0`，
  读取立即转为全量校验并返回 409，恢复后自动处理积压并重建。
- **事件被彻底丢弃**（消费者提交游标却未应用）：水位线不会推进，
  定期全量校验发现 `full-verify-mismatch`，自动排入重建。
  也可手动重建恢复。
- **产物字节损坏**：`readVerified` 哈希校验失败视为不存在，读取返回 503 并
  触发重建；坏字节永远不会被当作权威结果。

（`test/lost-notifications.test.js`、`test/rebuild-races.test.js` 第 5 例）

---

## 4. 配置变更与命名空间

缓存键：`<specId>#v<configVersion>#<configHash 前 12 位>`

任何配置修改都会提升 `configVersion` 并产生**全新的磁盘命名空间**，旧产物保留为
历史版本。构建期间改配置时，旧构建只会写入它自己的历史命名空间，
**不能**推进现网水位线（`test/rebuild-races.test.js` 第 3 例）。

---

## 5. 运行

```bash
npm start                 # 默认 http://127.0.0.1:4173，数据在 ./data
node src/server.js /tmp/mydata 8080
npm run seed /tmp/mydata  # 从空目录写入 24 条记录与 3 个聚合并校验
npm run demo              # 终端演示全部失效场景
npm test                  # 30 个测试
node scripts/e2e-dom.mjs  # 或 npm run e2e：在 jsdom 中执行真实 public/app.js 的 26 项断言
```

需要 Node ≥ 22.5（使用内置 `node:sqlite`），**零运行时依赖**。
`scripts/e2e-dom.mjs` 需要 `jsdom`（devDependency，`npm i` 后可用）。

首次启动的空目录会显示空列表；用网页"新增记录 / 新增聚合"或 `npm run seed`
即可从零生成真实聚合与缓存文件。产物目录结构：

```
data/
  app.sqlite                       # 源记录、修订历史、水位线、outbox、下载记录
  artifacts/<specId>/v<n>/<hash>/
    current.json                   # 发布指针（含快照序号）
    g<generation>/
      manifest.json                # 构建信息 + 数据文件哈希
      data-<hash16>.json           # 物化结果（含内嵌证明）
```

---

## 6. 接口速查

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | 记录 + 聚合（含水位线、发布摘要） |
| POST/PATCH/DELETE | `/api/records[/:id]` | 源记录写入，支持 `expectedRevision` 乐观锁 |
| GET | `/api/records/:id/history` | 修订历史 |
| POST/PATCH | `/api/specs[/:id]` | 聚合定义，配置变更自动升版本 |
| GET | `/api/specs/:id/result?policy=` | 读取结果 + 版本证明（fresh / 409 / 503） |
| GET | `/api/specs/:id/verify` | 字节级全量校验，逐项返回 checks |
| GET | `/api/specs/:id/dependencies` | 依赖字段与受影响记录 |
| POST | `/api/specs/:id/build` | 手动重建，可注入延迟/失败做竞态演示 |
| POST | `/api/specs/:id/downloads` | 创建钉住代次的下载 |
| GET | `/api/downloads/:id/file` | 下载钉住的字节（带代次/哈希响应头） |
| POST | `/api/downloads/:id/complete` | 客户端哈希/长度核对，返回是否 superseded |
| GET | `/api/notifications` | 持久化失效通知流 |
| GET | `/api/heartbeat` | 序号、积压、水位线（断线时证明源仍在推进） |
| POST | `/api/invalidator/pause` / `resume` | 断开/恢复失效消费 |
| GET | `/events` | SSE：失效通知与产物发布 |

---

## 7. 网页能力

- 编辑/新增/删除源记录（带修订号与冲突提示）
- 每个聚合展示：证明徽标、校验方式、代次、构建/要求/读取序号、
  输出摘要、依赖切片摘要、产物哈希、证明哈希、行数、配置版本
- 读取策略切换（watermark / strict）、重建、字节级校验、依赖视图
- 浏览器下载缓存：进度条、代次、哈希一致/已过期徽标
- 断开通知 → 修改数据 → 恢复通知：可见失效通知、日志与自愈过程

---

## 8. 取舍与已知边界

- **明确不做的**：跨字段统计（如 distinct count 的 HLL 近似）不参与
  `depsDigest` 的字段级依赖，配置里也没有这类指标，因此不构成缺口。
- **全量校验的窗口**：`watermark` 策略在两次全量校验之间有窗口（默认 2s，
  可配置）。需要零窗口时用 `policy=strict`。
- **单机 SQLite**：写入串行化在单个 `BEGIN IMMEDIATE` 事务里。多进程安全依赖
  SQLite 的文件锁与产物目录的文件锁；跨主机署需要换成共享存储。
- **代次全局递增**（`meta.last_generation`），便于观察与对账；不同聚合之间不共享产物。
- **名称/备注不进依赖**：这是有意为之，且有测试锁定该行为。
