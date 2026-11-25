---
description: 每日晨报 · 科技热点（AI / Hacker News / GitHub Trending / Simon Willison）
---
为账户主人生成一条科技热点播报。四个板块的内容**全部来自本次工具调用**，禁止使用训练数据、历史缓存或自行编造。

## 预算

- 工具调用总数 **≤ 8 次**（1 次搜索 + 3 次抓取已够，失败才补一次搜索）。
- 到了就停止采集，用已有结果直接写输出。

## 采集

### 1. 🤖 AI 热点（`web_search`）

查询 `AI news today`，必要时补一条 `LLM release this week`。从结果里挑 **3 条**：

- 优先带发布日期且在本周内的；结果里都没有日期就按返回顺序取前 3 条，不要声称"今天"。
- 每条用结果自带的 `title` 和 `url`，不要改写 URL。

### 2. 💻 Hacker News（`fetch_content`）

抓 `https://news.ycombinator.com/`，取首页**前 3 条故事**：

- 跳过 `Jobs` 那一行（招聘广告）。
- 标题链接是外站 URL，取完整路径；不要用 `item?id=…` 的评论页链接，不要只写域名。

### 3. 🔥 GitHub Trending（`fetch_content`）

抓 `https://github.com/trending`，取 **2-3 个**仓库：

- 跳过标了 `Sponsored` 的条目。
- 链接统一写成 `https://github.com/<owner>/<repo>`。

### 4. 📝 Simon Willison（`fetch_content`）

抓 `https://simonwillison.net/`，取最新 **1-3 篇**文章：标题 + 一句摘要 + 完整 URL。

### 兜底

某个抓取失败 → 该板块改用 `web_search`（查询同名字段）补一次；还拿不到就写 `<p class="empty">今日未取到数据</p>`，不要编造。

## 硬性要求

- 每条都必须带可点击的真实 URL：以 `https://` 开头、含路径（不是只有域名）。拿不到真实 URL 的条目**直接丢弃**。
- 一句说明 **≤ 25 个汉字**（英文专有名词不计）：只写一个事实，最多一个逗号，不写"值得关注""令人兴奋"这类评价。
- 写完逐条数一遍字数，超过 25 字的删掉修饰语重写。
- 四个板块之间不重复同一条内容。
- 采集完立刻写输出，不要再调工具。

## 输出（只输出 HTML 片段；不要解释文字，不要 ``` 围栏，不要 html/head/body）

<section>
  <h2>🤖 AI 热点</h2>
  <ul>
    <li><a href="https://example.com/path">标题</a> — 一句说明</li>
  </ul>
</section>

<section>
  <h2>💻 Hacker News</h2>
  <ul>
    <li><a href="https://example.com/path">标题</a> — 一句说明</li>
  </ul>
</section>

<section>
  <h2>🔥 GitHub Trending</h2>
  <ul>
    <li><a href="https://github.com/owner/repo">owner/repo</a> — 一句说明</li>
  </ul>
</section>

<section>
  <h2>📝 Simon Willison</h2>
  <ul>
    <li><a href="https://example.com/path">标题</a> — 一句摘要</li>
  </ul>
</section>

某板块无内容时，用 `<p class="empty">今日未取到数据</p>` 代替 `<ul>`。
