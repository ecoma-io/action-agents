<!-- harmonise:skip-start -->
<p align="center">
  <a href="https://github.com/ecoma-io/action-agents/actions/workflows/ci.yml"><img src="https://github.com/ecoma-io/action-agents/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/ecoma-io/action-agents/actions/workflows/analysis.yml"><img src="https://github.com/ecoma-io/action-agents/actions/workflows/analysis.yml/badge.svg" alt="Analysis" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License: Apache 2.0" /></a>
  <a href="https://github.com/ecoma-io/action-agents/releases"><img src="https://img.shields.io/github/v/release/ecoma-io/action-agents.svg" alt="Latest release" /></a>
</p>
<!-- harmonise:skip-end -->

<p align="center">
  <img src=".github/assets/logo.png" alt="Action Agents — GitHub Actions confiáveis, limitadas e auditáveis para a manutenção de repositórios: triage, review e harmonise, cada uma uma ação autossuficiente com qualquer modelo OpenAI-compatible" width="64px" />
</p>
<h1 align="center">Action Agents</h1>

<!-- harmonise:skip-start -->
<p align="center">
<a href="README.md">English</a> | <a href="README.vi.md">Tiếng Việt</a> | <a href="README.zh.md">中文</a> | <a href="README.ja.md">日本語</a> | <a href="README.es.md">Español</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.ar.md">العربية</a> | <a href="README.pt.md">Português</a> | <a href="README.bn.md">বাংলা</a> | <a href="README.ru.md">Русский</a> | <a href="README.fr.md">Français</a>
</p>
<!-- harmonise:skip-end -->

<p align="center">
  <strong>GitHub Actions confiáveis, limitadas e auditáveis para a manutenção de repositórios.</strong><br />
  Três ações, uma responsabilidade cada — triage, review, harmonise — rodando
  dentro do GitHub Actions com qualquer modelo OpenAI-compatible, inclusive um
  que você mesmo hospeda. Nenhum pacote para confiar, nenhuma dependência para
  auditar, nenhuma instalação antes de começarem.<br />
  <em>O que o runner executa é o código-fonte que você pode ler na tag que você fixou.</em>
</p>

<p align="center">
  <a href="docs/README.md">Documentação</a> ·
  <a href="https://github.com/ecoma-io/action-agents/issues/new?template=bug_report.yml">Reportar um bug</a> ·
  <a href="https://github.com/ecoma-io/action-agents/issues/new?template=feature_request.yml">Sugerir um recurso</a>
</p>

<p align="center">
  <img src=".github/assets/banner.png" alt="Action Agents — GitHub Actions confiáveis, limitadas e auditáveis para a manutenção de repositórios: triage, review e harmonise, cada uma uma ação autossuficiente com qualquer modelo OpenAI-compatible" width="100%" />
</p>

A manutenção de um repositório é o trabalho que ninguém agenda: rotular o que chega, ler um diff corretamente, evitar que os documentos traduzidos divirjam. Um modelo consegue fazer a maior parte disso — mas entregar a um modelo um token de escrita só é seguro se o que ele pode fazer estiver limitado por algo além do prompt. Essas três ações traçam esse limite no código: **um modelo nunca monta uma chamada de API — ele escolhe de uma lista que você escreveu, e nada que seja irreversível, ou que envie e-mail a um humano, pode entrar nessa lista** — e tudo o que é lido de uma thread ou de um diff é evidência, nunca instrução.

- **Uma ação, uma responsabilidade** — adote o `review` sem adotar mais nada. Cada diretório é uma ação completa, e nada é compartilhado entre elas além de uma pequena camada de runtime.
- **Nada instalado no seu runner** — uma ação JavaScript rodando no Node 24 do próprio runner, direto do seu código-fonte. Sem `dist/`, sem `node_modules`, sem passo de `npm install`, sem rede antes de começar.
- **Qualquer modelo OpenAI-compatible** — com ou sem chave, hospedado ou seu. O protocolo chat-completions é tudo o que cruza a fronteira, então um endpoint de plano gratuito é um caminho suportado, não um caminho degradado.
- **Agêntico onde compensa** — o `review` decide o que ler, verifica antes de afirmar e compacta o próprio registro em vez de truncar o seu diff.
- **Limitado pelo seu workflow, não pelo nosso prompt** — a configuração descreve o comportamento; o bloco `permissions:` é a fronteira de segurança.

