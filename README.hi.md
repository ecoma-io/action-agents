<p align="center">
  <img src=".github/assets/banner.png" alt="Action Agents — विश्वसनीय, सीमित, ऑडिट योग्य GitHub Actions रिपॉज़िटरी अनुरक्षण के लिए: triage, review और harmonise, हर एक किसी भी OpenAI-compatible मॉडल के विरुद्ध एक स्व-निहित एक्शन" width="100%" />
</p>

<h1 align="center">Action Agents</h1>

<p align="center">
  <strong>विश्वसनीय, सीमित, ऑडिट योग्य GitHub Actions, रिपॉज़िटरी अनुरक्षण के लिए।</strong><br />
  तीन एक्शन, हर एक की एक ही ज़िम्मेदारी — triage, review, harmonise — जो
  GitHub Actions के भीतर किसी भी OpenAI-compatible मॉडल के साथ चलते हैं, जिसमें
  वह मॉडल भी शामिल है जिसे आप स्वयं होस्ट करते हैं। भरोसा करने के लिए कोई बंडल नहीं,
  ऑडिट करने के लिए कोई निर्भरता नहीं, शुरू होने से पहले कोई इंस्टॉल नहीं।<br />
  <em>रनर जो निष्पादित करता है, वही स्रोत है जिसे आप उस टैग पर पढ़ सकते हैं जिसे आपने पिन किया था।</em>
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

रिपॉज़िटरी का रख-रखाव वह काम है जिसे कोई निर्धारित नहीं करता: आए हुए इश्यू को
लेबल करना, diff को सही ढंग से पढ़ना, अनूदित दस्तावेज़ों को एक-दूसरे से भटकने से
रोकना। एक मॉडल इसका अधिकांश कर सकता है — लेकिन मॉडल को राइट टोकन सौंपना तभी
सुरक्षित है जब वह जो कर सकता है वह prompt के अलावा किसी और चीज़ से सीमित हो।
ये तीन एक्शन उस सीमा को कोड में खींचते हैं: **एक मॉडल कभी भी API कॉल नहीं
लिखता — वह आपके द्वारा लिखी गई सूची में से चुनता है, और ऐसा कुछ भी जो
अपरिवर्तनीय हो, या किसी इंसान को मेल करता हो, उस सूची में शामिल नहीं हो सकता**,
और किसी थ्रेड या diff से पढ़ी गई हर चीज़ साक्ष्य है, निर्देश नहीं।

- **एक एक्शन, एक ज़िम्मेदारी** — `review` अपनाएं, बिना कुछ और
  अपनाए। हर निर्देशिका एक पूरा एक्शन है, और उनके बीच एक छोटी
  runtime परत के अलावा कुछ साझा नहीं है।
- **आपके रनर पर कुछ भी इंस्टॉल नहीं** — एक JavaScript एक्शन जो रनर के अपने
  Node 24 पर, सीधे उसके स्रोत से चलता है। कोई `dist/` नहीं, कोई
  `node_modules` नहीं, कोई `npm install` चरण नहीं, शुरू होने से पहले कोई नेटवर्क नहीं।
- **कोई भी OpenAI-compatible मॉडल** — चाबी वाला या बिना चाबी, होस्ट किया हुआ या आपका अपना। chat-completions प्रोटोकॉल ही वह सब कुछ है जो इस
  सीमा को पार करता है, इसलिए एक free-tier endpoint एक समर्थित मार्ग है, न कि घटिया विकल्प।
- **जहाँ उपयुक्त हो वहाँ एजेंटिक** — `review` तय करता है कि क्या पढ़ना है,
  दावा करने से पहले सत्यापित करता है, और आपके diff को काटने के
  बजाय अपने स्वयं के प्रतिलेख को संक्षिप्त करता है।
- **आपके वर्कफ़्लो से सीमित, हमारे prompt से नहीं** — कॉन्फ़िगरेशन
  व्यवहार का वर्णन करता है; `permissions:` ब्लॉक ही सुरक्षा सीमा है।

