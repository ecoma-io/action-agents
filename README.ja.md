<!-- harmonise:skip-start -->
<p align="center">
  <a href="https://github.com/ecoma-io/action-agents/actions/workflows/ci.yml"><img src="https://github.com/ecoma-io/action-agents/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/ecoma-io/action-agents/actions/workflows/analysis.yml"><img src="https://github.com/ecoma-io/action-agents/actions/workflows/analysis.yml/badge.svg" alt="Analysis" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License: Apache 2.0" /></a>
  <a href="https://github.com/ecoma-io/action-agents/releases"><img src="https://img.shields.io/github/v/release/ecoma-io/action-agents.svg" alt="Latest release" /></a>
</p>
<!-- harmonise:skip-end -->

<p align="center">
  <img src=".github/assets/logo.png" alt="Action Agents — 信頼でき、境界が定められ、監査可能な GitHub Actions によるリポジトリ保守: triage、review、harmonise。それぞれが OpenAI 互換モデルに対して動作する自己完結型のアクションです" width="64px" />
</p>
<h1 align="center">Action Agents</h1>

<!-- harmonise:skip-start -->
<p align="center">
<a href="README.md">English</a> | <a href="README.vi.md">Tiếng Việt</a> | <a href="README.zh.md">中文</a> | <a href="README.ja.md">日本語</a> | <a href="README.es.md">Español</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.ar.md">العربية</a> | <a href="README.pt.md">Português</a> | <a href="README.bn.md">বাংলা</a> | <a href="README.ru.md">Русский</a> | <a href="README.fr.md">Français</a>
</p>
<!-- harmonise:skip-end -->

<p align="center">
  <strong>信頼でき、境界が定められ、監査可能な GitHub Actions によるリポジトリ保守。</strong><br />
  三つのアクション、それぞれが一つの責務を持ちます——triage、review、harmonise——GitHub Actions の中で OpenAI 互換モデルを相手に動作し、自分でホストしたモデルも対象です。信頼すべきバンドルも、監査すべき依存も、起動前のインストールもありません。<br />
  <em>ランナーが実行するのは、あなたが固定したタグで読めるソースそのものです。</em>
</p>

<p align="center">
  <a href="docs/README.md">ドキュメント</a> ·
  <a href="https://github.com/ecoma-io/action-agents/issues/new?template=bug_report.yml">バグを報告</a> ·
  <a href="https://github.com/ecoma-io/action-agents/issues/new?template=feature_request.yml">機能リクエスト</a>
</p>

<p align="center">
  <img src=".github/assets/banner.png" alt="Action Agents — 信頼でき、境界が定められ、監査可能な GitHub Actions によるリポジトリ保守: triage、review、harmonise。それぞれが OpenAI 互換モデルに対して動作する自己完結型のアクションです" width="100%" />
</p>

リポジトリの保守は、誰も予定に組み込まない仕事です。届いたものをラベル付けし、diff をきちんと読み、翻訳ドキュメント同士がずれないように保つ。モデルはそのほとんどをこなせます——しかし、モデルに書き込みトークンを渡すのが安全なのは、モデルに許された行動がプロンプト以外の何かによって制限されている場合だけです。この三つのアクションは、その境界をコードで描きます。**モデルが API 呼び出しを組み立てることは決してありません——あなたが書いたリストから選ぶだけで、取り消せない操作や人間にメールを送る操作は、そのリストに載せることができません**。そして、スレッドや diff から読み取るものはすべて証拠であって、指示ではありません。

- **一つのアクションに一つの責務** —— `review` だけを採用して、他は何も採用しないという選択ができます。各ディレクトリが一つの完全なアクションであり、互いに共有されるのは小さなランタイム層だけです。
- **ランナーには何もインストールしません** —— ランナー自身の Node 24 上で、ソースから直接実行される JavaScript アクションです。`dist/` も `node_modules` も `npm install` ステップもなく、開始までのネットワークアクセスもありません。
- **任意の OpenAI 互換モデル** —— キーありでもキーなしでも、ホスト済みでも自前でも。境界を越えるのは chat-completions プロトコルだけなので、無料枠のエンドポイントも「劣化版」ではなく支援された経路です。
- **価値のある場所ではエージェント的に** —— `review` は何を読むかを自分で決め、主張する前に検証し、あなたの diff を切り詰める代わりに自分のトランスクリプトを圧縮します。
- **私たちのプロンプトではなく、あなたのワークフローで境界を定める** —— 設定が振る舞いを記述し、`permissions:` ブロックがセキュリティの境界です。

