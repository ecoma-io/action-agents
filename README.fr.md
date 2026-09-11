<p align="center">
  <img src=".github/assets/banner.png" alt="Action Agents — des GitHub Actions fiables, bornées et vérifiables pour la maintenance de dépôts : triage, review et harmonise, chacune une action autonome qui fonctionne avec n'importe quel modèle OpenAI-compatible" width="100%" />
</p>

<h1 align="center">Action Agents</h1>

<p align="center">
  <strong>Des GitHub Actions fiables, bornées et vérifiables pour la maintenance de dépôts.</strong><br />
  Trois actions, une responsabilité chacune — triage, review, harmonise — qui s'exécutent dans GitHub Actions avec n'importe quel modèle OpenAI-compatible, y compris celui que vous hébergez vous-même.
  Aucun bundle à approuver, aucune dépendance à auditer, aucune installation avant de démarrer.<br />
  <em>Ce que le runner exécute est la source que vous pouvez lire au tag que vous avez épinglé.</em>
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

L'entretien d'un dépôt est le travail que personne ne planifie : labelliser ce qui arrive, lire un diff correctement, empêcher les traductions de la documentation de diverger. Un modèle peut faire presque tout cela — mais donner un jeton d'écriture à un modèle n'est sûr que si ce qu'il peut faire est borné par autre chose que le prompt. Ces trois actions tracent cette limite dans le code : **un modèle ne compose jamais un appel d'API — il choisit dans une liste que vous avez écrite, et rien d'irréversible, ni rien qui ne prévienne un humain, n'est admis dans cette liste**, et tout ce qui est lu depuis un fil ou un diff est une preuve, jamais une instruction.

- **Une action, une responsabilité** — adoptez `review` sans rien adopter d'autre. Chaque répertoire est une action complète, et rien n'est partagé entre elles qu'une petite couche d'exécution.
- **Rien d'installé sur votre runner** — une action JavaScript qui tourne sur le Node 24 du runner, directement à partir de ses sources. Pas de `dist/`, pas de `node_modules`, pas d'étape `npm install`, pas de réseau avant de démarrer.
- **N'importe quel modèle OpenAI-compatible** — avec ou sans clé, hébergé ou chez vous. Le protocole chat-completions est tout ce qui franchit la frontière, si bien qu'un endpoint gratuit est un chemin pris en charge, pas un chemin dégradé.
- **Agentique là où cela se justifie** — `review` décide de ce qu'il lit, vérifie avant d'affirmer, et compacte son propre transcript plutôt que de tronquer votre diff.
- **Borné par votre workflow, pas par notre prompt** — la configuration décrit le comportement ; le bloc `permissions:` est la frontière de sécurité.

> **Statut : publié.** Chaque tag peut être épinglé — les tags flottants suivent le dernier correctif de leur ligne mineure, les tags exacts ne bougent jamais — et l'exemple ci-dessous se résout. Voir [Pinning strategy](#pinning-strategy) pour lequel utiliser ; [CHANGELOG.md](CHANGELOG.md) consigne ce qui est sorti, et quand.

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

Chaque référence `uses:` prend un ref qui contrôle le code exécuté. Trois formes, par ordre de sécurité :

| Ref                  | Example                                 | What it resolves to                                                     |
| -------------------- | --------------------------------------- | ----------------------------------------------------------------------- |
| `v0.12` (floating)   | `ecoma-io/action-agents/review@v0.12`   | The latest patch release in the `v0.12` line. Gets fixes automatically. |
| `v0.12.0` (exact)    | `ecoma-io/action-agents/review@v0.12.0` | Exactly that release. Never moves.                                      |
| `<sha>` (SHA-pinned) | `ecoma-io/action-agents/review@abc123…` | Exactly those bytes. Immutable.                                         |

Les tags flottants (`v0.10`, `v0.11`, `v0.12`) livrent des correctifs sans modification du workflow — c'est généralement ce que vous voulez. Les tags exacts livrent la reproductibilité — c'est ce que vous voulez quand c'est le cas. Un SHA de commit livre une piste d'audit — l'épingle la plus forte, et ce que font respecter les moteurs de politique de sécurité.

**N'utilisez pas `@main`.** Un push sur `main` peut changer ce que fait l'action à tout moment, y compris de façons non encore publiées. Chaque ref publié est immuable ou flottant dans une ligne de compatibilité déclarée.

