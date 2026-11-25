# aa-zcode-bridge

ZCode 的 Agents Anywhere 运行时桥插件（manifest 名 `aa-bridge-reg`）。它把 ZCode 的 app-server 接到 Agents Anywhere 的连接器上：AA 里的会话、时间线、审批卡片、模型与模式选择都经它落到 ZCode。

- **契约**：契约 A（aa.zcode.v2）与契约 B 的定义在决策库的 [CONTRACT-aa-zcode-v2.md](https://github.com/rogerhik999-arch/agents-anywhere-zcode/blob/main/docs/CONTRACT-aa-zcode-v2.md)；各文档的关系见那里的 [docs/README.md](https://github.com/rogerhik999-arch/agents-anywhere-zcode/blob/main/docs/README.md)。契约要变，先改那边，再改这里。
- **对端**：连接器（Agents Anywhere 的 fleet fork [agents-anywhere](https://github.com/rogerhik999-arch/agents-anywhere)，`connector/runtimes/zcode/bridge/`）。连接器只校验握手应答里的 `protocolVersion`。0.3.3 起握手应答为 `protocolVersion: "0.3"`，并用 `capabilities` 列出可选方法（现为 `sessionResume`）；0.3.2 及以前回答 `0.2`、没有这个列表，连接器据此决定发回合前要不要先恢复会话。

## 它怎么跑

zcode 的插件宿主（`__zcode-plugin-host`）导入 `index.mjs` 并调用 `main()`。线上由连接器拉起这个宿主进程，并用会合文件 `~/.agents-anywhere/zcode-bridge/connector.json` 让插件找到连接器。插件随后：

1. 在连接器的 Router 上注册 `aa.zcode.v2.Bridge`，方法是 `initialize` `sessionStart` `sessionResume` `sessionSend` `sessionStop` `sessionList` `modelCatalog` `sessionSelect` `sessionRespond` `sync` `shutdown`；
2. 按需启动 ZCode app-server（`node <zcode 引导包> app-server`，不启动 ZCode.app 本体）。连接器重启或插件被重新拉起后，app-server 是新进程，此前打开的会话要先用 `sessionResume` 恢复（`session/resume` + `session/subscribe`），否则 `session/setModel`、`session/send` 都报 `-32004 Session is not active`；
3. 把 ZCode 的事件经 `aa.zcode.v2.Sync.ingestBatch` 批量推给连接器；
4. 把 ZCode 的权限请求变成 AA 的审批卡片，由 AA 用户作答。

## 安装

发行 zip 里是插件本身和随包的 `ws`（8.23.0，MIT，见 `ws/LICENSE`），没有别的依赖。zcode 的 marketplace 用 zip 来源安装：

```json
{
  "name": "aa-bridge",
  "source": { "source": "url", "type": "zip", "url": "<发行页里的 zip 地址>", "sha256": "<发行页里的 sha256>" },
  "version": "<manifest 里的版本>"
}
```

`node scripts/package-release.mjs v<版本>` 会原样打印这段条目。zip 来源要求这个仓库是公开的，或者 zcode 拿得到凭据。

zip 里同时带 zcode 格式的清单 `.zcode-plugin/plugin.json`（版本与 `plugin.json` 一致），所以可以用 zcode 自己的命令装：`zcode plugins marketplace add <含 marketplace.json 的目录>`，然后 `zcode plugins install aa-bridge@aa-local`。0.3.3 及更早的 zip 没有这份清单，`zcode plugins install` 会报 `plugin_marketplace_invalid`，只能手工解包并改登记表。

**连接器怎么找到插件**：fleet fork 的连接器自己拉起插件宿主，并按 zcode 的插件登记表找插件——`~/.zcode/cli/plugins/installed_plugins.json` 里 `aa-bridge@aa-local` 条目的 `installPath` 指向哪个版本就加载哪个；没有登记条目时取 `~/.zcode/cli/plugins/cache/aa-local/aa-bridge/` 下版本号最高的目录。换版本 = 用 zcode 装上新版本（登记表随之更新），然后重启连接器。连接器自己不钉版本（[fleet PR #14](https://github.com/rogerhik999-arch/agents-anywhere/pull/14) 之前它写死加载 0.2.2）。

## 路径

| 变量 | 默认值 | 说明 |
|---|---|---|
| `AA_ZCODE_RENDEZVOUS` | `~/.agents-anywhere/zcode-bridge/connector.json` | 会合文件；连接器拉起宿主时会设置 |
| `AA_ZCODE_WORKBASE` | `/tmp/aa-zcode-bridge/work` | app-server 的工作目录 |
| `AA_ZCODE_LOG` | 会合文件所在目录下的 `v3-marker.log`（即 `~/.agents-anywhere/zcode-bridge/v3-marker.log`） | 标记日志；0.3.2 起跟着会合文件走（0.3.1 及以前默认在开发目录，别的机器上写不出来） |
| `AA_ZCODE_OPSOCK` | 会合文件所在目录下的 `v3-bridge.sock` | ops 套接字；连上后回一行 JSON（`alive`、`plugin`） |
| `AA_ZCODE_BOOTSTRAP` | `~/zcode-headless/zcode.cjs` | zcode 的 headless CLI 包（app-server 与插件宿主的入口），需要另行安装 |

家目录取自操作系统（`os.homedir()`），源码里不写任何一台机器的路径。

## 开发

只需要 Node（CI 跑 22 和 24），没有依赖要装：

```
node --check index.mjs
node tests/run.mjs
```

`tests/run.mjs` 跑五个测试：权限映射（纯函数）、静态检查（manifest、注册的方法与实现一致）、沙箱启动（真的加载插件并调用 `main()`，查 ops 套接字，再 `SIGTERM`）、事件同步队列（从源码里抽出队列函数来跑）、会话恢复（真的把插件跑起来，对端是替身的 Router 与替身的 app-server：握手、`sessionResume` 的顺序与错误原样透传）。`AA_BRIDGE_ENTRY=/path/to/index.mjs` 让它们指向另一份拷贝。

## 发行

版本号只认 `plugin.json`；握手应答和日志里的名字也从它读出（`aa-bridge-reg@<版本>`）。`.zcode-plugin/plugin.json` 是给 zcode 的安装器看的，版本跟着它（静态测试把关）。

1. 改 `plugin.json` 的版本（连同 `.zcode-plugin/plugin.json` 里的版本），在 `CHANGELOG.md` 顶部补一条，提交；
2. `git tag v<版本>` 并推送；
3. `node scripts/package-release.mjs v<版本>`：用 `git archive` 从这个 tag 出 `dist/aa-bridge-reg-<版本>.zip` 和 `.sha256`，再对解压出来的副本跑全部测试，不过就删包；
4. `scripts/publish-release.sh v<版本> [发行说明.md]`：建这个 tag 的 GitHub Release（已有就复用，同名文件先替换），上传 zip 和 `.sha256`，再把两个文件经 API 下载回来与本地构建比对，不一致就报错退出。token 取自 `git credential fill`，不落盘不打印。marketplace 条目用打包脚本打印的那一段。

CI 在每次推送上做同样的事，外加 `bash -n` 检查 shell 脚本的语法（Node 22 / 24）。CI 只负责验证，不留产物；发行物是挂在 GitHub Release 上的 zip 和 `.sha256`。

## 历史

0.2.2 及更早的源码在决策库的 `plugin/aa-bridge/` 里。本仓库的第一个提交是它的原样导入，与当时装机的 0.2.2 逐字节一致。
