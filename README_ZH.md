# Clawser

版本：`2026.3.12`

Clawser 是一个本地 Chrome 自动化 CLI。它会启动本地 relay，通过
**Clawser Browser Relay** Chrome 扩展连接 Chrome，并把浏览器操作暴露成
适合脚本调用的命令。

本仓库还包含一个轻量的 Go 菜单栏/任务栏常驻程序，用来启动和停止本地 relay。

English documentation: [README.md](README.md)

## 当前已有功能

- 启动和停止本地浏览器 relay。
- 执行 `clawser start` 时，如果 Chrome 没有打开，会自动打开一个
  `about:blank`。
- 通过点击 Chrome 工具栏里的 **Clawser Browser Relay** 扩展，把当前 tab
  连接到 relay。
- 查看 tabs、snapshot、console、errors、requests、cookies、storage。
- 通过 snapshot ref 操作页面：click、type、press、hover、drag、select、
  upload、wait、evaluate、screenshot、download、dialog、trace。
- 支持 CLI 方式，也支持仓库内置的 macOS 菜单栏程序。
- 支持 `--json` 输出，方便 Node.js/RPA 脚本调用。

当前有意保留的边界：

- `clawser stop` 只停止 relay，不会关闭 Chrome，避免误关用户浏览器。
- 目标 tab 仍然需要手动点击一次 Chrome 扩展图标，徽标显示 `ON` 后才能被脚本控制。
- 菜单栏程序目前是本地开发版 `.app`，还不是签名安装包。

## 环境要求

- Node.js `22.12+`
- pnpm
- Google Chrome
- 如果要构建菜单栏程序，需要 Go `1.24+`

## 从源码安装

```bash
pnpm install
pnpm build
pnpm link --global
```

如果 pnpm 提示没有配置 global bin，执行：

```bash
pnpm setup
```

然后重新打开终端，再执行：

```bash
pnpm link --global
```

验证 CLI：

```bash
clawser --help
clawser status
```

也可以不做全局 link，直接从当前 checkout 运行：

```bash
node clawser.mjs status
```

## Chrome 扩展安装

先把 unpacked 扩展安装到 Clawser 的状态目录：

```bash
clawser extension install
clawser extension path
```

默认扩展路径是：

```text
~/.clawser/browser/chrome-extension
```

在 Chrome 中加载：

1. 打开 `chrome://extensions`。
2. 打开 **Developer mode / 开发者模式**。
3. 点击 **Load unpacked / 加载已解压的扩展程序**。
4. 选择 `clawser extension path` 打印出来的目录。
5. 把 **Clawser Browser Relay** 固定到工具栏。

## 基本使用流程

启动本地 relay：

```bash
clawser start
```

relay 地址：

```text
http://127.0.0.1:18792/
```

如果 Chrome 没有运行，`clawser start` 会打开 Chrome 的 `about:blank`。
它不会自动连接当前 tab。

打开目标网页后，点击 Chrome 工具栏里固定的 **Clawser Browser Relay** 扩展图标。
徽标显示 `ON` 后，脚本才能控制该 tab。

检查连接状态：

```bash
curl http://127.0.0.1:18792/extension/status
```

未连接 tab 时：

```json
{ "connected": false }
```

点击扩展并连接成功后：

```json
{ "connected": true }
```

查看已连接的标签页：

```bash
clawser tabs
```

停止 relay：

```bash
clawser stop
```

注意：`clawser stop` 不会关闭 Chrome。

如果不希望 `start` 自动打开 Chrome：

```bash
CLAWSER_SKIP_CHROME_BOOTSTRAP=1 clawser start
```

## 菜单栏 / 任务栏常驻程序

仓库内置了一个 Go 写的轻量菜单栏程序，位于 `tray/`。

当前菜单包含：

- `Start Clawser`
- `Stop Clawser`
- relay 状态
- `Quit`

构建并运行本地 macOS `.app`：

