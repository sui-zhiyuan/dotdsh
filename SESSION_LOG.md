# dotdsh 仓库重构会话记录（Session Log）

> 用途：环境切换后的上下文恢复。本文件记录了一次完整的设计讨论与重构过程：
> 从"如何把本机插件加载进 dsh"的机制梳理，到对原仓库架构（applist + store + 生成器）
> 的推倒重来，再到最终形态（纯插件包 + 单一手写 patch + dotdsh_dev 单脚本）的落定。
> 讨论语言为中文，本记录保持中文。

---

## 0. 环境事实（会话当时的快照）

| 项 | 值 |
|---|---|
| 工作区 | `/home/suine/projects/dotdsh` |
| 活跃 profile | `web`（`~/.dsh/profiles/web/`，bundles: `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`，`patchReload: live`） |
| dsh CLI | `/home/suine/.npm/_npx/1e7f6d9597241db0/node_modules/.bin/dsh`（npx 安装锚点） |
| pnpm | v12.2.1（bin 在 `/home/suine/.local/share/pnpm/bin/`，含 `pnx` 与 `pnpx`） |
| uv / Python | uv 于 `/home/suine/.local/bin/uv`；venv 用 CPython 3.11.15；系统 Python 3.12.3 |
| uv 缓存 | 仓库根 `uv.toml` 指定 `cache-dir = "target/python/uv-cache"`（沙箱友好） |
| 沙箱策略 | `workspace-write`（只能写工作区；`~/.cache/uv` 不可写，故重定向缓存） |
| 网络环境 | 用户侧 Clash Verge（mihomo）TUN，DNS 指向 `10.255.255.254`。**已开启「DNS 覆写」并把增强模式由 fake-ip 切为 redir-host**：fake-ip 时代所有域名解析到 `198.18.0.1/16`，被 DSH `web_fetch` 的 SSRF 守卫（硬编码在 `dsh-web-fetch-http`，无配置开关）判为"非公网 IP"而拒绝；切 redir-host 后 `web_fetch` 恢复。另注意：**代理节点必须在线**，否则境外流量会在 TLS 阶段被重置（表现为 `SSL_ERROR_SYSCALL`），与 DNS 模式无关 |

---

## 1. dsh 机制要点（全部经源码验证，非猜测）

这些是从 `@deepseek-ai/dsh`、`@deepseek-ai/dsh-app-boot` 等安装包源码中确认的事实，
是本次重构的决策基础。

### 1.1 patch 层与合成顺序

- boot 时 loader 按序合成 `cordis.yml`（`dsh-app-boot` 的 `composeProfile`）：
  **bundle 层（`dsh.profile.bundles` 顺序）→ profile 用户层 → `$DSH_HOME/cordis.patch.yml` → `--patch` overlay**。
- `cordis.yml` 每次 boot 重写，**绝不手编、绝不提交**。
- patch 条目语义：`{insert: [{id,name,config}]}` 插入行；`{id, disabled}`/`{id, config}` 按 id 覆盖；
  同 id 后写胜出；`config` 整块替换（不深合并）。
- **bundle** = `package.json` 声明 `"dsh":{"bundle":{"patch":"./cordis.patch.yml"}}` 的 npm 包，
  即"携带一层 patch"的插件形态（dsh 官方 `dsh-base`/`dsh-web-app` 都是这个形态）。

### 1.2 `dsh plugin --profile <n> install`

源码定性为 **"thin pnpm forwarder"**：在 profile 目录跑 `pnpm <args...>`，然后
**按安装结果 reconcile** `dsh.profile.bundles`——依赖解析到声明了 `dsh.bundle` 的包就加入层列表
（按依赖顺序追加），掉声明/被移除的条目退出。按安装状态而非依赖 diff 调和，所以包升级后
新增 bundle 声明也会自动激活。

### 1.3 热更新边界（关键）

- `patchReload: live` 时，boot 通过 Cordis HMR 注册**精确路径** watcher，只监听两个文件：
  profile 用户层（`$DSH_HOME/profiles/<n>/cordis.patch.yml`）和 home 层（`$DSH_HOME/cordis.patch.yml`）。
