# Changelog

## [0.8.0](https://github.com/ecoma-io/action-agents/compare/v0.7.1...v0.8.0) (2026-09-04)


### Features

* **evaluation:** harmonise corpus, the evaluation page, and the U-8 decision ([#285](https://github.com/ecoma-io/action-agents/issues/285)) ([33c1321](https://github.com/ecoma-io/action-agents/commit/33c132163096af4e5e3582b5b86349ce29baedf2))
* **evaluation:** offline corpus and evaluator for triage and review ([#284](https://github.com/ecoma-io/action-agents/issues/284)) ([4565da5](https://github.com/ecoma-io/action-agents/commit/4565da5965cdc4a095e53b702d42c322dac6b1a9))
* **review:** content-checkable evidence and durable skip records ([#273](https://github.com/ecoma-io/action-agents/issues/273)) ([505ace9](https://github.com/ecoma-io/action-agents/commit/505ace9461dbb11aa479cd9b6580c7bafbd1fc7a))
* **triage:** durable run record with a dogfood delivery channel ([#277](https://github.com/ecoma-io/action-agents/issues/277)) ([35eb136](https://github.com/ecoma-io/action-agents/commit/35eb136ad2f529f642047bafed9333ed273333ce))
* **triage:** opt-in verification — one bounded call, downgrade-only ([#283](https://github.com/ecoma-io/action-agents/issues/283)) ([a1eb6d3](https://github.com/ecoma-io/action-agents/commit/a1eb6d3afa1e643b99efddba0a754b03847a646e))

## [0.7.1](https://github.com/ecoma-io/action-agents/compare/v0.7.0...v0.7.1) (2026-09-03)


### Bug Fixes

* **harmonise:** assert the owned branch name, fold model identity into the policy fingerprint ([#264](https://github.com/ecoma-io/action-agents/issues/264)) ([ee2595c](https://github.com/ecoma-io/action-agents/commit/ee2595c21d04785e46467cb0b9fb7008cec0e307))
* strip control characters from untrusted log lines; retry a fumbled model answer once ([#263](https://github.com/ecoma-io/action-agents/issues/263)) ([851cb54](https://github.com/ecoma-io/action-agents/commit/851cb54483839639bf972391ad5589e12640be36))

## [0.7.0](https://github.com/ecoma-io/action-agents/compare/v0.6.0...v0.7.0) (2026-09-03)


### Features

* **ci:** machine-check the HTTP and forge monopolies and the action shape ([#258](https://github.com/ecoma-io/action-agents/issues/258)) ([c06cb15](https://github.com/ecoma-io/action-agents/commit/c06cb15b532f3f148eaa049279e9e009ea5bb4a2))


### Bug Fixes

* align review docs with code, repair PrEvidence doc block, fix check-workflow-inputs on Windows ([#256](https://github.com/ecoma-io/action-agents/issues/256)) ([29449b1](https://github.com/ecoma-io/action-agents/commit/29449b10a2a523df39efd7da385bb0359f3c43b3))
* **triage:** account for partial mutations and pin duplicate-delivery semantics ([#255](https://github.com/ecoma-io/action-agents/issues/255)) ([837ad25](https://github.com/ecoma-io/action-agents/commit/837ad250690a47c136aac7d74d6f439ea6de8717))
* **triage:** re-read thread state live before mutation and pass head to the comment upsert ([#254](https://github.com/ecoma-io/action-agents/issues/254)) ([2b01d83](https://github.com/ecoma-io/action-agents/commit/2b01d83ddfdb4e831954c83943175e2f958b433b))

## [0.6.0](https://github.com/ecoma-io/action-agents/compare/v0.5.0...v0.6.0) (2026-09-03)


### Features

* **core:** resolve the trusted policy source from the execution context ([#195](https://github.com/ecoma-io/action-agents/issues/195)) ([e4f90f6](https://github.com/ecoma-io/action-agents/commit/e4f90f61c09e9efe2f984afb1a4e2f48e1d22546))
* **harmonise:** language-suffixed advisory files for concurrent language runs ([#202](https://github.com/ecoma-io/action-agents/issues/202)) ([1114455](https://github.com/ecoma-io/action-agents/commit/11144551b1b3532abab0aedfd8973e4347e92cc1))
* **review:** add the intensity axis ([#200](https://github.com/ecoma-io/action-agents/issues/200)) ([9243e54](https://github.com/ecoma-io/action-agents/commit/9243e54686db89c536882cfc5bc65cf4b29d197d))
* **review:** add the posture axis ([#198](https://github.com/ecoma-io/action-agents/issues/198)) ([a678457](https://github.com/ecoma-io/action-agents/commit/a678457399846fe98de2c5ceb312d360a4d0334c))
* **review:** classify the execution context and apply the applicability axis ([#197](https://github.com/ecoma-io/action-agents/issues/197)) ([973e41c](https://github.com/ecoma-io/action-agents/commit/973e41c44349bc8e83cb7904e7ab7bae48985ec5))
* security adversarial corpus (Phase 1) — full corpus + size-rung hardening ([#217](https://github.com/ecoma-io/action-agents/issues/217)) ([#219](https://github.com/ecoma-io/action-agents/issues/219)) ([1471f37](https://github.com/ecoma-io/action-agents/commit/1471f37efa0f6e25774f1b71626947067ee430f3))
* security adversarial corpus scaffold — runner, seed fixture, CI gate ([#217](https://github.com/ecoma-io/action-agents/issues/217)) ([#218](https://github.com/ecoma-io/action-agents/issues/218)) ([35eb176](https://github.com/ecoma-io/action-agents/commit/35eb176fecadd7ad813529ed6d47ce01bd2fbdae))
* **triage:** add PR evaluators — intent/scope, readiness, risk, review signal (PR-D) ([#232](https://github.com/ecoma-io/action-agents/issues/232)) ([f65229d](https://github.com/ecoma-io/action-agents/commit/f65229d6cfa6ee27e77b96e462823066e951a8ee))
* **triage:** common Evidence→Assessment→Policy→Decision pipeline ([#228](https://github.com/ecoma-io/action-agents/issues/228)) ([0670445](https://github.com/ecoma-io/action-agents/commit/0670445ff302da9f061e459ef940e33dd7019840))
* **triage:** event-aware + idempotent lifecycle (PR-E) — closes [#224](https://github.com/ecoma-io/action-agents/issues/224) ([#233](https://github.com/ecoma-io/action-agents/issues/233)) ([283bf85](https://github.com/ecoma-io/action-agents/commit/283bf85a03a24c723ce47567929179ea1876c105))
* **triage:** issue evaluators — quality, relationships, routing, priority (PR-C) ([#229](https://github.com/ecoma-io/action-agents/issues/229)) ([f01267f](https://github.com/ecoma-io/action-agents/commit/f01267fb650a24cff7a5a35cc91d526c3104b88a))
* **triage:** schema 2 — GitHub as the source of truth for label metadata ([#225](https://github.com/ecoma-io/action-agents/issues/225)) ([23aa91f](https://github.com/ecoma-io/action-agents/commit/23aa91f7c9cbbc566087303ebc5fc2c1bf47fce0))
* **workspace:** bring the tree under archkeep v0.21 governance (intent, ADRs, run contract) ([#257](https://github.com/ecoma-io/action-agents/issues/257)) ([55c8e2b](https://github.com/ecoma-io/action-agents/commit/55c8e2b84898dec3ae639253f121ef681a2b685d))


### Bug Fixes

* **core:** never replay a timed-out DELETE of a label or comment ([#194](https://github.com/ecoma-io/action-agents/issues/194)) ([2ab47bd](https://github.com/ecoma-io/action-agents/commit/2ab47bd1ceaf1d20dfefeb902e90116a3d05f4b0)), closes [#181](https://github.com/ecoma-io/action-agents/issues/181)
* **review:** batch-1 adversarial review findings ([#213](https://github.com/ecoma-io/action-agents/issues/213)) ([c00fd9c](https://github.com/ecoma-io/action-agents/commit/c00fd9c85c5693a0c19bd6e9613f7428aace4fe0))
* **review:** catch post-publication artifact write failure ([#188](https://github.com/ecoma-io/action-agents/issues/188)) ([77e0808](https://github.com/ecoma-io/action-agents/commit/77e080876923a635c00a313994e7f88f0e20ab32))
* **review:** key read ledgers by the resolved-relative path ([#190](https://github.com/ecoma-io/action-agents/issues/190)) ([a6fbc6d](https://github.com/ecoma-io/action-agents/commit/a6fbc6d8277cb6e33d496e3e6d22ecf0a782fdca))
* **triage:** declare and reconcile the needs-triage label lifecycle ([#191](https://github.com/ecoma-io/action-agents/issues/191)) ([43bfa52](https://github.com/ecoma-io/action-agents/commit/43bfa5215beb8667368a0c652e1dde049b488cbc)), closes [#180](https://github.com/ecoma-io/action-agents/issues/180)
* **triage:** keep workflow markers and triage-owned labels off the offered sheet ([#224](https://github.com/ecoma-io/action-agents/issues/224), [#230](https://github.com/ecoma-io/action-agents/issues/230)) ([#235](https://github.com/ecoma-io/action-agents/issues/235)) ([f2720e4](https://github.com/ecoma-io/action-agents/commit/f2720e4805686fc98a19e606c5a65d5b402ef7e2))
* **workspace:** harden the action-agents monorepo toward v1.0.0 ([#223](https://github.com/ecoma-io/action-agents/issues/223)) ([b395199](https://github.com/ecoma-io/action-agents/commit/b3951997c256a0c46a08b038424d93723aaa5e91))
* **workspace:** measure folded-blank and plain-scalar description length ([#187](https://github.com/ecoma-io/action-agents/issues/187)) ([ff2efdb](https://github.com/ecoma-io/action-agents/commit/ff2efdbe97359a52f220342abb73c8fe23296a10))

## [Unreleased]

### Migration notes

- **triage config schema 2.** The config is now a policy, not a label
  registry: labels are named in `labels.use` with a `roles` policy, and their
  words come from GitHub's own label metadata. A schema-1 file
  (`labels.{universal,issues,pr}` + `triageMarker`) is migrated on read with
  a warning — no action needed — and the queue marker label is spelled
  `needs triage` (with a space) everywhere.

## [0.5.0](https://github.com/ecoma-io/action-agents/compare/v0.4.1...v0.5.0) (2026-08-29)


### Features

* **core:** add request-timeout-ms input for slow providers ([#99](https://github.com/ecoma-io/action-agents/issues/99)) ([#108](https://github.com/ecoma-io/action-agents/issues/108)) ([99047a8](https://github.com/ecoma-io/action-agents/commit/99047a809b598ae1fcf7e8edd384c707717e78b7))
* **harmonise:** wire the recovery policy into the pair translation path ([#107](https://github.com/ecoma-io/action-agents/issues/107)) ([a4b33c3](https://github.com/ecoma-io/action-agents/commit/a4b33c3645baaff452fdd03ff07fbe926282f920))
* **review:** finding lifecycle - refuted and unresolved become visible states ([#115](https://github.com/ecoma-io/action-agents/issues/115)) ([dfcdfcb](https://github.com/ecoma-io/action-agents/commit/dfcdfcbd23b9ffc242c4c084f74a5a219e2afc6e)), closes [#101](https://github.com/ecoma-io/action-agents/issues/101)
* **review:** judge the provenance gate on the final published set ([#105](https://github.com/ecoma-io/action-agents/issues/105)) ([#116](https://github.com/ecoma-io/action-agents/issues/116)) ([722b8d3](https://github.com/ecoma-io/action-agents/commit/722b8d358c0164010fa9685f7ea42ea70723fd23))
* **review:** publish the run artifact and make it the canonical contract ([#103](https://github.com/ecoma-io/action-agents/issues/103)) ([#129](https://github.com/ecoma-io/action-agents/issues/129)) ([b9a2c0c](https://github.com/ecoma-io/action-agents/commit/b9a2c0c17dad775974a2cd30857689044028b735))
* **review:** the verification gate judges verification completeness ([#102](https://github.com/ecoma-io/action-agents/issues/102)) ([4b24742](https://github.com/ecoma-io/action-agents/commit/4b2474213c2cef4aa4518b7586ae70c54edd3f08))
* **review:** verifier investigates findings with bounded tools ([#111](https://github.com/ecoma-io/action-agents/issues/111)) ([80cac7a](https://github.com/ecoma-io/action-agents/commit/80cac7aa853b4fb8b325f61bdd6b8b8a44bb0f42)), closes [#100](https://github.com/ecoma-io/action-agents/issues/100)


### Bug Fixes

* **core:** declare the composed retry ceiling; cancel retryable bodies ([#168](https://github.com/ecoma-io/action-agents/issues/168)) ([1b8caaa](https://github.com/ecoma-io/action-agents/commit/1b8caaa59e4af503e9dae4287300c618ce7d9782)), closes [#151](https://github.com/ecoma-io/action-agents/issues/151)
* **core:** match ref-absent by typed 404 status, not message text ([#169](https://github.com/ecoma-io/action-agents/issues/169)) ([85b6782](https://github.com/ecoma-io/action-agents/commit/85b6782f2cad3773b1fc716bc5237b92ecef97b4)), closes [#152](https://github.com/ecoma-io/action-agents/issues/152)
* **core:** re-read the branch tip before the force-PATCH ([#166](https://github.com/ecoma-io/action-agents/issues/166)) ([88e59d7](https://github.com/ecoma-io/action-agents/commit/88e59d798d3137e84e55b42194438bebd97377fd)), closes [#149](https://github.com/ecoma-io/action-agents/issues/149)
* **harmonise:** read state and translation memory from one snapshot authority ([#106](https://github.com/ecoma-io/action-agents/issues/106)) ([8f9f72f](https://github.com/ecoma-io/action-agents/commit/8f9f72ffd717a033852d93d1a57a478c25d3ce82))
* **harmonise:** resolve the branch tip once — one SHA feeds state and TM reads ([#165](https://github.com/ecoma-io/action-agents/issues/165)) ([e1b5d89](https://github.com/ecoma-io/action-agents/commit/e1b5d89b092dafacfee9b8e63086a35413d46751)), closes [#148](https://github.com/ecoma-io/action-agents/issues/148)
* **harmonise:** route every reachable preserve-required row to merge or refusal ([#162](https://github.com/ecoma-io/action-agents/issues/162)) ([ed08f3e](https://github.com/ecoma-io/action-agents/commit/ed08f3e3261996aa93ec2087fc64b5147153eb77)), closes [#147](https://github.com/ecoma-io/action-agents/issues/147)
* **harmonise:** unbounded state-memory join and converging no-op endorsements ([#167](https://github.com/ecoma-io/action-agents/issues/167)) ([2fd6e66](https://github.com/ecoma-io/action-agents/commit/2fd6e665e9e92077925dadfb4f6bae3b7ae846bc)), closes [#150](https://github.com/ecoma-io/action-agents/issues/150)
* **review:** compaction keeps the model's own analysis; drop the dead findings-recorded edge ([#164](https://github.com/ecoma-io/action-agents/issues/164)) ([1f10028](https://github.com/ecoma-io/action-agents/commit/1f100289593a6a0b1eb44084836d92de78213b5f)), closes [#146](https://github.com/ecoma-io/action-agents/issues/146)
* **review:** coverage counts captured reads, not attempts ([#161](https://github.com/ecoma-io/action-agents/issues/161)) ([29dec48](https://github.com/ecoma-io/action-agents/commit/29dec4889c04335429429ee601a878fc51d6d714)), closes [#144](https://github.com/ecoma-io/action-agents/issues/144)
* **review:** distinguish an unrecorded verdict from an uncertain one ([#123](https://github.com/ecoma-io/action-agents/issues/123)) ([3ec2444](https://github.com/ecoma-io/action-agents/commit/3ec2444d3942e258022d546250e140b4af80c2b4))
* **review:** make deleted files inspectable in the coverage universe ([#104](https://github.com/ecoma-io/action-agents/issues/104)) ([#110](https://github.com/ecoma-io/action-agents/issues/110)) ([19ac81a](https://github.com/ecoma-io/action-agents/commit/19ac81a910dc65fb03331c90ae410b47744f97e2))
* **review:** state the evidence-ceiling contract and pin it ([#163](https://github.com/ecoma-io/action-agents/issues/163)) ([3f5c62f](https://github.com/ecoma-io/action-agents/commit/3f5c62f5308e699b905decc66eae2ef4c60ce50d)), closes [#145](https://github.com/ecoma-io/action-agents/issues/145)
* **review:** validate the artifact against fresh reads around the comment ([#160](https://github.com/ecoma-io/action-agents/issues/160)) ([fd1393d](https://github.com/ecoma-io/action-agents/commit/fd1393df997a2680fc677a682eaad14655c654aa))

## [0.4.1](https://github.com/ecoma-io/action-agents/compare/v0.4.0...v0.4.1) (2026-08-28)


### Bug Fixes

* **harmonise:** keep a noop pair's record current so later runs skip it ([#95](https://github.com/ecoma-io/action-agents/issues/95)) ([13d2987](https://github.com/ecoma-io/action-agents/commit/13d29873d0547df8a7abfd6b715796003d72b81a)), closes [#88](https://github.com/ecoma-io/action-agents/issues/88)
* **workspace:** shorten the root action.yml description to the 125-character limit ([#98](https://github.com/ecoma-io/action-agents/issues/98)) ([827446e](https://github.com/ecoma-io/action-agents/commit/827446e013318b19ca8a54cadc6a401bff081771)), closes [#97](https://github.com/ecoma-io/action-agents/issues/97)

## [0.4.0](https://github.com/ecoma-io/action-agents/compare/v0.3.0...v0.4.0) (2026-08-28)


### Features

* **harmonise:** bounded-concurrent pair translation ([#85](https://github.com/ecoma-io/action-agents/issues/85)) ([d9e1f0b](https://github.com/ecoma-io/action-agents/commit/d9e1f0b9b2ab2bbe08300fe9790b9183580cc8b8))
* **harmonise:** deterministic recovery policy (pure module) ([#83](https://github.com/ecoma-io/action-agents/issues/83)) ([5e3765b](https://github.com/ecoma-io/action-agents/commit/5e3765b56b30bdb42f8dbd0f39461be617f5d3af))
* **harmonise:** incremental report model (pure module) ([#86](https://github.com/ecoma-io/action-agents/issues/86)) ([e78d6e1](https://github.com/ecoma-io/action-agents/commit/e78d6e13b600056d22200b7c83762ec9b5a42655))
* **harmonise:** wire frontmatter protection, block planning and translation memory ([#80](https://github.com/ecoma-io/action-agents/issues/80)) ([3d47323](https://github.com/ecoma-io/action-agents/commit/3d47323d939958b479fd8c8f0d7fb4678343553b))
* **harmonise:** wire manual-edit protection and three-way merge ([#91](https://github.com/ecoma-io/action-agents/issues/91)) ([425dc1c](https://github.com/ecoma-io/action-agents/commit/425dc1c72327ba6a6e6cbaacc2f272a4f5901ad8))
* **review:** adversarial verification pass for findings ([#82](https://github.com/ecoma-io/action-agents/issues/82)) ([6420ff3](https://github.com/ecoma-io/action-agents/commit/6420ff30ecb93682df86f2e0956a797745d94e63))
* **review:** declared run gates with result-vs-gate separation ([#89](https://github.com/ecoma-io/action-agents/issues/89)) ([49cffce](https://github.com/ecoma-io/action-agents/commit/49cffced3c299dbcb8fb9df9e4e0825fba590c9b))
* **review:** evidence provenance for findings ([#84](https://github.com/ecoma-io/action-agents/issues/84)) ([39ed446](https://github.com/ecoma-io/action-agents/commit/39ed4465b90908b36b824f94c902225cf4f511a1))
* **review:** machine-readable run artifact (pure module) ([#87](https://github.com/ecoma-io/action-agents/issues/87)) ([4e20416](https://github.com/ecoma-io/action-agents/commit/4e20416a2deed5986760a8e5360e4ad8d29b51cd))
* **review:** structured review phases ([#77](https://github.com/ecoma-io/action-agents/issues/77)) ([d64adeb](https://github.com/ecoma-io/action-agents/commit/d64adebbb7d9a51770d746a1e03e0132d1360105))


### Bug Fixes

* **review:** refuse unlisted pull-request activity types in readEvent ([#79](https://github.com/ecoma-io/action-agents/issues/79)) ([bd7f3d9](https://github.com/ecoma-io/action-agents/commit/bd7f3d966d799d06701b499b29ae346d9bf576a8))

## [0.3.0](https://github.com/ecoma-io/action-agents/compare/v0.2.0...v0.3.0) (2026-08-28)


### Features

* **harmonise:** bounded-concurrency pool (pure module) ([#72](https://github.com/ecoma-io/action-agents/issues/72)) ([efcaa1b](https://github.com/ecoma-io/action-agents/commit/efcaa1be1f9f348d85db52d6c9898b7ddb641878))
* **harmonise:** changed-block planning (pure module) ([#70](https://github.com/ecoma-io/action-agents/issues/70)) ([7cc2e0e](https://github.com/ecoma-io/action-agents/commit/7cc2e0e3d3767ecfb1b11b857f0152fb28232663))
* **harmonise:** configurable deterministic asset-localization layouts ([#63](https://github.com/ecoma-io/action-agents/issues/63)) ([d0b4f4c](https://github.com/ecoma-io/action-agents/commit/d0b4f4c2f2425f89fe74b71e218f352ca4c96f97))
* **harmonise:** deterministic frontmatter protection policy (pure module) ([#68](https://github.com/ecoma-io/action-agents/issues/68)) ([9e0db6b](https://github.com/ecoma-io/action-agents/commit/9e0db6b3686ce2fbe66e3628a7ad0d78a4b89b15))
* **harmonise:** deterministic stale classification (pure module) ([#66](https://github.com/ecoma-io/action-agents/issues/66)) ([af48d5a](https://github.com/ecoma-io/action-agents/commit/af48d5a46904024fdea79097e2186b43f6b34a91))
* **harmonise:** deterministic terminology system (pure module) ([#71](https://github.com/ecoma-io/action-agents/issues/71)) ([1f5c0ed](https://github.com/ecoma-io/action-agents/commit/1f5c0ed07989358123909a9ea108443ecd1a2d1d))
* **harmonise:** manual-edit protection policy (pure module) ([#73](https://github.com/ecoma-io/action-agents/issues/73)) ([face571](https://github.com/ecoma-io/action-agents/commit/face57109f2503494e8cef8b0729ec915c261975))
* **harmonise:** runtime-canonical drift detection (pure module) ([#67](https://github.com/ecoma-io/action-agents/issues/67)) ([015ae5e](https://github.com/ecoma-io/action-agents/commit/015ae5e5a5fa6e786e16597cbcfb9cdf239a87da))
* **harmonise:** skip unchanged pairs without model calls ([#75](https://github.com/ecoma-io/action-agents/issues/75)) ([92c07bf](https://github.com/ecoma-io/action-agents/commit/92c07bf7580ac33f018fd7b8b940d97986d99175))
* **harmonise:** three-way target merge (pure module) ([#76](https://github.com/ecoma-io/action-agents/issues/76)) ([6a31228](https://github.com/ecoma-io/action-agents/commit/6a31228941bd382d9f5c5c391a040a948616b678))
* **harmonise:** translation memory store (pure module) ([#64](https://github.com/ecoma-io/action-agents/issues/64)) ([bea2998](https://github.com/ecoma-io/action-agents/commit/bea2998b72d47e004950cf8f76c7fb4424d79b73))
* **review:** deterministic coverage accounting and strict partial review ([#69](https://github.com/ecoma-io/action-agents/issues/69)) ([962238f](https://github.com/ecoma-io/action-agents/commit/962238f136686a6d2e5a7ed5dc79685c813e8eb8))
* **review:** risk-based review lanes ([#74](https://github.com/ecoma-io/action-agents/issues/74)) ([5e9de6a](https://github.com/ecoma-io/action-agents/commit/5e9de6afacca3a41de8efb8760c37015d0921b18))

## [0.2.0](https://github.com/ecoma-io/action-agents/compare/v0.1.1...v0.2.0) (2026-08-28)


### Features

* **harmonise:** structural fingerprint covers lists, tables, quotes, links, frontmatter ([#59](https://github.com/ecoma-io/action-agents/issues/59)) ([67c8e2d](https://github.com/ecoma-io/action-agents/commit/67c8e2d6a8d0608338b6f8413c95095c88756764))
* **harmonise:** sync-state model and deterministic fingerprints ([#61](https://github.com/ecoma-io/action-agents/issues/61)) ([17b23d8](https://github.com/ecoma-io/action-agents/commit/17b23d80366b0a63107952d2b75fd62f7018eb6f))
* **harmonise:** validate link identity after translation ([#57](https://github.com/ecoma-io/action-agents/issues/57)) ([cb8e9e3](https://github.com/ecoma-io/action-agents/commit/cb8e9e30d765f328d43e3b2b6280aa7f7199d46e))
* **review:** deterministic risk classifier for changed files ([#60](https://github.com/ecoma-io/action-agents/issues/60)) ([9994a75](https://github.com/ecoma-io/action-agents/commit/9994a75b2e78905facc9d24a925482d555b14b8b))
* **review:** strictness becomes review policy, add strategy config ([#62](https://github.com/ecoma-io/action-agents/issues/62)) ([92f7f4a](https://github.com/ecoma-io/action-agents/commit/92f7f4a4771bb97ef01911408f466385c3a90d33))

## [0.1.1](https://github.com/ecoma-io/action-agents/compare/v0.1.0...v0.1.1) (2026-08-28)


### Bug Fixes

* **core:** percent-encode the contents path in getContents ([#52](https://github.com/ecoma-io/action-agents/issues/52)) ([5ced493](https://github.com/ecoma-io/action-agents/commit/5ced49321522e17f0c199d6695f07eaa714a606e))
* **core:** refuse upsertBranch when the branch appears under the run ([#50](https://github.com/ecoma-io/action-agents/issues/50)) ([ebf6a28](https://github.com/ecoma-io/action-agents/commit/ebf6a2805b97044bcc532612d063023e94b282bd))
* **core:** resolve the marker upsert identity from the run's token ([#55](https://github.com/ecoma-io/action-agents/issues/55)) ([55eae1a](https://github.com/ecoma-io/action-agents/commit/55eae1a5a846b8df596a598113123408ddbd67aa)), closes [#46](https://github.com/ecoma-io/action-agents/issues/46)
* **harmonise:** blank scheme-split javascript: URIs in href/src ([#51](https://github.com/ecoma-io/action-agents/issues/51)) ([1808104](https://github.com/ecoma-io/action-agents/commit/1808104d0ed30e0adcb251a5d996e7e7bbc83524)), closes [#49](https://github.com/ecoma-io/action-agents/issues/49)
* **review:** pass GITHUB_API_URL to the forge client ([#54](https://github.com/ecoma-io/action-agents/issues/54)) ([8f4cc33](https://github.com/ecoma-io/action-agents/commit/8f4cc33b710e54022ea677ca6df5ce9e3a8aeb8b))

## 0.1.0 (2026-08-26)


### Features

* **core:** add the runtime primitives triage needs ([#4](https://github.com/ecoma-io/action-agents/issues/4)) ([9eb4406](https://github.com/ecoma-io/action-agents/commit/9eb44066822e878a2b267db959e8b1cfedf8aeb2))
* **core:** the protocol and ceiling primitives review builds on ([#35](https://github.com/ecoma-io/action-agents/issues/35)) ([5d264cb](https://github.com/ecoma-io/action-agents/commit/5d264cbba2f8b1e472326e880f02e57589a61289))
* **harmonise:** complete specification with comprehensive fixes ([591070f](https://github.com/ecoma-io/action-agents/commit/591070f5cbd51b0f644b7c5ca829d4f559c625a9))
* **harmonise:** deterministic document transformation ([#21](https://github.com/ecoma-io/action-agents/issues/21)) ([fa6ba46](https://github.com/ecoma-io/action-agents/commit/fa6ba46b9cab190d6d66cd52dcc732321b58740c))
* **harmonise:** one branch, one commit, one pull request per real run ([#23](https://github.com/ecoma-io/action-agents/issues/23)) ([e94e225](https://github.com/ecoma-io/action-agents/commit/e94e2254058f1af1351a5eeb699c2319809fbee0))
* **harmonise:** repositories rename the run's title via pullRequest.title ([#34](https://github.com/ecoma-io/action-agents/issues/34)) ([064ba64](https://github.com/ecoma-io/action-agents/commit/064ba64b6ceda3888731277b97d6aab0a741bdae))
* **harmonise:** translate prose through the model, validated by contract ([#22](https://github.com/ecoma-io/action-agents/issues/22)) ([fa77678](https://github.com/ecoma-io/action-agents/commit/fa77678644dec0c8d2e4db007afcfc4f61b57f40))
* **review:** the deterministic engine — config, inventory, fixed tools ([#36](https://github.com/ecoma-io/action-agents/issues/36)) ([19c72da](https://github.com/ecoma-io/action-agents/commit/19c72da7addb6660c35ef9fbc03ba262b1821f28))
* **review:** the model loop, the output contract, and the write ([#37](https://github.com/ecoma-io/action-agents/issues/37)) ([8212027](https://github.com/ecoma-io/action-agents/commit/82120270580dfb4cacd78907e057acd69300d4a0))
* **triage:** implement the triage action ([#6](https://github.com/ecoma-io/action-agents/issues/6)) ([fa6c3a8](https://github.com/ecoma-io/action-agents/commit/fa6c3a82d0aaadcf378285af0184bb11e96d0544))
* **workspace:** root action stub, release invariants, and hardened release workflow ([#42](https://github.com/ecoma-io/action-agents/issues/42)) ([cfde297](https://github.com/ecoma-io/action-agents/commit/cfde2973bc68ff15d252b509e9a360758b9603cc))


### Bug Fixes

* adversarial hardening — 5 security fixes across triage, review, harmonise ([#43](https://github.com/ecoma-io/action-agents/issues/43)) ([4d0df2d](https://github.com/ecoma-io/action-agents/commit/4d0df2d48c4afced7cc3b174dd6d92013fd06fd0))
* **core:** an explicit null tool_calls is absence, not a broken wire ([#40](https://github.com/ecoma-io/action-agents/issues/40)) ([0050495](https://github.com/ecoma-io/action-agents/commit/00504956064f7c295f84859bab130144f1c10ad6))
* **harmonise:** conventional title and app-token identity for CI on its own PR ([#27](https://github.com/ecoma-io/action-agents/issues/27)) ([bc66047](https://github.com/ecoma-io/action-agents/commit/bc66047f3f76eed42c9266dce60aeaf98d0964d1))
* **harmonise:** whole-word glossary over prose only, resolution by index ([#33](https://github.com/ecoma-io/action-agents/issues/33)) ([f81be20](https://github.com/ecoma-io/action-agents/commit/f81be2090eb200cfbffaa920d57929731088cf23))
* **triage:** unbreak the first dogfood run — local action, loadable manifests ([#11](https://github.com/ecoma-io/action-agents/issues/11)) ([5fe2104](https://github.com/ecoma-io/action-agents/commit/5fe21049f3230619243cfd7dbe9418b2dd9003a4))