```bash
cd tray
./scripts/build-macos-app.sh
open -n "/tmp/Clawser Tray.app"
```

本地 `.app` 会生成到 `/tmp`，避免把构建产物写进仓库。

菜单栏程序查找 Clawser 的顺序：

1. `CLAWSER_BIN`
2. 最近的、包含 `clawser.mjs` 的父级 checkout
3. `PATH` 里的 `clawser`

菜单栏程序使用的也是同一套 CLI 行为：`Start`/`Stop` 只控制 relay，
不会替你点击 Chrome 扩展图标。

## 常用 CLI 命令

打开和检查页面：

```bash
clawser open https://www.baidu.com
clawser tabs
clawser snapshot --format ai
clawser snapshot --format aria --limit 200
clawser screenshot --full-page
```

页面交互：

```bash
clawser click <ref>
clawser type <ref> "hello"
clawser press Enter
clawser hover <ref>
clawser wait --text "Done"
```

页面状态和调试：

```bash
clawser console
clawser errors
clawser requests
clawser evaluate --fn '() => document.title'
clawser cookies
clawser storage local get
```

下载、上传、弹窗：

```bash
clawser upload /path/to/file.pdf
clawser waitfordownload /tmp/downloaded-file
clawser download <ref> /tmp/downloaded-file
clawser dialog --accept
```

Profile 和扩展辅助命令：

```bash
clawser status
clawser profiles
clawser extension install
clawser extension path
```

JSON 输出：

```bash
clawser status --json
clawser tabs --json
clawser snapshot --json
```

## 脚本集成

脚本里建议使用 JSON 输出：

```bash
clawser browser --json tabs
clawser browser --json snapshot --format ai --selector ".login-panel"
```

不做全局安装时，可以直接调用仓库里的 `clawser.mjs`：

```js
const { execFile } = require("child_process");

execFile(
  process.execPath,
  ["/path/to/clawser/clawser.mjs", "browser", "--json", "tabs"],
  (error, stdout) => {
    if (error) throw error;
    console.log(JSON.parse(stdout));
  },
);
```

如果你有旧的 OpenClaw 风格 wrapper，可以按下面方式映射：

```text
openclaw browser tabs --json
  -> clawser browser --json tabs

snapshot("html", selector)
  -> clawser browser --json snapshot --format ai --selector <selector>
```

`ai` snapshot 会返回 `refs`，这些 ref 可以继续给 `click`、`type`、`hover`
等命令使用。

## 状态目录

Clawser 的本地运行文件默认放在：

```text
~/.clawser
```

命名 profile 会使用对应目录：

```text
~/.clawser-dev
~/.clawser-work
```

relay token 固定为：

```text
CLAWSER
```

Chrome 扩展会自动带上 token，用户不需要手动输入。

## 常见问题

relay 不可达：

```bash
clawser start
curl http://127.0.0.1:18792/extension/status
```

没有已连接 tab：

```text
tab not found (no attached Chrome tabs for profile "chrome")
```

处理方式：

1. 在 Chrome 中打开目标 tab。
2. 点击固定在工具栏的 **Clawser Browser Relay** 扩展图标。
3. 等徽标显示 `ON`。
4. 再执行 `clawser tabs`。

Chrome 没有被自动打开：

```bash
node clawser.mjs start --json
```

如果你就是不想让 Clawser 自动打开 Chrome：

```bash
CLAWSER_SKIP_CHROME_BOOTSTRAP=1 clawser start
```

## 开发

常用检查：

```bash
pnpm build
pnpm test
pnpm tsgo
pnpm check
```

快速 smoke checks：

```bash
clawser --help
clawser status --json
clawser start --json
clawser extension install --json
clawser tabs --json
```

菜单栏程序检查：

```bash
cd tray
go test ./...
./scripts/build-macos-app.sh
open -n "/tmp/Clawser Tray.app"
```