- `composeLive` 里的 `bundlePatches` 是 boot 快照——**bundle 层改动必须重启 dsh**。
- watcher 是精确路径 watch：**覆盖用户层文件必须原地写（truncate+write），不能 rename**
  （`shutil.copy2` 是原地写，安全；`os.replace` 会丢 watcher）。
- `--patch <file>` 是 **boot 参数 overlay**（作用于新启动的进程，`dsh web --patch x.yml` 同理），
  **不能注入正在运行的进程**。

### 1.4 boot 读哪些 package.json

三类：① profile 自己的 `package.json`（bundles 列表、patchReload；缺失则用模板 `initProfile` 自举）；
② 每个 bundle 包自己的 `package.json`（查 `.dsh.bundle.patch` 定位 patch 文件，缺则启动报错）；
③ 模块回退闭包中每个包的 `package.json`（建符号链接树用）。

### 1.5 模块解析结构（两个 node_modules）

- `~/.dsh/profiles/node_modules/` = **共享模块回退树**（module fallback generation）：
  boot 的 `healProfilesModuleFallback` 从 CLI 安装锚点（本机 npx 根）做依赖闭包遍历，
  为每个包名建符号链接。Node 向上查找规则使**任何 profile 都能解析到整套 harness 包**，
  profile 自己不需要装。
- `~/.dsh/profiles/<n>/node_modules/` = **该 profile 自己的解析槽**：
  pnpm 安装的产物 + boot 为"CLI 闭包不携带的 bundle"补的 owned 链接
  （链：`node_modules/X → .dsh-module-fallback/node_modules/X → 真实包`）。
  比共享树更近，优先遮蔽。
- `link:` 依赖只本地化包本身，**其依赖图仍由 pnpm 从 registry 解析**（本次"offline"的语义：
  插件不发布到 npm，依赖照常联网）。

### 1.6 环境坑

- **pnpm 12 + Node 26 不能用 `dsh plugin add <目录路径>`**（目录参数被当 registry 包名解析报错），
  必须写 `link:<绝对路径>` 依赖 + `dsh plugin install`。
- 插件依赖现状（hello-world）：`schemastery ^3.18.2` + peer `cordis ^4.0.2`、`dsh-tools ^0.1.2-rc.1`。
- 插件代码形态：`export { name, inject, Config, apply }`；工具注册用
  `ctx.tools.register(defineTool({...}))`（`@deepseek-ai/dsh-tools`）；`Config` 用 `schemastery`。

---

## 2. 讨论时间线（决策与理由）

### 阶段 A：机制问答（未改代码）

1. 本机插件进入环境的 4 条路：仓库标准流程（bundle 层，需重启）／patch 层直接插行（可热更）／
   agent preset 单会话挂载／动态 Cordis 插件（进程内临时）。
2. bundle 层是什么、gen_applist 的作用、为什么不直接维护生成的 `cordis.patch.yml`
   （applist 被两个脚本消费、生成期校验、防漂移）——这些是**旧架构**的正当性论述。

### 阶段 B：脚本健壮性迭代（旧架构内）

3. 批评 `ROOT = Path(__file__).resolve().parent.parent` 位置耦合 → 引入 `_common.py` +
   双标记（`package.json`+`book.toml`）向上搜索。
4. 用户指出 **PEP 723 不支持多文件** → 整体迁到 **uv workspace + `python -m`**：
   `py_src/` 三个成员（common / gen-applist / sync-home），删除 `scripts/`。
5. 用户质疑空 meta-package `dotdsh_tooling` 不必要（根不打算打成 wheel）→
   发现正确开关 `[tool.uv] package = false`，删 meta-package 与 `[build-system]`。
6. 删除 `--root` 参数与 `resolve_root`；`find_root(start=None)` 默认锚定**模块自身 `__file__`**——
   实测 uv 对 workspace 成员默认 **editable install**，`__file__` 直接指向仓库源码树，
   与 cwd、venv 位置完全解耦（这是关键事实）。
