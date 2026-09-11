<p align="center">
  <img src=".github/assets/banner.png" alt="Action Agents — 值得信赖、边界明确、可审计的 GitHub Actions，用于仓库维护：triage、review 和 harmonise，每一个都是针对任意兼容 OpenAI 模型的独立 Action" width="100%" />
</p>

<h1 align="center">Action Agents</h1>

<p align="center">
  <strong>值得信赖、边界明确、可审计的 GitHub Actions，用于仓库维护。</strong><br />
  三个 Action，各自只负责一件事——triage、review、harmonise——运行在 GitHub Actions 之中，面向任意兼容 OpenAI 的模型，包括你自己托管的模型。无需信任的捆绑包，无需审计的依赖，启动前无需任何安装。<br />
  <em>运行器执行的内容，就是你在所固定（pin）的标签上能读到的源码。</em>
</p>

<!-- harmonise:skip-start -->
<p align="center">
  <a href="https://github.com/ecoma-io/action-agents/actions/workflows/ci.yml"><img src="https://github.com/ecoma-io/action-agents/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/ecoma-io/action-agents/actions/workflows/analysis.yml"><img src="https://github.com/ecoma-io/action-agents/actions/workflows/analysis.yml/badge.svg" alt="Analysis" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License: Apache 2.0" /></a>
  <a href="https://github.com/ecoma-io/action-agents/releases"><img src="https://img.shields.io/github/v/release/ecoma-io/action-agents.svg" alt="Latest release" /></a>
</p>
<!-- harmonise:skip-end -->

<!-- harmonise:skip-start -->

<a href="README.md">English</a> | <a href="README.vi.md">Tiếng Việt</a> | <a href="README.zh.md">中文</a> | <a href="README.ja.md">日本語</a> | <a href="README.es.md">Español</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.ar.md">العربية</a> | <a href="README.pt.md">Português</a> | <a href="README.bn.md">বাংলা</a> | <a href="README.ru.md">Русский</a> | <a href="README.fr.md">Français</a>

<!-- harmonise:skip-end -->

<p align="center">
  <a href="#get-started"><strong>Quick&nbsp;start&nbsp;→</strong></a> ·
  <a href="#the-actions">The&nbsp;actions</a> ·
  <a href="SECURITY.md">Security</a> ·
  <a href="CONTRIBUTING.md">Contributing</a> ·
  <a href="AGENTS.md">For&nbsp;agents</a> ·
  <a href="docs/README.md">Docs</a> ·
  <a href="https://ecoma.io">About&nbsp;Ecoma</a>
</p>

---

仓库维护是没人会主动安排的工作：给新到的内容打标签、认真读懂一份 diff、防止多语言文档彼此偏离。模型可以完成其中大部分工作——但把写入令牌交给模型，只有当它的行为边界由提示词之外的机制来约束时才安全。这三个 Action 用代码画出这条边界：**模型永远不会自行构造 API 调用——它从你写好的清单里选择，而任何不可逆的操作、任何会给人类发邮件的操作都不允许出现在清单上**，并且从线程或 diff 中读到的一切都是证据，而非指令。

- **一个 Action 只承担一个职责** —— 只采用 `review` 而不必连带采用其他任何东西。每个目录就是一个完整的 Action，彼此之间共享的只有一层很小的运行时。
- **你的运行器上无需安装任何东西** —— 一个 JavaScript Action，直接基于运行器自带的 Node 24 运行，从源码出发。没有 `dist/`、没有 `node_modules`、没有 `npm install` 步骤，启动前不进行任何网络访问。
- **任意兼容 OpenAI 的模型** —— 带密钥或不带密钥、托管或自建皆可。跨越这条分界线的只有 chat-completions 协议，因此免费层级的端点也是受支持的路径，而不是降级的路径。
- **在值得的地方发挥智能体能力** —— `review` 自行决定读什么，先验证再下结论，并压缩自己的对话记录，而不是截断你的 diff。
- **边界由你的工作流决定，而不是由我们的提示词决定** —— 配置描述行为；`permissions:` 块就是安全边界。