Le comportement qui appartient au dépôt plutôt qu'à un workflow vit dans `.github/action-agents/<action>/<action>.json5` — un fichier par action, co-localisé avec ses fichiers spécifiques. Il est lu depuis la **source de politique résolue** de l'action — la branche par défaut sur la plupart des événements, la branche de base du pull request sur les pull requests — à un SHA de commit immuable, si bien qu'un pull request ne peut pas modifier la politique qui le régit et qu'un push arrivant en cours d'exécution ne peut pas changer ce qu'un run lit à mi-chemin. Chaque action fonctionne sans son fichier : le fichier ajoute de la politique, il ne bloque jamais l'exécution — `harmonise` est l'exception, refusant plutôt que de passer au vert sur du vide, pour la raison que porte sa page de développement. Les réglages en prose — une grille de revue, la langue à laquelle un document est harmonisé — sont des fichiers markdown vers lesquels pointe le fichier de configuration de l'action, parce que la prose appartient à un document.

## The actions

|                                          |                                                                                                                                                                                                                                                                               |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [**`triage`**](triage/action.yaml)       | Classe les issues et pull requests selon une grille d'étiquettes que vous déclarez ; une évaluation bornée du modèle alimente une politique déterministe qui décide de la mutation — des étiquettes et un commentaire, rien d'autre — la taille étant mesurée depuis le diff. |
| [**`review`**](review/action.yaml)       | Revoit un pull request comme un agent : il décide de ce qu'il lit, cherche et vérifie avant de rien affirmer, et commente les constats.                                                                                                                                       |
| [**`harmonise`**](harmonise/action.yaml) | Maintient les versions multilingues de la documentation d'un dépôt en phase sémantique les unes avec les autres.                                                                                                                                                              |

`review` est conçu pour les pull requests ouvertes depuis l'intérieur du dépôt. Si vous êtes tenté de recourir à `pull_request_target` pour couvrir les forks, lisez d'abord [SECURITY.md](SECURITY.md) : faire un checkout de la tête d'un fork sous ce déclencheur est une vulnérabilité dans **votre** dépôt, et aucune action ne peut la corriger pour vous.

### The root action

La racine du dépôt contient un `action.yml`, mais ce **n'est pas une action exécutable**. Il existe pour que `uses: ecoma-io/action-agents@v0.12.0` se résolve vers un tag plutôt que d'échouer avec une erreur de manifeste manquant. Invoqué, il échoue immédiatement avec une erreur nommant les trois vraies actions et vous demandant d'en choisir une. Cela suit le modèle établi par [github/codeql-action](https://github.com/github/codeql-action), où la souche racine empêche l'utilisation accidentelle du dépôt comme s'il s'agissait d'une action unique.

**Référencez toujours un répertoire d'action précis** (`triage`, `review` ou `harmonise`) dans votre ligne `uses:`.

## Documentation

|                                       |                                                                         |
| ------------------------------------- | ----------------------------------------------------------------------- |
| [**Security**](SECURITY.md)           | Le modèle de menace, les plafonds et comment signaler une vulnérabilité |
| [**Contributing**](CONTRIBUTING.md)   | Tout ce sur quoi un pull request est jugé                               |
| [For agents](AGENTS.md)               | Le même sujet, pour un agent IA travaillant sur ce dépôt                |
| [Code of Conduct](CODE_OF_CONDUCT.md) | Ce qui est requis pour participer ici                                   |

Index complet : [**docs/**](docs/README.md) — écrit au fil de l'eau, et honnête sur les pages qui n'existent pas encore.

## Contributing

La contribution la plus précieuse est **une action agissant hors de ce qu'elle est autorisée à faire** — un commentaire qu'aucun mainteneur n'a voulu, une lecture qui s'est échappée du workspace, une clé parvenue dans un journal. C'est un rapport de sécurité, pas un issue : [SECURITY.md](SECURITY.md). Tout le reste — [CONTRIBUTING.md](CONTRIBUTING.md) · [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[Apache License 2.0](LICENSE) — © Mai Ngọc Hóa (John Martin) et les contributeurs d'Action Agents. Apache-2.0 pour sa licence de brevet explicite.

---

<p align="center">
  <sub>
    Maintenu par <a href="https://ecoma.io">Ecoma</a> ·
    <a href="https://ecoma.io">Website</a> ·
    <a href="https://github.com/ecoma-io">Github</a>
  </sub>
</p>