> **Status: lançado.** Toda tag é fixável — as tags flutuantes acompanham o patch mais recente da sua linha menor, as tags exatas nunca se movem — e o exemplo abaixo resolve. Veja [Pinning strategy](#pinning-strategy) para saber qual usar; [CHANGELOG.md](CHANGELOG.md) registra o que foi lançado e quando.

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

Cada referência `uses:` recebe um ref que controla qual código é executado. Três formatos, em ordem de segurança:

| Ref                  | Example                                 | What it resolves to                                                     |
| -------------------- | --------------------------------------- | ----------------------------------------------------------------------- |
| `v0.12` (floating)   | `ecoma-io/action-agents/review@v0.12`   | The latest patch release in the `v0.12` line. Gets fixes automatically. |
| `v0.12.0` (exact)    | `ecoma-io/action-agents/review@v0.12.0` | Exactly that release. Never moves.                                      |
| `<sha>` (SHA-pinned) | `ecoma-io/action-agents/review@abc123…` | Exactly those bytes. Immutable.                                         |

As tags flutuantes (`v0.10`, `v0.11`, `v0.12`) entregam patches sem editar o workflow — geralmente é o que você quer. As tags exatas entregam reprodutibilidade — é o que você quer quando precisa dela. Um SHA de commit entrega uma trilha de auditoria — o pino mais forte, e o que os mecanismos de política de segurança impõem.

**Não use `@main`.** Um push para `main` pode mudar o que a ação faz a qualquer momento, inclusive de formas ainda não lançadas. Cada ref publicado é imutável ou flutuante dentro de uma linha de compatibilidade declarada.

O comportamento que pertence ao repositório, e não a um workflow específico, vive em `.github/action-agents/<action>/<action>.json5` — um arquivo por ação, junto dos arquivos específicos dela. Ele é lido da **fonte de política resolvida** da ação — o branch padrão na maioria dos eventos, o branch base do pull request em pull requests — em um SHA de commit imutável, então um pull request não pode editar a política que o governa, e um push que chega no meio da execução não pode mudar o que uma execução lê pela metade. Toda ação roda sem o seu arquivo: o arquivo adiciona política, nunca bloqueia a execução — `harmonise` é a exceção, recusando em vez de passar verde no vazio, pelo motivo que sua página de desenvolvimento carrega. Configurações em prosa — um roteiro de revisão, o idioma contra o qual um documento é harmonizado — são arquivos markdown para os quais o arquivo de configuração da ação aponta, porque prosa pertence a um documento.

## The actions

|                                          |                                                                                                                                                                                                                                     |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [**`triage`**](triage/action.yaml)       | Classifies issues and pull requests against a label sheet you declare; a bounded model assessment feeds a deterministic policy that decides the mutation — labels and one comment, nothing else — with size measured from the diff. |
| [**`review`**](review/action.yaml)       | Reviews a pull request as an agent: it decides what to read, searches and verifies before it claims anything, and comments findings.                                                                                                |
| [**`harmonise`**](harmonise/action.yaml) | Keeps the multilingual versions of a repository's documentation semantically in step with one another.                                                                                                                              |

O `review` foi projetado para pull requests abertos dentro do próprio repositório. Se você tiver vontade de usar `pull_request_target` para cobrir forks, leia [SECURITY.md](SECURITY.md) primeiro: fazer checkout do head de um fork sob esse gatilho é uma vulnerabilidade no **seu** repositório, e nenhuma ação pode corrigir isso por você.

### The root action

A raiz do repositório contém um `action.yml`, mas ele **não é uma ação executável**. Ele existe para que `uses: ecoma-io/action-agents@v0.12.0` resolva para uma tag em vez de falhar com erro de manifesto ausente. Quando invocado, ele falha imediatamente com um erro que nomeia as três ações reais e manda você escolher uma. Isso segue o padrão estabelecido por [github/codeql-action](https://github.com/github/codeql-action), em que o stub da raiz impede o uso acidental do repositório como se fosse uma única ação.

**Sempre referencie um diretório de ação específico** (`triage`, `review` ou `harmonise`) na sua linha `uses:`.

## Documentation

|                                       |                                                                   |
| ------------------------------------- | ----------------------------------------------------------------- |
| [**Security**](SECURITY.md)           | The threat model, the ceilings, and how to report a vulnerability |
| [**Contributing**](CONTRIBUTING.md)   | Everything a pull request is judged on                            |
| [For agents](AGENTS.md)               | The same ground, for an AI agent working on this repository       |
| [Code of Conduct](CODE_OF_CONDUCT.md) | What taking part here requires                                    |

Índice completo: [**docs/**](docs/README.md) — escrito à medida que é merecido, e honesto sobre quais páginas ainda não existem.

## Contributing

A contribuição mais valiosa é **uma ação agindo fora do que lhe é permitido fazer** — um comentário escrito que nenhum mantenedor pretendia, uma leitura que escapou do workspace, uma chave que chegou a um log. Isso é um relatório de segurança, não uma issue: [SECURITY.md](SECURITY.md). Todo o resto — [CONTRIBUTING.md](CONTRIBUTING.md) · [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[Apache License 2.0](LICENSE) — © Mai Ngọc Hóa (John Martin) e os contribuidores do Action Agents. Apache-2.0 pela sua concessão explícita de patentes.
