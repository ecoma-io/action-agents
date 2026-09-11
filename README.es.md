<p align="center">
  <img src=".github/assets/banner.png" alt="Action Agents — Acciones de GitHub confiables, acotadas y auditables para el mantenimiento de repositorios: triage, review y harmonise, cada una una acción autocontenida frente a cualquier modelo compatible con OpenAI" width="100%" />
</p>

<h1 align="center">Action Agents</h1>

<p align="center">
  <strong>Acciones de GitHub confiables, acotadas y auditables para el mantenimiento de repositorios.</strong><br />
  Tres acciones, cada una con una única responsabilidad — triage, review, harmonise — que se ejecutan dentro de GitHub Actions frente a cualquier modelo compatible con OpenAI, incluido uno que alojes tú mismo. Nada que confiar a ciegas, ninguna dependencia que auditar, ninguna instalación antes de que empiecen.<br />
  <em>Lo que ejecuta el runner es el código fuente que puedes leer en la etiqueta que fijaste.</em>
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

El mantenimiento del repositorio es el trabajo que nadie agenda: etiquetar lo que llega, leer un diff como es debido, evitar que las traducciones de la documentación se separen. Un modelo puede hacer casi todo — pero darle a un modelo un token de escritura solo es seguro si lo que puede hacer está limitado por algo más que el prompt. Estas tres acciones trazan ese límite en código: **un modelo nunca compone una llamada a la API — elige de una lista que tú escribiste, y nada que sea irreversible, o que envíe un correo a un humano, puede estar en esa lista** — y todo lo que se lee de un hilo o de un diff es evidencia, nunca una instrucción.

- **Una acción, una responsabilidad** — adopta `review` sin adoptar nada más. Cada directorio es una acción completa, y entre ellas no se comparte nada salvo una pequeña capa de runtime.
- **Nada instalado en tu runner** — una acción JavaScript que corre sobre el Node 24 del propio runner, directamente desde su código fuente. Sin `dist/`, sin `node_modules`, sin paso de `npm install`, sin red antes de que empiece.
- **Cualquier modelo compatible con OpenAI** — con clave o sin clave, alojado o propio. El protocolo chat-completions es todo lo que cruza la frontera, así que un endpoint de nivel gratuito es un camino soportado, no uno degradado.
- **Agéntico donde lo merece** — `review` decide qué leer, verifica antes de afirmar y compacta su propio transcript en lugar de truncar tu diff.
- **Limitado por tu workflow, no por nuestro prompt** — la configuración describe el comportamiento; el bloque `permissions:` es la frontera de seguridad.

