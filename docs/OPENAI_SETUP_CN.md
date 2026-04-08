# cloai OpenAI 接入与隔离部署指南

本文档面向想把 `cloai` 作为独立 OpenAI CLI 使用的人。

目标：

- 默认走 `OpenAI / gpt-5.4`
- 不复用原版 `claude` 的 AWS Bedrock 配置
- 配置目录独立到 `~/.cloai`
- 兼容公司代理场景
- 避免终端优先命中 `~/.bun/bin/cloai` 导致旧入口失效

## 适用前提

- `bun >= 1.3.5`
- `node >= 24`
- macOS / Linux shell 环境
- 已能使用 `codex login`，或准备在 `cloai` 内单独做 OpenAI 登录

## 一次性安装

```bash
git clone <your-repo-url>
cd cloai-code
bun install
bun link
mkdir -p ~/.local/bin ~/.cloai
```

## 独立启动脚本

创建 `~/.local/bin/cloai`：

```zsh
#!/bin/zsh

: "${CLAUDE_CONFIG_DIR:=$HOME/.cloai}"
export CLAUDE_CONFIG_DIR
export NODE_TLS_REJECT_UNAUTHORIZED=0
export DISABLE_INSTALLATION_CHECKS=true
unset CLAUDE_CODE_USE_BEDROCK
unset CLAUDE_CODE_USE_VERTEX
unset CLAUDE_CODE_USE_FOUNDRY

exec "$HOME/.bun/bin/bun" "$HOME/.bun/install/global/node_modules/@cloai-code/cli/src/bootstrap-entry.ts" -- --settings "$HOME/.cloai/launch-settings.json" "$@"
```

赋权：

```bash
chmod +x ~/.local/bin/cloai
```

## 解决 Bun PATH 抢命中

很多终端会优先命中 `~/.bun/bin/cloai`。如果这里还是旧链接，就会绕过上面的包装脚本。

建议直接统一到同一个入口：

```bash
rm -f ~/.bun/bin/cloai
ln -s ~/.local/bin/cloai ~/.bun/bin/cloai
```

验证：

```bash
type -a cloai
which -a cloai
```

你应该能看到 `~/.local/bin/cloai` 和 `~/.bun/bin/cloai` 指向同一套入口。

## 独立运行配置

创建 `~/.cloai/launch-settings.json`：

```json
{
  "awsAuthRefresh": "",
  "awsCredentialExport": "",
  "apiKeyHelper": "",
  "env": {
    "CLAUDE_CODE_USE_BEDROCK": "0",
    "CLAUDE_CODE_USE_VERTEX": "0",
    "CLAUDE_CODE_USE_FOUNDRY": "0",
    "NODE_TLS_REJECT_UNAUTHORIZED": "0",
    "AWS_PROFILE": "",
    "AWS_REGION": "",
    "AWS_DEFAULT_REGION": "",
    "ANTHROPIC_MODEL": "gpt-5.4",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gpt-5.4",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "gpt-5.4",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "gpt-5.4",
    "ANTHROPIC_SMALL_FAST_MODEL": "gpt-5.4"
  }
}
```

这份配置的作用是：

- 强制关掉 Bedrock / Vertex / Foundry
- 固定默认模型到 `gpt-5.4`
- 在公司代理下关闭 TLS 证书校验

如果你的机器不需要代理证书绕过，可以把 `NODE_TLS_REJECT_UNAUTHORIZED` 去掉或改为 `1`。

## OpenAI 登录

推荐两种方式：

### 方式一：导入 Codex 登录态

先确保这台机器已经执行过：

```bash
codex login
```

然后启动：

```bash
cloai
```

进入后执行：

```text
/import-codex
```

这会从 `~/.codex/auth.json` 导入 OpenAI OAuth 信息。

### 方式二：在 cloai 内单独登录

如果没有 `codex`，直接在 `cloai` 里走 OpenAI 登录流程即可。

## 验证是否生效

从家目录启动：

```bash
cd ~
cloai
```

正常情况下你会看到：

- 顶部模型显示为 `gpt-5.4`
- 不会跳到 AWS / Bedrock 登录页
- 不会误读 `~/.claude/settings.json`

交互验证：

```text
Reply with exactly OK.
```

如果配置正确，应该直接返回：

```text
OK
```

## 与原版 claude 的关系

这套方案默认不会影响你原来的 `claude`：

- `cloai` 走 `~/.cloai`
- 原版 `claude` 仍可继续用 `~/.claude`
- 包装脚本只对 `cloai` 生效

如果你同时保留企业 AWS Bedrock 版 `claude`，两边可以并存。

## 常见问题

### 1. 还是进了 AWS 登录页

大概率是终端实际跑到的不是包装后的 `cloai`。

检查：

```bash
type -a cloai
which -a cloai
```

### 2. 还是报证书错误

检查当前进程是不是通过包装脚本启动。

如果不是，通常就是 `~/.bun/bin/cloai` 还没改成指向 `~/.local/bin/cloai`。

### 3. 首页显示是 `gpt-5.4`，但请求还是失败

先确认是否已经执行过 `/import-codex` 或完成 OpenAI 登录。

## 推荐验证命令

```bash
type -a cloai
which -a cloai
cloai --version
```