> **状态：已发布。** 每个标签都可固定——浮动标签跟随其次要版本的补丁更新，精确标签则永不移动——下面的示例可以正常解析。关于该用哪种标签，参见 [Pinning strategy](#pinning-strategy)；[CHANGELOG.md](CHANGELOG.md) 记录了什么在何时发布。

## Get started

```yaml
name: Review
on: pull_request

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      # review reads the working tree, so it needs a checkout
      - uses: actions/checkout@v5

      - uses: ecoma-io/action-agents/review@v0.12
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          api-url: ${{ vars.LLM_API_URL }}
          api-key: ${{ secrets.LLM_API_KEY }}
          model: ${{ vars.LLM_MODEL }}
```

### Pinning strategy

每一条 `uses:` 引用都带有一个控制所运行代码的 ref。按安全性排序，共有三种形式：

| Ref                  | Example                                 | What it resolves to                                                     |
| -------------------- | --------------------------------------- | ----------------------------------------------------------------------- |
| `v0.12` (floating)   | `ecoma-io/action-agents/review@v0.12`   | The latest patch release in the `v0.12` line. Gets fixes automatically. |
| `v0.12.0` (exact)    | `ecoma-io/action-agents/review@v0.12.0` | Exactly that release. Never moves.                                      |
| `<sha>` (SHA-pinned) | `ecoma-io/action-agents/review@abc123…` | Exactly those bytes. Immutable.                                         |

浮动标签（`v0.10`、`v0.11`、`v0.12`）无需修改工作流即可带来补丁更新——这通常正是你想要的。精确标签带来可复现性——需要时你就该用它。提交 SHA 带来审计轨迹——这是最强的固定方式，也是安全策略引擎所强制执行的。

**不要使用 `@main`。** 对 `main` 的一次推送随时可能改变 Action 的行为，包括尚未发布的方式。每一个已发布的 ref 要么不可变，要么在声明的兼容性线内浮动。

属于仓库而非某个工作流的行为，存放在 `.github/action-agents/<action>/<action>.json5` —— 每个 Action 一个文件，与 Action 特有的文件放在一起。它从 Action 的**已解析的策略来源**读取——在大多数事件上是默认分支，在 pull request 上是 PR 的基础分支——并且位于一个不可变的提交 SHA 上，因此 pull request 无法修改约束自身的策略，中途落地的推送也无法改变一次运行读到一半的内容。每个 Action 在没有该文件时也能运行：该文件添加的是策略，它从不阻止执行——`harmonise` 是例外，宁可拒绝也不在空无一物时绿色通过，原因由其开发页面说明。散文式设置——一份审查标准、一份文档所对照的语言——是 Action 的配置文件所指向的 markdown 文件，因为散文应该放在文档里。

## The actions

|                                          |                                                                                                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [**`triage`**](triage/action.yaml)       | 根据你声明的标签表对 issue 和 pull request 分类；有边界的模型评估会输入一项确定性策略，由它决定变更——只有标签和一条评论，别无其他——大小以 diff 来衡量。 |
| [**`review`**](review/action.yaml)       | 像一个智能体一样审查 pull request：它决定读什么，先搜索并验证再断言，然后评论发现的结论。                                                               |
| [**`harmonise`**](harmonise/action.yaml) | 让仓库文档的多语言版本在语义上彼此保持一致。                                                                                                            |

`review` 是为仓库内部发起的 pull request 设计的。如果你想用 `pull_request_target` 来覆盖 fork，请先阅读 [SECURITY.md](SECURITY.md)：在该触发器下签出 fork 的 head 是**你的**仓库中的一个漏洞，没有任何 Action 能替你修复。

### The root action

仓库根目录包含一个 `action.yml`，但它**不是一个可运行的 Action**。它存在的意义是让 `uses: ecoma-io/action-agents@v0.12.0` 能解析到某个标签，而不是因缺少清单而报错。被调用时，它会立即报错，列出三个真正的 Action 并告诉你选一个。这沿袭了 [github/codeql-action](https://github.com/github/codeql-action) 确立的模式：根部的占位程序防止仓库被误当作单个 Action 使用。

**在你的 `uses:` 行中，始终引用一个具体的 Action 目录**（`triage`、`review` 或 `harmonise`）。

## Documentation

|                                       |                                              |
| ------------------------------------- | -------------------------------------------- |
| [**Security**](SECURITY.md)           | 威胁模型、上限，以及如何报告漏洞             |
| [**Contributing**](CONTRIBUTING.md)   | 一个 pull request 被评判所依据的一切         |
| [For agents](AGENTS.md)               | 同样的基础内容，面向在仓库上工作的 AI 智能体 |
| [Code of Conduct](CODE_OF_CONDUCT.md) | 在这里参与所要求的准则                       |

完整索引：[**docs/**](docs/README.md) —— 按需逐步写下，并诚实地说明哪些页面还不存在。

## Contributing

最有价值的贡献是**一个 Action 做出了超出其许可范围的行为**——一条没有任何维护者意图的评论、一次逃出工作区的读取、一个进入日志的密钥。那是安全报告而不是 issue：[SECURITY.md](SECURITY.md)。其余一切——[CONTRIBUTING.md](CONTRIBUTING.md) · [Code of Conduct](CODE_OF_CONDUCT.md)。

## License

[Apache License 2.0](LICENSE) — © Mai Ngọc Hóa (John Martin) 与 Action Agents 的贡献者们。Apache-2.0 因其明确的专利授权。

---

<p align="center">
  <sub>
    由 <a href="https://ecoma.io">Ecoma</a> 维护 ·
    <a href="https://ecoma.io">Website</a> ·
    <a href="https://github.com/ecoma-io">Github</a>
  </sub>
</p>