> **ステータス: リリース済み。** すべてのタグを固定できます——浮動タグはマイナーバージョン系の最新パッチを追従し、完全タグは決して動きません——そして以下の例は解決されます。どちらを使うべきかは [Pinning strategy](#pinning-strategy) を参照してください。[CHANGELOG.md](CHANGELOG.md) には、何がいつリリースされたかが記録されています。

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

すべての `uses:` 参照は、実行されるコードを制御する ref を取ります。安全性の高い順に、三つの形があります：

| Ref                  | Example                                 | What it resolves to                                                     |
| -------------------- | --------------------------------------- | ----------------------------------------------------------------------- |
| `v0.12` (floating)   | `ecoma-io/action-agents/review@v0.12`   | The latest patch release in the `v0.12` line. Gets fixes automatically. |
| `v0.12.0` (exact)    | `ecoma-io/action-agents/review@v0.12.0` | Exactly that release. Never moves.                                      |
| `<sha>` (SHA-pinned) | `ecoma-io/action-agents/review@abc123…` | Exactly those bytes. Immutable.                                         |

浮動タグ（`v0.10`、`v0.11`、`v0.12`）はワークフローの編集なしでパッチを届けます——それが通常は望ましい形です。完全タグは再現性を届けます——それが欲しい場面で使う形です。コミット SHA は監査の道筋を届けます——最も強い固定であり、セキュリティポリシーエンジンが強制するものです。

**`@main` は使わないでください。** `main` へのプッシュは、いつでもアクションの動作を変え得ます——まだリリースされていない方法も含めて。公開された ref はすべて、宣言された互換性ラインの中で、不変か浮動かのどちらかです。

リポジトリに属し、個々のワークフローには属さない振る舞いは、`.github/action-agents/<action>/<action>.json5` に置きます——アクションごとに一つのファイルで、そのアクション固有のファイルと同じ場所に置かれます。これはアクションの**解決済みポリシーソース**から読み込まれます——ほとんどのイベントではデフォルトブランチ、プルリクエストではその base ブランチ——不変のコミット SHA においてです。したがって、プルリクエストは自分を支配するポリシーを編集できず、実行途中に届くプッシュも、実行が途中まで読んだ内容を変えることはできません。どのアクションも、このファイルなしで動作します。ファイルはポリシーを追加するのであって、実行を妨げるものではありません——`harmonise` だけは例外で、何もない状態で緑で通す代わりに拒否します。その理由は開発ページに記載されています。散文の設定——レビューのルーブリックや、文書が照合される言語——は、アクションの設定ファイルが指す markdown ファイルです。散文は文書に属するからです。

## The actions

|                                          |                                                                                                                                                                                                                         |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [**`triage`**](triage/action.yaml)       | 宣言したラベル表に基づいて issue と pull request を分類します。境界のあるモデル評価が決定的ポリシーに入力され、変更が決定されます——ラベルとコメント一件だけ、それ以外は何もありません——サイズは diff から測定されます。 |
| [**`review`**](review/action.yaml)       | pull request をエージェントとしてレビューします。何を読むかを決め、何かを主張する前に検索して検証し、所見をコメントします。                                                                                             |
| [**`harmonise`**](harmonise/action.yaml) | リポジトリのドキュメントの多言語版同士を、意味的に歩調を合わせて保ちます。                                                                                                                                              |

`review` はリポジトリ内部から作成されたプルリクエスト向けに設計されています。フォークをカバーするために `pull_request_target` を使いたくなったら、まず [SECURITY.md](SECURITY.md) を読んでください。そのトリガーの下でフォークの head をチェックアウトすることは**あなたの**リポジトリの脆弱性であり、どのアクションもあなたのために修正することはできません。

### The root action

リポジトリのルートには `action.yml` がありますが、それは**実行可能なアクションではありません**。`uses: ecoma-io/action-agents@v0.12.0` がマニフェスト欠落エラーで失敗する代わりに、タグに対して解決されるために存在します。呼び出されると、三つの実際のアクションを挙げて、一つを選ぶように伝えるエラーで即座に失敗します。これは [github/codeql-action](https://github.com/github/codeql-action) が確立したパターンに従ったもので、ルートのスタブが、リポジトリを単一のアクションとして誤って使うのを防ぎます。

**`uses:` 行では、常に具体的なアクションディレクトリ**（`triage`、`review`、または `harmonise`）**を参照してください**。

## Documentation

|                                       |                                                            |
| ------------------------------------- | ---------------------------------------------------------- |
| [**Security**](SECURITY.md)           | 脅威モデル、上限、および脆弱性の報告方法                   |
| [**Contributing**](CONTRIBUTING.md)   | プルリクエストが評価されるすべての基準                     |
| [For agents](AGENTS.md)               | このリポジトリで作業する AI エージェントのための、同じ土台 |
| [Code of Conduct](CODE_OF_CONDUCT.md) | ここで参加するために求められること                         |

完全な索引: [**docs/**](docs/README.md) —— 必要になった分だけ書かれ、まだ存在しないページについて正直に述べています。

## Contributing

最も価値のある貢献は、**許可された範囲を超えて行動したアクション**です——意図したメンテナーがいないコメント、ワークスペースから逃げ出した読み取り、ログに到達した鍵。それは issue ではなくセキュリティレポートです: [SECURITY.md](SECURITY.md)。それ以外はすべて——[CONTRIBUTING.md](CONTRIBUTING.md) · [Code of Conduct](CODE_OF_CONDUCT.md)。

## License

[Apache License 2.0](LICENSE) — © Mai Ngọc Hóa (John Martin) と Action Agents のコントリビューター。明示的な特許許諾のための Apache-2.0。
