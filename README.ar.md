<p align="center">
  <img src=".github/assets/banner.png" alt="Action Agents — إجراءات GitHub موثوقة ومحدودة وقابلة للتدقيق لصيانة المستودعات: triage و review و harmonise، كل واحد إجراء مستقل بذاته مع أي نموذج OpenAI-compatible" width="100%" />
</p>

<h1 align="center">Action Agents</h1>

<p align="center">
  <strong>إجراءات GitHub موثوقة ومحدودة وقابلة للتدقيق لصيانة المستودعات.</strong><br />
  ثلاثة إجراءات، لكل واحد مسؤولية واحدة — triage و review و harmonise — تعمل
  داخل GitHub Actions مع أي نموذج OpenAI-compatible، بما في ذلك نموذج تستضيفه
  بنفسك. لا حزمة تثق بها، ولا تبعية تدققها، ولا تثبيت قبل أن تبدأ.<br />
  <em>ما ينفذه الرنر هو المصدر الذي يمكنك قراءته عند الوسم الذي ثبّتّه.</em>
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

صيانة المستودع هي العمل الذي لا يجدوله أحد: وسم ما وصل، وقراءة diff على نحو صحيح، وإبقاء الوثائق المترجمة متلاقية بدل أن تتباعد. يمكن لنموذج أن ينجز معظم ذلك — لكن منح نموذج رمز كتابة (write token) لا يكون آمنًا إلا إذا كان ما قد يفعله محصورًا بشيء غير الـ prompt. هذه الإجراءات الثلاثة ترسم ذلك الحد في الكود: **النموذج لا يؤلف أبدًا استدعاء API — بل يختار من قائمة كتبتَها أنت، ولا يُسمح في تلك القائمة بأي شيء لا يمكن التراجع عنه أو يرسل بريدًا إلى إنسان**، وكل ما يُقرأ من سلسلة محادثة أو diff هو دليل، لا تعليمات.

- **إجراء واحد، مسؤولية واحدة** — اعتمد `review` دون أن تعتمد أي شيء آخر. كل مجلد إجراء كامل، ولا يُشارَك بينها سوى طبقة runtime صغيرة.
- **لا شيء يُثبَّت على رنرك** — إجراء JavaScript يعمل على Node 24 الخاص بالرنر، مباشرة من مصدره. لا `dist/`، ولا `node_modules`، ولا خطوة `npm install`، ولا شبكة قبل أن يبدأ.
- **أي نموذج OpenAI-compatible** — بمفتاح أو بدونه، مستضاف أو خاص بك. بروتوكول chat-completions هو كل ما يعبر هذه الواجهة، لذا فنقطة نهاية مجانية (endpoint) مسار مدعوم وليس مسارًا مستضعفًا.
- **وكيل بقدر ما يستحق** — `review` يقرر ما يقرأه، ويتحقق قبل أن يدّعي، ويضغط سجلّه الخاص بدلًا من اقتطاع diff الخاص بك.
- **محصور بسير عملك، لا بنصّنا الموجِّه (prompt)** — الإعداد يصف السلوك؛ كتلة `permissions:` هي حد الأمان.