7. 用户把 `pyproject.toml` 加为第三标记；同步修正注释/文档；修 `find_root` 显式入参未 `resolve()`
   导致返回相对路径的问题。
8. 清理 `args = parse_args()` 死代码：保留 `parse_args()` 作"拒绝未知旗标"的守卫。

### 阶段 C：数据结构化（旧架构内）

9. 用户要求 load/store 分离 + 结构体替代 `dict[Any, Any]`：
   `App` dataclass + 字段驱动校验 → 用户改用 **pydantic** → 上层 `AppList` + 整文档一次
   `model_validate`（消灭 `for index, raw in enumerate(apps)`）→ 解析整体下沉
   `dotdsh_common.load_applist`（sync 也复用）。
10. 命名分析：dsh 生态中 "App" 已被占用（`dsh-web-app`/`dsh-sdk-app`/apps-web shell =
    客户端应用），`App` 过度声明且撞语义 → 改名 **`AppEntry`**（容器 `AppList`）。
11. 用户要求库层零 print：错误一律 raise（新增 `UserError`），main 捕获打印并 exit 1；
    progress 走注入的 `log` 回调；`run()` 不打印。

### 阶段 D：推倒重来（核心转折）

12. 用户判定旧设计"严重问题"，要求先对齐再动手。复盘（诚实结论）：
    - 复杂度根源 = **"聚合 store + applist 生成器"模式**（仓库的 OS 隐喻：applist.yaml 是
      app 清单），生成器、store 载体、"生成但提交"的耦合都是自找的；
    - sync_home 混了两件事：插件安装 + dotfiles 同步；
    - 我（Agent）的责任：一直在加固机制（workspace/pydantic/UserError），没有在需求变化时
      **挑战架构本身**。
13. 用户的新方案（4 条）+ 对齐问答后敲定的最终架构（见 §3）。关键对齐点：
    - dev 快速同步：**热加载模式**（写 profile 用户层），保证"热更 + 重启后仍生效"，
      因此不再需要单独的 offline 安装脚本；
    - 手工维护**一份** `cordis.patch.yml`，删除 `profiles/dotdsh`，`--profile` 参数化；
    - 脚本只做两件事：link 方式更新 package.json + `dsh plugin install`；覆盖 patch 文件；
    - "offline" 语义 = 插件不发布 npm，依赖照常联网；
    - 打包发布直接用 pnpm，不做 py 封装。
14. 实施：删除 applist.yaml / store 包 / gen / sync / dotdsh profile / home 层 patch；
    新建根 `cordis.patch.yml` 与单成员 `py_src/dotdsh-dev`；文档全量重写；
    在**临时 DSH_HOME** 完成端到端验证（`dsh --dump-config` 证明 boot 合成出插件行）。

### 阶段 E：dotdsh_dev 打磨

15. 删除 `env["DSH_HOME"]` 覆盖——`ctx.home` 本就来自 `$DSH_HOME`，未设时 dsh 自有同款
    fallback（`~/.dsh`）。
16. 行数复盘（279 行做 2.5 件事的构成分析：核心 ~1/3，其余是环境解析/文档/CLI 面），
    给出可瘦身清单（未执行）。
17. 引入 **`Context` 结构体**：`parse_args`/`resolve_*`/`dev_sync` 全部围绕它；
    `resolve_dsh` 回退改用 **pnx**（用户指定，无 `-y`；本机 `pnx` 位于 pnpm bin 目录）。
18. **`Context.verify()`**：唯一校验点（字段完整性、路径存在性、pnpm/dsh 可执行），
    `dev_sync` 入口调用，其余位置不再有同类检查；`home` 字段删除（仅留 `profile_dir`）；
    `plugins` 移出 Context，作为 `dev_sync(ctx, plugins)` 独立参数；
    main 顺序调整为"先构造 ctx 各函数，最后 list_plugins + dev_sync"。
