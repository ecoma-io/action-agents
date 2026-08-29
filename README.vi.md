<p align="center">
  <img src=".github/assets/banner.png" alt="Action Agents — GitHub Actions đáng tin cậy, có giới hạn và có thể kiểm toán cho việc bảo trì kho lưu trữ: triage, review và harmonise, mỗi một là một hành động độc lập đối với bất kỳ mô hình OpenAI-compatible nào" width="100%" />
</p>

<h1 align="center">Action Agents</h1>

<p align="center">
  <strong>GitHub Actions đáng tin cậy, có giới hạn và có thể kiểm toán cho việc bảo trì kho lưu trữ.</strong><br />
  Ba hành động, mỗi hành động một trách nhiệm — triage, review, harmonise — chạy bên trong GitHub Actions đối với bất kỳ mô hình OpenAI-compatible nào, bao gồm cả một mô hình bạn tự host. Không có gói nào để tin cậy, không có phụ thuộc nào để kiểm toán, không cần cài đặt trước khi chúng khởi chạy.<br />
  <em>Những gì runner thực thi là mã nguồn bạn có thể đọc tại thẻ (tag) bạn đã ghim.</em>
</p>

<p align="center">
  <a href="https://github.com/ecoma-io/action-agents/actions/workflows/ci.yml"><img src="https://github.com/ecoma-io/action-agents/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/ecoma-io/action-agents/actions/workflows/analysis.yml"><img src="https://github.com/ecoma-io/action-agents/actions/workflows/analysis.yml/badge.svg" alt="Analysis" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License: Apache 2.0" /></a>
  <a href="https://github.com/ecoma-io/action-agents/releases"><img src="https://img.shields.io/github/v/release/ecoma-io/action-agents.svg" alt="Latest release" /></a>
</p>

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

Bảo trì kho lưu trữ là công việc mà không ai lên lịch: gán nhãn cho những gì vừa đến, đọc diff một cách chính xác, giữ cho tài liệu đã dịch không bị trôi dạt. Một mô hình có thể thực hiện hầu hết công việc này — nhưng việc cung cấp cho mô hình một token ghi chỉ an toàn nếu những gì nó có thể làm được giới hạn bởi thứ gì đó ngoài prompt. Ba hành động này vẽ ra ranh giới đó trong mã: **một mô hình không bao giờ tạo một lời gọi API — nó chọn từ danh sách bạn đã viết, và không có gì không thể đảo ngược, hoặc gửi email cho con người, được cho phép trong danh sách**, và mọi thứ đọc từ một luồng hay một diff là bằng chứng, không bao giờ là hướng dẫn.

- **Một hành động, một trách nhiệm** — áp dụng `review` mà không cần áp dụng bất kỳ thứ gì khác. Mỗi thư mục là một hành động hoàn chỉnh, và không có gì được chia sẻ giữa chúng ngoại trừ một lớp runtime nhỏ.
- **Không có gì được cài đặt trên runner của bạn** — một hành động JavaScript chạy trên Node 24 của runner, trực tiếp từ mã nguồn. Không có `dist/`, không có `node_modules`, không có bước `npm install`, không có mạng trước khi nó khởi chạy.
- **Bất kỳ mô hình OpenAI-compatible nào** — có khóa hoặc không, được host hoặc của bạn. Giao thức chat-completions là toàn bộ những gì qua đường biên, vì vậy một endpoint miễn phí là một con đường được hỗ trợ thay vì bị giảm chất lượng.
- **Agentic khi nó xứng đáng** — `review` quyết định đọc gì, xác minh trước khi yêu cầu, và gói gọn bản ghi của mình thay vì cắt ngắn diff của bạn.
- **Giới hạn bởi workflow của bạn, không phải bởi prompt của chúng tôi** — cấu hình mô tả hành vi; khối `permissions:` là ranh giới bảo mật.