> **स्थिति: जारी (released)।** हर टैग पिन करने योग्य है — फ्लोटिंग टैग अपनी
> माइनर लाइन के नवीनतम पैच का अनुसरण करते हैं, सटीक टैग कभी नहीं
> चलते — और नीचे दिया गया उदाहरण हल हो जाता है। कौन सा उपयोग
> करना है, यह देखें [Pinning strategy](#pinning-strategy); [CHANGELOG.md](CHANGELOG.md)
> दर्ज करता है कि कब क्या जारी हुआ।

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

प्रत्येक `uses:` संदर्भ एक ref लेता है जो नियंत्रित करता है कि कौन सा कोड चलता है।
तीन प्रकार, सुरक्षा के क्रम में:

| Ref                  | Example                                 | What it resolves to                                                     |
| -------------------- | --------------------------------------- | ----------------------------------------------------------------------- |
| `v0.12` (floating)   | `ecoma-io/action-agents/review@v0.12`   | The latest patch release in the `v0.12` line. Gets fixes automatically. |
| `v0.12.0` (exact)    | `ecoma-io/action-agents/review@v0.12.0` | Exactly that release. Never moves.                                      |
| `<sha>` (SHA-pinned) | `ecoma-io/action-agents/review@abc123…` | Exactly those bytes. Immutable.                                         |

फ्लोटिंग टैग (`v0.10`, `v0.11`, `v0.12`) बिना वर्कफ़्लो बदले पैच
वितरित करते हैं — यह आमतौर पर वही है जो आप चाहते हैं। सटीक टैग पुनरुत्पादन
प्रदान करते हैं — यह तब है जब आपको वह चाहिए। एक कमिट SHA ऑडिट ट्रेल
प्रदान करता है — सबसे मज़बूत पिन, और सुरक्षा नीति इंजनों द्वारा लागू
किया जाने वाला।

**`@main` का उपयोग न करें।** `main` में पुश कभी भी एक्शन के काम को बदल सकता
है, जिसमें वे तरीके भी शामिल हैं जो अभी तक जारी नहीं हुए हैं। प्रत्येक प्रकाशित
ref एक घोषित संगतता रेखा के भीतर अपरिवर्तनीय या फ्लोटिंग है।

वह व्यवहार जो रिपॉज़िटरी से संबंधित है न कि किसी एक वर्कफ़्लो से,
`.github/action-agents/<action>/<action>.json5` में रहता है — प्रत्येक
एक्शन के लिए एक फ़ाइल, उसकी एक्शन-विशिष्ट फ़ाइलों के साथ। इसे एक्शन के
**संकलित नीति स्रोत** से पढ़ा जाता है — अधिकांश घटनाओं पर डिफ़ॉल्ट ब्रांच,
पुल रिक्वेस्ट पर पुल रिक्वेस्ट का बेस ब्रांच — एक अपरिवर्तनीय कमिट SHA
पर, ताकि एक पुल रिक्वेस्ट उस नीति को न बदल सके जो उसे नियंत्रित करती है
और चल रहे रन के बीच लैंड होने वाला पुश उसे न बदल दे जो रन आधे रास्ते
पढ़ रहा है। प्रत्येक एक्शन अपनी फ़ाइल के बिना चल सकता है: फ़ाइल नीति जोड़ती है,
निष्पादन को रोकती नहीं — `harmonise` अपवाद है, जो कुछ नहीं होने पर हरा
चलने के बजाय इनकार करता है, उस कारण से जो उसका विकास पेज बताता है।
पद्य विवरण — एक समीक्षा रूब्रिक, भाषा जिसके विरुद्ध कोई दस्तावेज़
harmonised किया जाता है — वे मार्कडाउन फ़ाइलें हैं जिनकी ओर एक्शन कॉन्फ़िग
फ़ाइल इंगित करती है, क्योंकि पद्य एक दस्तावेज़ में होता है।

## The actions

|                                          |                                                                                                                                                                                                                                     |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [**`triage`**](triage/action.yaml)       | Classifies issues and pull requests against a label sheet you declare; a bounded model assessment feeds a deterministic policy that decides the mutation — labels and one comment, nothing else — with size measured from the diff. |
| [**`review`**](review/action.yaml)       | Reviews a pull request as an agent: it decides what to read, searches and verifies before it claims anything, and comments findings.                                                                                                |
| [**`harmonise`**](harmonise/action.yaml) | Keeps the multilingual versions of a repository's documentation semantically in step with one another.                                                                                                                              |

`review` रिपॉज़िटरी के भीतर से उठाए गए पुल रिक्वेस्ट के लिए डिज़ाइन किया
गया है। यदि आप फोर्क्स को कवर करने के लिए `pull_request_target` का उपयोग
करने की सोच रहे हैं, तो पहले [SECURITY.md](SECURITY.md) पढ़ें: उस ट्रिगर
के तहत एक फोर्क के हेड को checkout करना **आपके** रिपॉज़िटरी में एक
भेद्यता है, और कोई एक्शन इसे आपके लिए ठीक नहीं कर सकता।

### The root action

रिपॉज़िटरी रूट में एक `action.yml` है, लेकिन यह **एक चलानेयोग्य
एक्शन नहीं है।** यह इसलिए मौजूद है ताकि `uses: ecoma-io/action-agents@v0.12.0`
एक टैग के विरुद्ध संकलित हो, न कि लापता-मेनिफेस्ट त्रुटि के साथ विफल
हो। जब इसे कॉल किया जाता है, तो यह तुरंत एक त्रुटि के साथ विफल होता है
जो तीन वास्तविक एक्शन का नाम देता है और आपको एक चुनने को कहता है।
यह उस पैटर्न का अनुसरण करता है जो [github/codeql-action](https://github.com/github/codeql-action)
द्वारा स्थापित किया गया है, जहाँ रूट स्टब रिपॉज़िटरी को एकल एक्शन
की तरह गलती से उपयोग करने से रोकता है।

**हमेशा अपनी `uses:` पंक्ति में एक विशिष्ट एक्शन निर्देशिका** (`triage`,
`review`, या `harmonise`) का संदर्भ दें।

## Documentation

|                                       |                                                                   |
| ------------------------------------- | ----------------------------------------------------------------- |
| [**Security**](SECURITY.md)           | The threat model, the ceilings, and how to report a vulnerability |
| [**Contributing**](CONTRIBUTING.md)   | Everything a pull request is judged on                            |
| [For agents](AGENTS.md)               | The same ground, for an AI agent working on this repository       |
| [Code of Conduct](CODE_OF_CONDUCT.md) | What taking part here requires                                    |

पूर्ण सूची: [**docs/**](docs/README.md) — जैसे-जैसे लिखा गया, और ईमानदार
इस बात के बारे में कि कौन से पेज अभी मौजूद नहीं हैं।

## Contributing

सबसे मूल्यवान योगदान **एक एक्शन है जो अनुमति के बाहर कार्य करता है** —
एक टिप्पणी जो किसी रखरखावकर्ता ने नहीं लिखने का इरादा किया था, एक पढ़ना
जो वर्कस्पेस से बाहर निकला, एक चाबी जो लॉग तक पहुँच गई। यह एक सुरक्षा
रिपोर्ट है, कोई इश्यू नहीं: [SECURITY.md](SECURITY.md)। बाकी सब —
[CONTRIBUTING.md](CONTRIBUTING.md) · [Code of Conduct](CODE_OF_CONDUCT.md)।

## License

[Apache License 2.0](LICENSE) — © Mai Ngọc Hóa (John Martin) और Action
Agents योगदानकर्ता। Apache-2.0 स्पष्ट पेटेंट अनुदान के लिए।

---

<p align="center">
  <sub>
    <a href="https://ecoma.io">Ecoma</a> द्वारा अनुरक्षित ·
    <a href="https://ecoma.io">Website</a> ·
    <a href="https://github.com/ecoma-io">Github</a>
  </sub>
</p>