19. **dry-run 重构**：删除 `dev_sync` 里的 `if ctx.dry_run: return` 大分支；引入三个
    ctx 封装 `run(cmd, ctx)` / `copy2(src, dst, ctx)` / `write_text(path, text, ctx)`，
    各自负责"打印正常日志 / 打印错误日志并 re-raise / 非 dry-run 才真执行"；
    此后只有这三个封装读 `ctx.dry_run`，其余逻辑一律不读。
20. **文件拆分**：`context.py`（UserError/BIN_NAME/Context+verify）、
    `change_wrapper.py`（run/copy2/write_text，原名 actions.py）、`__init__.py` 收敛为
    Plugin/find_repo_root/list_plugins/plan_link_deps/dev_sync + 公共 re-export；
    `__main__.py` 的 import 不变。依赖方向单向：change_wrapper → context，无环。
21. **命名约定**：路径按归属前缀——仓库侧 `repo_root`/`repo_patch`/`repo_node_src`，
    dsh 侧 `dsh_profiles`（= profile 目录，用户指定名）/`dsh_manifest_path`/`dsh_patch`；
    `find_root`→`find_repo_root`、`resolve_profile_dir`→`resolve_dsh_profiles`、
    `Context.dsh`→`dsh_path`；函数参数同步（`plugins_dir`→`repo_node_src` 等）。
22. **命名规则定稿（用户裁定）**：前缀标归属——`repo_*` = 当前仓库、`dsh_*` = `$DSH_HOME` 配置；
    路径后缀统一 `_dir`/`_file`。据此订正条目 21 的遗留：`dsh_profiles`→`dsh_profile_dir`
    （复数是名不副实）、`repo_root`→`repo_root_dir`、`repo_patch`→`repo_patch_file`、
    `repo_node_src`→`repo_node_src_dir`、`dsh_manifest_path`→`dsh_manifest_file`、
    `dsh_patch`→`dsh_patch_file`、`Context.dsh`→`dsh_bin_file`、`Context.profile`→`dsh_profile`、
    `Plugin.dir`→`Plugin.repo_dir`、包装器参数 `src/dst/path/cwd`→`src_file/dst_file/target_file/cwd_dir`；
    `Context.log` 默认改为 flush 打印的 `echo()`（修掉子进程输出"超车"日志行的顺序问题）；
    命名约定与"临时 DSH_HOME + stub dsh"真实验证法补入 AGENTS.md；
    决策表第 4 行恢复历史原名——历史条目保持原貌，更名只由本条记录。
23. **代码审视后的一轮收紧（用户逐条裁定，2026 会话）**——已做：
    - 校验提前：main 解析完路径后立即 `ctx.verify()`，之后才 `list_plugins`（原先扫完目录才校验）；
    - 异常边界：新增 `_load_json_file()`（读取/解析/非对象 → `UserError`），main 统一捕获
      `UserError | CalledProcessError | OSError`，默认打印一行 `error: ...`，新增 `--traceback` 看完整栈；
    - 命令可用性检查收敛到执行点：`verify()` 不再查 pnpm/dsh，由 `effects.run_cmd` 执行前
      `shutil.which(cmd[0])` 判定（同时删掉 `resolve_dsh` 里重复的 `--dsh` 存在性校验），
      于是 `--dry-run` 不再被工具缺失拦住；`resolve_dsh` 找不到 dsh 时不再 raise，回退裸名 `dsh` 并提示；
    - 库层零输出：pnx 回退提示改走 `ctx.log`（原 `print(..., file=sys.stderr)`）；
    - 构建前置检查改为 `node_modules/` + `pnpm-lock.yaml`（原探 pnpm 内部布局 `.pnpm`）；
    - 结构化变更：新增 `LinkDepChange`/`LinkDepPlan`，`plan_link_deps` 改**纯函数**（不再就地改 dict，
      由调用方落地）；dry-run 语义不变——只有 `write_file` 真执行时才落盘；
    - 日志三段式：`log_line(module, level, message)`，`Context.log` 指向它；dry-run 与真跑同序同模块，
      仅 `would ...` 与动词过去式之别；
    - 命名/清理：`change_wrapper.py`→`effects.py`、`run/copy2/write_text`→`run_cmd/copy_file/write_file`、
      `echo`→`log_line`、`Plugin.package`→`package_name`（`id` 改 property）、`Context.dsh_bin_file` 改 `Path`、
      删除死参数 `run(env=)`、常量集中 `constants.py`、`_resolved_paths()` 消除 Optional 赋值、
      `plan_link_deps` 参数改 `Mapping[str, Any]`；
    - 配置 ruff（lint+format，line-length 100），**不加依赖、不配 CI**（用 `uvx ruff`）。
    明确**不做**（记为设计约束）：测试套件、失败回滚/事务与原子写、退出码分级、增量构建/跳过 install、
    patch 内容比对、link 清理判据放宽——理由：这是**部署工具**，要尽量简单可理解，失败即"修因重跑"，
    每步幂等即可，无需回滚。
