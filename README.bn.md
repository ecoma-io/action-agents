<p align="center">
  <img src=".github/assets/banner.png" alt="Action Agents — বিশ্বস্ত, সীমাবদ্ধ, নিরীক্ষাযোগ্য GitHub Actions রিপোজিটরি রক্ষণাবেক্ষণের জন্য: triage, review এবং harmonise — প্রতিটি একটি স্বয়ংসম্পূর্ণ অ্যাকশন, যেকোনো OpenAI-compatible মডেলের বিরুদ্ধে কাজ করে" width="100%" />
</p>

<h1 align="center">Action Agents</h1>

<p align="center">
  <strong>রিপোজিটরি রক্ষণাবেক্ষণের জন্য বিশ্বস্ত, সীমাবদ্ধ, নিরীক্ষাযোগ্য GitHub Actions।</strong><br />
  তিনটি অ্যাকশন, প্রতিটির একটি করে দায়িত্ব — triage, review, harmonise — GitHub Actions-এর ভেতরে চলে যেকোনো OpenAI-compatible মডেলের বিরুদ্ধে, যার মধ্যে আপনার নিজের হোস্ট করা মডেলও রয়েছে।
  বিশ্বাস করার মতো কোনো বান্ডল নেই, নিরীক্ষা করার মতো কোনো নির্ভরতা নেই, শুরু করার আগে কোনো ইনস্টল নেই।<br />
  <em>রানার যা নির্বাহ করে তা হলো সেই সোর্স, যা আপনি যে ট্যাগে পিন করেছেন সেখানে পড়তে পারেন।</em>
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

রিপোজিটরি রক্ষণাবেক্ষণ সেই কাজ যা কেউ সময়সূচি করে না: আসা জিনিসগুলিতে লেবেল দেওয়া, একটি diff সঠিকভাবে পড়া, অনূদিত ডকুমেন্টগুলো পরস্পর থেকে বিচ্ছিন্ন হতে না দেওয়া। একটি মডেল এগুলোর অধিকাংশই করতে পারে — কিন্তু একটি মডেলকে write টোকেন দেওয়া তখনই নিরাপদ, যখন এটি কী করতে পারে তা প্রম্পট ছাড়া অন্য কিছু দ্বারা সীমাবদ্ধ। এই তিনটি অ্যাকশন সেই সীমানা কোডে আঁকে: **একটি মডেল কখনো API কল রচনা করে না — এটি আপনার লেখা একটি তালিকা থেকে বেছে নেয়, এবং যা কিছু অপরিবর্তনীয়, বা যা কোনো মানুষকে মেইল পাঠায়, তা সেই তালিকায় অনুমোদিত নয়**, আর থ্রেড বা diff থেকে পড়া প্রতিটি জিনিস প্রমাণ, কখনোই নির্দেশনা নয়।

- **একটি অ্যাকশন, একটি দায়িত্ব** — `review` গ্রহণ করুন অন্য কিছু গ্রহণ না করেই। প্রতিটি ডিরেক্টরি একটি সম্পূর্ণ অ্যাকশন, এবং তাদের মধ্যে শুধু একটি ছোট রানটাইম স্তর ছাড়া আর কিছুই ভাগ করা হয় না।
- **আপনার রানারে কিছুই ইনস্টল হয় না** — একটি JavaScript অ্যাকশন, যা রানারের নিজস্ব Node 24-এ সরাসরি তার সোর্স থেকে চলে। কোনো `dist/` নেই, কোনো `node_modules` নেই, কোনো `npm install` ধাপ নেই, শুরু হওয়ার আগে কোনো নেটওয়ার্ক নেই।
- **যেকোনো OpenAI-compatible মডেল** — কীসহ বা কীহীন, হোস্ট করা বা আপনার নিজের। chat-completions প্রোটোকলই সীমান্ত অতিক্রমকারী একমাত্র বিষয়, তাই একটি ফ্রি-টিয়ার endpoint একটি সমর্থিত পথ, অবনমিত পথ নয়।
- **Agentic যেখানে এটি মূল্যবান** — `review` নিজে ঠিক করে কী পড়বে, দাবি করার আগে যাচাই করে, এবং আপনার diff ছেঁটে ফেলার বদলে নিজের ট্রান্সক্রিপ্ট সংকুচিত করে।
- **আমাদের প্রম্পট নয়, আপনার ওয়ার্কফ্লো দ্বারা সীমাবদ্ধ** — কনফিগারেশন আচরণ বর্ণনা করে; `permissions:` ব্লকই নিরাপত্তা সীমানা।