> **Estado: publicado.** Todas las etiquetas se pueden fijar — las etiquetas flotantes siguen el último parche de su línea menor, las etiquetas exactas nunca se mueven — y el ejemplo de abajo se resuelve. Consulta [Pinning strategy](#pinning-strategy) para saber cuál usar; [CHANGELOG.md](CHANGELOG.md) registra qué se publicó y cuándo.

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

Cada referencia `uses:` toma un ref que controla qué código se ejecuta. Tres formas, en orden de seguridad:

| Ref                  | Example                                 | What it resolves to                                                     |
| -------------------- | --------------------------------------- | ----------------------------------------------------------------------- |
| `v0.12` (floating)   | `ecoma-io/action-agents/review@v0.12`   | The latest patch release in the `v0.12` line. Gets fixes automatically. |
| `v0.12.0` (exact)    | `ecoma-io/action-agents/review@v0.12.0` | Exactly that release. Never moves.                                      |
| `<sha>` (SHA-pinned) | `ecoma-io/action-agents/review@abc123…` | Exactly those bytes. Immutable.                                         |

Las etiquetas flotantes (`v0.10`, `v0.11`, `v0.12`) entregan parches sin editar el workflow — normalmente eso es lo que quieres. Las etiquetas exactas entregan reproducibilidad — eso es lo que quieres cuando la necesitas. Un SHA de commit entrega una pista de auditoría — el fijado más fuerte, y lo que exigen los motores de política de seguridad.

**No uses `@main`.** Un push a `main` puede cambiar lo que hace la acción en cualquier momento, incluso de maneras que aún no se han publicado. Cada ref publicado es inmutable o flota dentro de una línea de compatibilidad declarada.

El comportamiento que pertenece al repositorio más que a un workflow en particular vive en `.github/action-agents/<action>/<action>.json5` — un archivo por acción, ubicado junto a los archivos específicos de la acción. Se lee desde la **fuente de política resuelta** de la acción — la rama predeterminada en la mayoría de los eventos, la rama base del pull request en los pull requests — en un SHA de commit inmutable, de modo que un pull request no puede editar la política que lo gobierna, y un push que llega a mitad de una ejecución no puede cambiar lo que una ejecución lee a mitad de camino. Cada acción se ejecuta sin su archivo: el archivo añade política, nunca bloquea la ejecución — `harmonise` es la excepción, que se niega en lugar de pasar en verde sin nada, por la razón que su página de desarrollo explica. Los ajustes en prosa — una rúbrica de revisión, el idioma contra el que se armoniza un documento — son archivos markdown a los que apunta el archivo de configuración de la acción, porque la prosa pertenece a un documento.

## The actions

|                                          |                                                                                                                                                                                                                                                                |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [**`triage`**](triage/action.yaml)       | Clasifica issues y pull requests frente a una hoja de etiquetas que declaras; una evaluación acotada del modelo alimenta una política determinista que decide la mutación — etiquetas y un solo comentario, nada más — con el tamaño medido a partir del diff. |
| [**`review`**](review/action.yaml)       | Revisa un pull request como un agente: decide qué leer, busca y verifica antes de afirmar nada, y comenta los hallazgos.                                                                                                                                       |
| [**`harmonise`**](harmonise/action.yaml) | Mantiene las versiones multilingües de la documentación de un repositorio en sintonía semántica entre sí.                                                                                                                                                      |

`review` está diseñado para pull requests abiertos desde dentro del repositorio. Si te tienta usar `pull_request_target` para cubrir los forks, lee primero [SECURITY.md](SECURITY.md): hacer checkout de la cabeza de un fork bajo ese trigger es una vulnerabilidad en **tu** repositorio, y ninguna acción puede arreglarlo por ti.

### The root action

La raíz del repositorio contiene un `action.yml`, pero **no es una acción ejecutable**. Existe para que `uses: ecoma-io/action-agents@v0.12.0` se resuelva contra una etiqueta en lugar de fallar con un error de manifiesto ausente. Cuando se invoca, falla de inmediato con un error que nombra las tres acciones reales y te dice que elijas una. Esto sigue el patrón establecido por [github/codeql-action](https://github.com/github/codeql-action), donde el stub de la raíz evita el uso accidental del repositorio como si fuera una sola acción.

**Siempre referencia un directorio de acción específico** (`triage`, `review` o `harmonise`) **en tu línea `uses:`.**

## Documentation

|                                       |                                                                        |
| ------------------------------------- | ---------------------------------------------------------------------- |
| [**Security**](SECURITY.md)           | El modelo de amenazas, los límites y cómo reportar una vulnerabilidad  |
| [**Contributing**](CONTRIBUTING.md)   | Todo aquello por lo que se juzga un pull request                       |
| [For agents](AGENTS.md)               | El mismo terreno, para un agente de IA que trabaje en este repositorio |
| [Code of Conduct](CODE_OF_CONDUCT.md) | Lo que exige participar aquí                                           |

Índice completo: [**docs/**](docs/README.md) — escrito a medida que se gana, y honesto sobre qué páginas aún no existen.

## Contributing

La contribución más valiosa es **una acción que actúa fuera de lo que se le permite hacer** — un comentario escrito que ningún mantenedor quiso, una lectura que escapó del workspace, una clave que llegó a un log. Eso es un reporte de seguridad, no un issue: [SECURITY.md](SECURITY.md). Todo lo demás — [CONTRIBUTING.md](CONTRIBUTING.md) · [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[Apache License 2.0](LICENSE) — © Mai Ngọc Hóa (John Martin) y los contribuyentes de Action Agents. Apache-2.0 por su concesión explícita de patentes.

---

<p align="center">
  <sub>
    Mantenido por <a href="https://ecoma.io">Ecoma</a> ·
    <a href="https://ecoma.io">Website</a> ·
    <a href="https://github.com/ecoma-io">Github</a>
  </sub>
</p>