24. **dev 工具改走 uv 的 dependency group（用户指定）**：根 `pyproject.toml` 增
    `[dependency-groups] dev = ["ruff>=0.6"]`（PEP 735），ruff 配置由成员迁到根
    （`src = ["py_src/dotdsh-dev/src"]`，一个配置覆盖全部成员）；成员包保持纯净（无 dev 依赖、无 ruff 配置）。
    `uv sync` 默认安装 dev 组（`--no-dev` 可关），故命令由 `uvx ruff` 改为 `uv run ruff`。
    验证：临时副本中 `uv lock` 成功（`Resolved 3 packages`），lock 出现
    `[package.dev-dependencies] dev = [{ name = "ruff" }]`；仓库 `uv.lock` 由用户执行 `uv sync` 刷新。

---

## 3. 最终架构（当前仓库状态）

```
dotdsh/
├── node_src/<id>/           # 纯插件包（pnpm workspace，TS src/*.ts → gitignored lib/）
│                            #   无 store、无 bundle 声明、无生成器
├── cordis.patch.yml         # 唯一手写 patch 源（insert/override 行都在这，编辑只改这里）
├── py_src/dotdsh-dev/       # 唯一 Python CLI（uv workspace 单成员）
│   └── src/dotdsh_dev/
│       ├── __init__.py      # 库层：Plugin/list_plugins/plan_link_deps/dev_sync + 公共 re-export
│       ├── constants.py     # BIN_NAME/PATCH_FILENAME/ROOT_MARKERS
│       ├── context.py       # UserError/log_line/Context(+verify)
│       ├── effects.py       # run_cmd/copy_file/write_file（唯一读 dry_run 的封装）
│       └── __main__.py      # CLI：parse_args/resolve_dsh_profile_dir/resolve_dsh/main
├── pyproject.toml           # workspace 根：[tool.uv] package=false + [dependency-groups] dev(ruff) + [tool.ruff]
├── uv.toml                  # cache-dir = target/python/uv-cache
├── uv.lock / pnpm-lock.yaml # 均已刷新（store 包已移除）
├── dsh_home/settings.yaml   # 仅剩模板（一次性参考，无自动同步）
├── package.json             # scripts: dev / build / publish / book
├── AGENTS.md / README.md / doc/src/   # 已重写（doc/src 的 AGENTS/README 是符号链接）
└── target/                  # 构建产物（gitignored）
```

### 3.1 `dotdsh_dev` 行为（`uv run python -m dotdsh_dev`）

- 参数：`--profile`（默认 web）、`--no-build`、`--dry-run`、`--dsh`、`--traceback`。
- 流程：构造 Context → 解析路径/命令 → **`ctx.verify()`（提前失败）** → `list_plugins` →
  `dev_sync`（内部再 verify 一次）→（build）重建 profile `package.json` 的 `link:` 依赖
  （新增各插件 + 清理指向本仓库的过期条目）→ `dsh plugin --profile <n> install` →
  原地覆盖 profile 用户层 `cordis.patch.yml`（**放最后**：前面任一步失败就不动运行中的 patch 层）。
- 失败模型：每步幂等、不做回滚——修掉原因后整体重跑即收敛（错误默认一行 `error: ...`，
  `--traceback` 看完整栈）。
