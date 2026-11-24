---
description: 每日晨报 · 科技热点（AI / Hacker News / GitHub Trending / Simon Willison）
---
为账户主人生成一条科技热点播报。**每一项都必须来自本次工具调用**，禁止使用训练数据、历史缓存或自行编造内容。

## 采集

1. **AI 热点**：`web_search`，查询 `AI news today`（可加 1-2 个变体，如 `LLM release this week`）→ 选 3 条最新的。
2. **Hacker News**：`fetch_content` 抓 `https://news.ycombinator.com/` → 取前 3 条，文章 URL 必须从页面链接里取**完整路径**，不要只写域名。
3. **GitHub Trending**：`fetch_content` 抓 `https://github.com/trending`（失败则 `web_search` 查 `github trending today`）→ 2-3 个仓库，链接用真实仓库地址 `https://github.com/<owner>/<repo>`。
4. **Simon Willison**：`fetch_content` 抓 `https://simonwillison.net/` → 1-3 条最新文章，标题 + 一句摘要 + 完整 URL。

## 硬性要求

- **第一件事必须是调用工具**；没有工具结果就输出内容，视为任务失败。

- 每条都必须带可点击的真实 URL（以 `https://` 开头且含路径）；拿不到真实 URL 的条目**直接丢弃**。
- 某板块全部拿不到 → 用 `<p class="empty">今日未取到数据</p>`，不要编造。
- 一句说明控制在 40 字内，中文，陈述事实，不加评论。

## 输出（只输出 HTML 片段，不要任何解释）

<section>
  <h2>🤖 AI 热点</h2>
  <ul>
    <li><a href="URL">标题</a> — 一句说明</li>
  </ul>
</section>

<section>
  <h2>💻 Hacker News</h2>
  <ul>
    <li><a href="URL">标题</a> — 一句说明</li>
  </ul>
</section>

<section>
  <h2>🔥 GitHub Trending</h2>
  <ul>
    <li><a href="URL">owner/repo</a> — 一句说明</li>
  </ul>
</section>

<section>
  <h2>📝 Simon Willison</h2>
  <ul>
    <li><a href="URL">标题</a> — 一句摘要</li>
  </ul>
</section>

不要输出 ``` 围栏、`<html>`/`<head>`/`<body>`、Markdown 或任何说明文字。