> **অবস্থা: প্রকাশিত।** প্রতিটি ট্যাগ পিনযোগ্য — ভাসমান ট্যাগগুলো তাদের মাইনর লাইনের সর্বশেষ প্যাচ অনুসরণ করে, সঠিক ট্যাগগুলো কখনো নড়ে না — এবং নিচের উদাহরণটি রেজলভ হয়। কোনটি ব্যবহার করবেন তা দেখুন [Pinning strategy](#pinning-strategy); [CHANGELOG.md](CHANGELOG.md) লিপিবদ্ধ করে কী এবং কখন প্রকাশিত হয়েছে।

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

Every `uses:` reference takes a ref that controls what code runs. Three shapes,
in order of safety:

| Ref                  | Example                                 | What it resolves to                                                     |
| -------------------- | --------------------------------------- | ----------------------------------------------------------------------- |
| `v0.12` (floating)   | `ecoma-io/action-agents/review@v0.12`   | The latest patch release in the `v0.12` line. Gets fixes automatically. |
| `v0.12.0` (exact)    | `ecoma-io/action-agents/review@v0.12.0` | Exactly that release. Never moves.                                      |
| `<sha>` (SHA-pinned) | `ecoma-io/action-agents/review@abc123…` | Exactly those bytes. Immutable.                                         |

ভাসমান ট্যাগ (`v0.10`, `v0.11`, `v0.12`) ওয়ার্কফ্লো সম্পাদনা ছাড়াই প্যাচ সরবরাহ করে — সাধারণত এটিই আপনি চান। সঠিক ট্যাগ প্রতিলিপিযোগ্যতা সরবরাহ করে — যখন প্রয়োজন হয় তখন এটিই চান। একটি commit SHA নিরীক্ষা-পথ সরবরাহ করে — সবচেয়ে শক্ত পিন, যা নিরাপত্তা নীতি ইঞ্জিন প্রয়োগ করে।

**`@main` ব্যবহার করবেন না।** `main`-এ একটি push যেকোনো সময় অ্যাকশনের আচরণ বদলে দিতে পারে, যার মধ্যে এমন উপায়ও রয়েছে যা এখনো প্রকাশিত হয়নি। প্রতিটি প্রকাশিত ref অপরিবর্তনীয়, অথবা একটি ঘোষিত সামঞ্জস্য লাইনের মধ্যে ভাসমান।

রিপোজিটরির অন্তর্গত আচরণ, কোনো একটি ওয়ার্কফ্লোর নয়, থাকে `.github/action-agents/<action>/<action>.json5`-এ — প্রতি অ্যাকশনে একটি ফাইল, তার অ্যাকশন-নির্দিষ্ট ফাইলগুলির পাশে সহাবস্থানে। এটি অ্যাকশনের **সমাধানকৃত নীতি-উৎস** থেকে পড়া হয় — বেশিরভাগ ইভেন্টে ডিফল্ট ব্রাঞ্চ, pull request-গুলিতে pull request-এর বেস ব্রাঞ্চ — একটি অপরিবর্তনীয় commit SHA-তে, তাই একটি pull request তার শাসক নীতি সম্পাদনা করতে পারে না, এবং রানের মাঝখানে আসা একটি push কোনো রান অর্ধেক পথে যা পড়ছে তা বদলাতে পারে না। প্রতিটি অ্যাকশন তার ফাইল ছাড়াই চলে: ফাইলটি নীতি যোগ করে, এটি কখনো নির্বাহ আটকায় না — `harmonise` ব্যতিক্রম, কোনো কিছু ছাড়া সবুজ চালানোর বদলে অস্বীকার করে, তার ডেভেলপমেন্ট পৃষ্ঠায় যে কারণে বর্ণিত হয়েছে তার জন্য। গদ্য সেটিংস — একটি রিভিউ রুব্রিক, কোনো দলিল যে ভাষার সাথে সামঞ্জস্যপূর্ণ করা হয় — হলো মার্কডাউন ফাইল যেগুলির দিকে অ্যাকশনের কনফিগ ফাইল ইঙ্গিত করে, কারণ গদ্য একটি দলিলে থাকে।

## The actions

|                                          |                                                                                                                                                                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [**`triage`**](triage/action.yaml)       | আপনার ঘোষিত লেবেল-তালিকার বিরুদ্ধে issue ও pull request শ্রেণিবদ্ধ করে; একটি সীমাবদ্ধ মডেল মূল্যায়ন একটি নির্ণায়ক নীতি খাওয়ায়, যা মিউটেশন সিদ্ধান্ত নেয় — লেবেল এবং একটি মন্তব্য, আর কিছুই নয় — আকার diff থেকে মাপা হয়। |
| [**`review`**](review/action.yaml)       | একটি pull request agent হিসেবে রিভিউ করে: এটি নিজে ঠিক করে কী পড়বে, কিছু দাবি করার আগে অনুসন্ধান ও যাচাই করে, এবং ফলাফল মন্তব্য করে।                                                                                          |
| [**`harmonise`**](harmonise/action.yaml) | রিপোজিটরির ডকুমেন্টেশনের বহুভাষিক সংস্করণগুলোকে পরস্পরের সাথে শব্দার্থিকভাবে সঙ্গতিপূর্ণ রাখে।                                                                                                                                 |

`review` রিপোজিটরির ভেতর থেকে উত্থাপিত pull request-গুলির জন্য ডিজাইন করা। fork কভার করতে যদি `pull_request_target` ব্যবহার করতে ইচ্ছা হয়, আগে [SECURITY.md](SECURITY.md) পড়ুন: সেই ট্রিগারের অধীনে একটি fork-এর head চেকআউট করা **আপনার** রিপোজিটরিতে একটি দুর্বলতা, এবং কোনো অ্যাকশন তা আপনার পক্ষে ঠিক করতে পারে না।

### The root action

রিপোজিটরি রুটে একটি `action.yml` আছে, কিন্তু এটি **চালানোর যোগ্য অ্যাকশন নয়**। এটি এজন্য আছে যেন `uses: ecoma-io/action-agents@v0.12.0` একটি ট্যাগের বিরুদ্ধে সমাধান হয়, অনুপস্থিত-ম্যানিফেস্ট ত্রুটিতে ব্যর্থ হওয়ার বদলে। আহ্বান করলে, এটি অবিলম্বে তিনটি প্রকৃত অ্যাকশনের নাম দিয়ে একটি ত্রুটি দিয়ে ব্যর্থ হয় এবং আপনাকে একটি বেছে নিতে বলে। এটি [github/codeql-action](https://github.com/github/codeql-action) দ্বারা প্রতিষ্ঠিত প্যাটার্ন অনুসরণ করে, যেখানে রুট স্টাবটি রিপোজিটরিকে একটি একক অ্যাকশন হিসেবে ভুলবশত ব্যবহার থেকে বিরত রাখে।

**আপনার `uses:` লাইনে সর্বদা একটি নির্দিষ্ট অ্যাকশন ডিরেক্টরি উল্লেখ করুন** (`triage`, `review`, বা `harmonise`)।

## Documentation

|                                       |                                                          |
| ------------------------------------- | -------------------------------------------------------- |
| [**Security**](SECURITY.md)           | হুমকির মডেল, সীমারেখা, এবং দুর্বলতা কীভাবে রিপোর্ট করবেন |
| [**Contributing**](CONTRIBUTING.md)   | একটি pull request যা বিচার করে তার সব সম্পর্কে           |
| [For agents](AGENTS.md)               | একই ভিত্তি, এই রিপোজিটরিতে কাজ করা একটি AI agent-এর জন্য |
| [Code of Conduct](CODE_OF_CONDUCT.md) | এখানে অংশ নেওয়ার জন্য যা প্রয়োজন                       |

সম্পূর্ণ সূচি: [**docs/**](docs/README.md) — যেমন উপার্জিত হয় তেমন লেখা, এবং কোন পৃষ্ঠাগুলো এখনো নেই সে সম্পর্কে সৎ।

## Contributing

সবচেয়ে মূল্যবান অবদান হলো **একটি অ্যাকশন যা যা করার অনুমতি পেয়েছে তার বাইরে কাজ করা** — এমন একটি মন্তব্য যা কোনো রক্ষণাবেক্ষণকারী লেখেননি, একটি পড়া যা ওয়ার্কস্পেসের বাইরে গেছে, একটি কী যা লগে পৌঁছেছে। এটি একটি সুরক্ষা প্রতিবেদন, কোনো issue নয়: [SECURITY.md](SECURITY.md)। বাকি সব — [CONTRIBUTING.md](CONTRIBUTING.md) · [Code of Conduct](CODE_OF_CONDUCT.md)।

## License

[Apache License 2.0](LICENSE) — © Mai Ngọc Hóa (John Martin) এবং Action Agents অবদানকারীরা। Apache-2.0 এর সুস্পষ্ট পেটেন্ট অনুদানের জন্য।

---

<p align="center">
  <sub>
    রক্ষণাবেক্ষণ করেন <a href="https://ecoma.io">Ecoma</a> ·
    <a href="https://ecoma.io">Website</a> ·
    <a href="https://github.com/ecoma-io">Github</a>
  </sub>
</p>