> **الحالة: مُطلق (released).** كل وسم قابل للتثبيت — الوسوم العائمة تتبع أحدث تصحيح في خطها الثانوي، والوسوم الدقيقة لا تتحرك أبدًا — والمثال أدناه قابل للحل. راجع [Pinning strategy](#pinning-strategy) لتعرف أيها تستخدم؛ ويسجّل [CHANGELOG.md](CHANGELOG.md) ما شُحن ومتى.

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

كل مرجع `uses:` يأخذ ref يتحكم في الكود الذي يعمل. ثلاثة أشكال، مرتبة حسب الأمان:

| Ref                  | Example                                 | What it resolves to                                                     |
| -------------------- | --------------------------------------- | ----------------------------------------------------------------------- |
| `v0.12` (floating)   | `ecoma-io/action-agents/review@v0.12`   | The latest patch release in the `v0.12` line. Gets fixes automatically. |
| `v0.12.0` (exact)    | `ecoma-io/action-agents/review@v0.12.0` | Exactly that release. Never moves.                                      |
| `<sha>` (SHA-pinned) | `ecoma-io/action-agents/review@abc123…` | Exactly those bytes. Immutable.                                         |

الوسوم العائمة (`v0.10`, `v0.11`, `v0.12`) توفّر التصحيحات دون تعديل سير العمل — وهذا عادة ما تريده. الوسوم الدقيقة توفّر إعادة الإنتاج — وهذا ما تريده عند الحاجة. SHA لِـcommit يوفّر أثر تدقيق — أقوى تثبيت، وما تنفذه محركات سياسات الأمان.

**لا تستخدم `@main`.** أي push إلى `main` يمكن أن يغيّر ما يفعله الإجراء في أي وقت، بما في ذلك بطرق لم تُطلق بعد. كل ref منشور إما ثابت أو عائم ضمن خط توافق معلَن.

السلوك الذي يخص المستودع لا سير عمل بعينه يعيش في `.github/action-agents/<action>/<action>.json5` — ملف واحد لكل إجراء، بجوار ملفاته الخاصة به. يُقرأ من **مصدر السياسة المُحلول** للإجراء — الفرع الافتراضي في معظم الأحداث، وفرع الأساس لطلب السحب في طلبات السحب — عند SHA ثابت غير قابل للتغيير، فلا يستطيع طلب سحب تعديل السياسة التي تحكمه، ولا يستطيع push يصل أثناء التشغيل تغيير ما يقرؤه التشغيل في منتصف الطريق. كل إجراء يعمل دون ملفه: الملف يضيف سياسة، ولا يمنع التنفيذ أبدًا — `harmonise` هو الاستثناء، إذ يرفض بدل أن يعمل بالأخضر على لا شيء، للسبب الذي تحمله صفحة تطويره. الإعدادات النثرية — معيار مراجعة، اللغة التي يُنسَّق (harmonise) المستند وفقها — ملفات markdown يشير إليها ملف إعداد الإجراء، لأن النثر ينتمي إلى مستند.

## The actions

|                                          |                                                                                                                                                                                                                                     |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [**`triage`**](triage/action.yaml)       | Classifies issues and pull requests against a label sheet you declare; a bounded model assessment feeds a deterministic policy that decides the mutation — labels and one comment, nothing else — with size measured from the diff. |
| [**`review`**](review/action.yaml)       | Reviews a pull request as an agent: it decides what to read, searches and verifies before it claims anything, and comments findings.                                                                                                |
| [**`harmonise`**](harmonise/action.yaml) | Keeps the multilingual versions of a repository's documentation semantically in step with one another.                                                                                                                              |

`review` مصمم لطلبات السحب المرفوعة من داخل المستودع. إذا كنت تميل إلى استخدام `pull_request_target` لتغطية النسخ المتفرعة (forks)، فاقرأ [SECURITY.md](SECURITY.md) أولًا: تسجيل خروج رأس النسخة المتفرعة (checkout) تحت ذلك المحفّز هو ثغرة أمنية في **مستودعك**، ولا يمكن لأي إجراء إصلاحها نيابة عنك.

### The root action

جذر المستودع يحتوي على `action.yml`، لكنه **ليس إجراءً قابلًا للتشغيل**. إنه موجود حتى يُحل `uses: ecoma-io/action-agents@v0.12.0` إلى وسم بدلًا من الفشل بخطأ مفقود-المانيفست. عند استدعائه، يفشل فورًا بخطأ يسمّي الإجراءات الثلاثة الحقيقية ويطلب منك اختيار واحد. هذا يتبع النمط الذي أرساه [github/codeql-action](https://github.com/github/codeql-action)، حيث يمنع الكعب الجذري (stub) الاستخدام العرضي للمستودع كما لو كان إجراءً واحدًا.

**أشر دائمًا إلى مجلد إجراء محدد** (`triage`، `review`، أو `harmonise`) في سطر `uses:` الخاص بك.

## Documentation

|                                       |                                                                   |
| ------------------------------------- | ----------------------------------------------------------------- |
| [**Security**](SECURITY.md)           | The threat model, the ceilings, and how to report a vulnerability |
| [**Contributing**](CONTRIBUTING.md)   | Everything a pull request is judged on                            |
| [For agents](AGENTS.md)               | The same ground, for an AI agent working on this repository       |
| [Code of Conduct](CODE_OF_CONDUCT.md) | What taking part here requires                                    |

الفهرس الكامل: [**docs/**](docs/README.md) — مكتوب كما يُستحق، وصادق بشأن الصفحات التي لا وجود لها بعد.

## Contributing

أثمن مساهمة هي **إجراء يعمل خارج ما هو مصرح به** — تعليق كُتب ولم يقصده أي صيان، وقراءة هربت من مساحة العمل، ومفتاح بلغ سجلًا. هذا تقرير أمني، لا مشكلة (issue): [SECURITY.md](SECURITY.md). وكل ما عداه — [CONTRIBUTING.md](CONTRIBUTING.md) · [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[Apache License 2.0](LICENSE) — © Mai Ngọc Hóa (John Martin) ومساهمو Action Agents. Apache-2.0 لمنح براءات الاختراع الصريح.

---

<p align="center">
  <sub>
    تُصان بواسطة <a href="https://ecoma.io">Ecoma</a> ·
    <a href="https://ecoma.io">Website</a> ·
    <a href="https://github.com/ecoma-io">Github</a>
  </sub>
</p>