> **Trạng thái: đã phát hành.** v0.1.0 đã ra mắt — cả `v0.1` (thẻ nổi) lẫn `v0.1.0` (thẻ chính xác) đều có thể ghim, và ví dụ dưới đây phân giải được.

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

      - uses: ecoma-io/action-agents/review@v0.1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          api-url: ${{ vars.LLM_API_URL }}
          api-key: ${{ secrets.LLM_API_KEY }}
          model: ${{ vars.LLM_MODEL }}
```

Hành vi thuộc về kho lưu trữ hơn là một workflow nằm trong `.github/action-agents/<action>/<action>.json5` — một tệp cho mỗi hành động, đồng nằm cùng các tệp đặc thù của hành động. Nó được đọc từ nhánh mặc định, vì vậy một pull request không thể chỉnh sửa chính sách điều khiển nó, và mọi hành động chạy mà không cần tệp của nó: tệp thêm chính sách, nó không bao giờ ngăn chặn thực thi — `harmonise` là ngoại lệ, từ chối thay vì chạy xanh khi không có gì, vì lý do trang phát triển của nó đề cập. Các cài đặt văn bản — một rubrik đánh giá, ngôn ngữ mà một tài liệu được harmonised chống lại — là các tệp markdown mà tệp cấu hình của hành động trỏ tới, vì văn bản thuộc về tài liệu.

## The actions

|                                          |                                                                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| [**`triage`**](triage/action.yaml)       | Phân loại các issue và pull requests, áp dụng các nhãn ngữ nghĩa được rút ra từ danh sách bạn khai báo, và đánh giá kích thước.                       |
| [**`review`**](review/action.yaml)       | Đánh giá một pull request như một agent: nó quyết định đọc gì, tìm kiếm và xác minh trước khi yêu cầu bất cứ điều gì, và bình luận các kết quả. |
| [**`harmonise`**](harmonise/action.yaml) | Giữ các phiên bản đa ngôn ngữ của tài liệu kho lưu trữ đồng bộ về mặt ngữ nghĩa với nhau.                               |

`review` được thiết kế cho các pull request được tạo ra từ bên trong kho lưu trữ. Nếu bạn muốn dùng `pull_request_target` để bao phủ các fork, hãy đọc [SECURITY.md](SECURITY.md) trước: việc checkout nhánh head của fork dưới trigger đó là một lỗ hổng trong **kho lưu trữ của bạn**, và không có hành động nào có thể khắc phục cho bạn.

## Documentation

|                                       |                                                                   |
| ------------------------------------- | ----------------------------------------------------------------- |
| [**Security**](SECURITY.md)           | Mô hình mối đe dọa, các giới hạn, và cách báo cáo lỗ hổng bảo mật |
| [**Contributing**](CONTRIBUTING.md)   | Mọi thứ mà một pull request được đánh giá |
| [For agents](AGENTS.md)               | Cùng nền tảng, cho một AI agent làm việc trên kho này       |
| [Code of Conduct](CODE_OF_CONDUCT.md) | Những yêu cầu khi tham gia ở đây                                    |

Chỉ mục đầy đủ: [**docs/**](docs/README.md) — được viết khi nó được đạt được, và trung thực về những trang chưa tồn tại.

## Contributing

Sự đóng góp có giá trị nhất là **một hành động vượt quá những gì nó được phép làm** — một bình luận được viết mà không có người bảo trì nào dự định, một lần đọc thoát ra khỏi workspace, một khóa đến được log. Đó là báo cáo bảo mật, không phải một issue: [SECURITY.md](SECURITY.md). Mọi thứ còn lại — [CONTRIBUTING.md](CONTRIBUTING.md) · [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[Apache License 2.0](LICENSE) — © Mai Ngọc Hóa (John Martin) và các cộng tác viên của Action Agents. Apache-2.0 vì giấy phép cấp bằng sáng chế rõ ràng.

---

<p align="center">
  <sub>
    Được duy trì bởi <a href="https://ecoma.io">Ecoma</a> ·
    <a href="https://ecoma.io">Website</a> ·
    <a href="https://github.com/ecoma-io">Github</a>
  </sub>
</p>