- 日志：`ctx.log(module, level, message)` 三段式（level ∈ info/plan/error），dry-run 与真跑同序同模块。
- 效果保证：patch 行 → 运行中 profile 热重载（`patchReload: live`）+ 重启后仍生效；
  `link:` 持久于 package.json → 重启后插件可解析；插件代码改动需重启 dsh。
- 注意：脚本会**覆盖**目标 profile 的用户层，手工覆盖一律改仓库根 `cordis.patch.yml`。

### 3.2 常用命令

```sh
uv sync                                # 建/刷新 .venv：成员 + 根 dev 组（ruff）
uv run python -m dotdsh_dev            # dev 同步进 web profile（含 pnpm -r build）
uv run python -m dotdsh_dev --dry-run  # 只打印计划
uv run python -m dotdsh_dev --traceback  # 失败时打印完整栈
uv run ruff check py_src/dotdsh-dev    # lint（ruff 来自根 dev 组）
uv run ruff format py_src/dotdsh-dev   # format
pnpm build                             # 编译所有插件 src/*.ts → lib/
pnpm publish                           # pnpm -r publish --access public
mdbook build                           # 文档 → target/book/
```

### 3.3 新增插件的三步

1. `node_src/<id>/` 建包（package.json + src/index.ts + tsconfig.json）；
2. 根 `cordis.patch.yml` 加该行（id/name/config）；
3. `uv run python -m dotdsh_dev`（行热更；新插件代码需重启 dsh）。

---

## 4. 关键决策速查表

| # | 决策 | 理由 |
|---|---|---|
| 1 | 不用 `dsh plugin add <路径>` | pnpm 12 + Node 26 解析目录参数失败；用 `link:` + install |
| 2 | uv workspace + `python -m`（弃 PEP 723） | PEP 723 无法表达多文件工具 |
| 3 | 根项目 `package = false` | 根只是环境聚合器，不该被打成 wheel |
| 4 | `find_root` 锚定模块 `__file__` | uv editable install 使 `__file__` 落在仓库源码树，cwd/venv 无关（函数于条目 21 更名为 `find_repo_root`） |
| 5 | 根标记 = package.json + book.toml + pyproject.toml | 三者只在仓库根共存，防误判 |
| 6 | 库层零 print，错误 raise / main 打印 | 库/CLI 分层纪律 |
| 7 | 删聚合 store + applist 生成器 | 生成链路的复杂度根源；行改手写、包改纯插件 |
| 8 | patch 落在 profile 用户层而非 --patch | 热更 + 重启双保证；--patch 只对新进程生效 |
| 9 | `Context` + `verify()` 单点校验 | 检查集中、dev_sync 干净 |
| 10 | `resolve_dsh` 回退 pnx | 用户指定；本机 pnx 在 pnpm bin 目录 |

## 5. 遗留事项（切换环境后需要做的）

- [ ] 对真实 `~/.dsh` 执行一次 `uv run python -m dotdsh_dev`（本次全程只在临时 DSH_HOME 验证，
      真实 web profile 只做过只读 `--dry-run`）；
- [ ] 自行决定是否删除旧 profile 目录 `~/.dsh/profiles/dotdsh/`（本次未动）；
- [ ] `dsh_home/settings.yaml` 填好后手动复制到 `$DSH_HOME`（一次性）；
- [ ] 发布前：`pnpm publish`；决定平台名；加 CI（clean-tree `pnpm build` + `mdbook build`）；
- [ ] TODO 列表见 `doc/src/todo.md`。

## 6. 本次会话最终验证结果

- 临时 DSH_HOME 端到端：`link:` 写入 ✓、`node_modules` 符号链接 ✓、patch 覆盖一致 ✓、
  `dsh --dump-config` 合成出 hello-world 行 ✓、幂等 ✓、过期 link 清理 ✓；
- `verify()` 失败路径：字段缺失聚合报错 ✓、路径/命令检查 ✓；
- `--dry-run`（真实 web，只读）计划正确 ✓；pnx 回退链 ✓；
- 本记录不含任何 `~/.dsh` 真实写入（红线：未经用户明确要求不碰真实 home）。
