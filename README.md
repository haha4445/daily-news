# 每日新闻汇总（news-digest）

一个**零第三方依赖**的 Node.js 脚本：抓取热榜（百度/头条/微博）+ 中新网要闻国际 + 财经快讯
（东方财富/华尔街见闻）+ 科技互联网媒体（IT之家/钛媒体/雷锋网/爱范儿/少数派/Solidot）等
**17 个免登录数据源**，生成带简介、发布时间和可点击链接的中文日报文本，落到你指定的本地文件夹；
内置**时效过滤**（拒绝停更源的旧闻）与**中国大陆法定节假日/调休闸门**，既支持手动运行，
也支持挂到 DSH 定时任务或 Windows 任务计划程序上周期运行。

- 运行环境：Node.js 18+（内置 `fetch`；已在 Node v24 上验证），无需 `npm install`。
- 默认输出：`./digest/news-YYYY-MM-DD.md` 与 `./digest/news-latest.md`。

---

## 1. 快速开始

> 本文档中的 `C:\path\to\news-digest` 是占位符，替换成你实际克隆/存放本项目的目录即可。

```powershell
cd C:\path\to\news-digest

node news-digest.mjs                     # 按当天日期 + 节假日闸门生成
node news-digest.mjs --out D:\news       # 换输出目录
node news-digest.mjs --force             # 忽略节假日闸门，强制生成
node news-digest.mjs --new-only          # 只输出"本次新增"条目（一天多次运行时用）
node news-digest.mjs --update-holidays   # 维护节假日数据并打印状态
node news-digest.mjs --dry-run           # 只采集和统计，不写文件
node news-digest.mjs --list-sources      # 看数据源启用状态
node news-digest.mjs --help              # 全部参数
```

不想敲命令就双击 `run-digest.cmd`。

### 参数

| 参数 | 说明 |
|---|---|
| `--out <dir>` | 输出目录，覆盖 `config.json` 的 `outputDir`（支持相对/绝对路径） |
| `--config <file>` | 配置文件路径，默认脚本同目录的 `config.json` |
| `--date YYYY-MM-DD` | 指定"今天"，用于补跑/回放历史日期 |
| `--max <n>` | 本次总条数上限 |
| `--new-only` | 只输出与当天上一次运行相比的新增条目；文件名自动加 `-new`，且不覆盖 `news-latest.md` |
| `--update-holidays` | 强制刷新当年 + 次年的节假日数据并打印缓存状态 |
| `--year <YYYY>` | 配合 `--update-holidays` 只处理某一年 |
| `--force` | 忽略节假日闸门强制执行 |
| `--llm` | 启用模型改写摘要（需 `DEEPSEEK_API_KEY`） |
| `--no-enrich` | 关闭正文补抓 |
| `--json` | 额外输出同名 `.json` 伴随文件 |
| `--dry-run` / `--quiet` | 只统计不落盘 / 静默 |

### 退出码

| 码 | 含义 | 定时任务里怎么理解 |
|---|---|---|
| 0 | 成功，日报已落盘 | 正常 |
| 1 | 出错（所有源都失败、配置非法等） | 需要看 stderr |
| 2 | 被节假日闸门跳过（**不是失败**） | 正常，什么都不用做 |
| 3 | `--new-only` 且确实没有新增条目 | 正常 |

---

## 2. 输出长什么样

整份日报就是**一个编号列表**：标题本身即链接（点标题跳转，不暴露裸地址），每条一行搞定。

```markdown
# 每日新闻汇总 · 2026-10-10（周六）

> 生成时间：2026-10-10 17:41:52（Asia/Shanghai）
> 数据源：17 个 —— 百度热搜、今日头条热榜、微博热搜、中新网·要闻、……
> 条目数：40（上限 40）
> 日期判定：工作日（国庆节补班） · 依据：法定节假日日历
> 节假日数据：2026 已缓存 · 2027 未获取
> 本次新增：13 条（对比当天 2026-10-10 17:31:17 的上一次运行，上次共 40 条）
> 时效过滤：只保留 48 小时内的条目
> 摘要方式：源摘要 + 规则截断（零依赖）

## 摘要速览（40 条）

1. [从“半条被子”到幸福日子](https://www.baidu.com/s?wd=...) —— 如今，湖南郴州市汝城县沙洲瑶族村实现整村蝶变，走出抱团共富的乡村全面振兴之路。……（百度热搜 · 热度 790.5万）
2. 🆕 [财政部副部长廖岷会见高盛集团总裁温泽恩](https://wallstreetcn.com/livenews/...) —— 2026年10月9日下午，财政部副部长廖岷在北京会见高盛集团总裁兼首席运营官温泽恩，双方就中美经贸关系和中美宏观经济形势等议题交换意见。（华尔街见闻·全球快讯 · 10-10 16:44）
3. 🆕 [尊界客服称 V800 制动踏板支架底座 11 月陆续启动免费升级……](https://www.ithome.com/1/011/077.htm) —— 尊界汽车官方 10 月 8 日晚发布情况说明，表示尊界汽车的制动系统按照高于国家标准……（IT之家·日榜 · 10-09 17:51）
```

排版规则：

| 元素 | 说明 |
|---|---|
| `[标题](地址)` | 标题即链接，点击跳转，**不显示裸地址** |
| `—— 简介` | 一句话简介（源摘要截断到 120 字；源没给就如实标注，不编造） |
| `（来源 · 热度 · 时间）` | 来源名；榜单类附压缩热度（790.5万）；带发布时间的源附 `MM-DD HH:mm` |
| `🆕` | 当天上一次运行之后新出现的条目（增量标记） |
| 排序 | 按 `categoryOrder` 分组排序（热点 → 要闻 → 国际 → 财经 → 科技 → 社区），组内保持逐源轮转的多样性 |
| 无分类详情段 | 每条只出现一次，文件从 291 行降到 57 行 |

需要更短就把 `maxItems` 调小（例如 25），日报会同步变短。

---

## 3. 配置：`config.json`

```jsonc
{
  "outputDir": "./digest",               // 输出目录，可改成 D:\\news 之类的绝对路径
  "fileNameTemplate": "news-{date}.md",  // 支持 {date} {weekday} {time}
  "keepLatestCopy": true,                // 额外维护一份 news-latest.md
  "maxItems": 40,                        // 每天总条数（也是日报长度的总开关）
  "summaryMaxChars": 120,                // 单条简介最大字数
  "maxAgeHours": 48,                     // 只保留 48 小时内发布的条目
  "dropUndatedSources": true,            // RSS 源若整源没有发布日期则跳过（防停更源）
  "enrichFromArticle": false,            // 无摘要时补抓原文 meta description（更慢）
  "trackNewItems": true,                 // 记录当天已出现过的条目，供多次运行做增量对比
  "stateFile": "state/last-run.json",    // 增量状态文件
  "categoryOrder": ["热点","要闻","国际","财经","科技","社区","娱乐"]  // 同时决定列表排序
}
```

### 数据源

`sources` 数组里每条：`enabled` 开关、`kind` 适配器、`name`、`category` 分类、`url`、`max` 每源条数上限。
改完用 `node news-digest.mjs --list-sources` 看效果。

默认启用 17 个（**全部免登录、免 API key**，均已实测新鲜度）：

| 分类 | 数据源 | 接口类型 | 实测时效 |
|---|---|---|---|
| 热点 | 百度热搜 | 页面内嵌 JSON | 实时榜 |
| 热点 | 今日头条热榜 | 公开 JSON | 实时榜 |
| 热点 | 微博热搜 | 公开 JSON（需 Referer） | 实时榜 |
| 要闻 | 中新网·要闻 / 即时 | 官方 RSS | 0 小时 |
| 国际 | 中新网·国际 | 官方 RSS | 0 小时 |
| 国际 | 华尔街见闻·全球快讯 | 公开 JSON | 3–39 分钟 |
| 财经 | 东方财富·7×24快讯 | JSONP | 分钟级 |
| 财经 | 东方财富·要闻 | 公开 JSON | 小时级 |
| 财经 | 中新网·财经 | 官方 RSS | 0 小时 |
| 科技 | **IT之家·日榜** | 榜单 HTML + 文章页补抓 | 24 小时最热（日榜） |
| 科技 | 钛媒体 | RSS | 1–7 小时 |
| 科技 | 雷锋网 | RSS | 4–6 小时 |
| 科技 | 爱范儿 | Atom | 0–7 小时 |
| 科技 | 少数派 / Solidot | RSS | 0–48 小时 |
| 社区 | 知乎日报 | 公开 JSON | 当日 |

默认关闭但已写好的：`IT之家·最新（RSS）`、`百度热搜·游戏`、`B站全站排行`、`Hacker News`（英文源）。

#### IT之家 日榜（怎么拿到的）

IT之家**没有公开的榜单 API**：`/rank/` 是 404，移动端首页的 `<!--排行榜栏目-->` 是空注释、由前端 JS 填充，
移动端 API 里只有新闻流（`/api/news/newslistpageget`，且 `page` 参数被忽略，只能拿到最近 25 条）。
真正的榜单数据在 PC 站的这个静态块里：

```
https://www.ithome.com/block/rank.html
  <ul class="bar"><li data-id="1" class="sel">日榜</li><li data-id="2">周榜</li><li data-id="3">月榜</li></ul>
  <ul class="bd order sel" id="d-1"> …日榜 12 条… </ul>
  <ul class="bd order" id="d-2"> …周榜… </ul>
  <ul class="bd order" id="d-3"> …月榜… </ul>
```

所以适配器 `ithome-rank` 取 `#d-1`（日榜，想换周榜/月榜就把 `period` 改成 `d-2` / `d-3`）。
榜单块只给标题和链接，因此适配器会并发补抓每篇文章页，取 `meta description` 作简介、
`#pubtime_baidu` 作发布时间——这也是日榜条目能带上 `10-09 17:51` 这种时间戳的原因。
`enrich: 12` 控制补抓条数（12 次请求、并发 4，约 1–2 秒）。

**已被移除的源（会产出旧闻，务必不要再启用）**：

| 源 | 问题 |
|---|---|
| 人民网·时政 / 国际 / 财经 / IT | RSS 早已停更：前 6 条发布时间 **11817 小时前**（≈1.35 年），IT 频道甚至 **43737 小时前**（≈5 年） |
| 新华网·时政 / 国际 / 科技 | RSS **完全没有发布日期字段**，且内容陈旧（"微视频""学习卡"等无时效条目） |

**实测不可用，因此没有收录**：

| 源 | 现象 |
|---|---|
| 知乎热榜 | 页面 403、API 401（需登录态 + 签名） |
| 36氪 | 公开 API 已冻结：`/api/newsflash` 返回的全是 **2020-04-11** 的归档；网页已 SPA 化，无内嵌数据 |
| 虎嗅 RSS | 阿里云 WAF 拦截 |
| 品玩 / cnBeta / 界面 | 接口需签名或返回反爬页 |
| BBC 中文 / 德国之声 / Google News / RSSHub | 当前网络不可达（超时或 DNS 失败） |

想在 36氪 / 知乎热榜恢复可用时补上，只需在 `ADAPTERS` 里加一个函数、在 `sources` 里加一条即可。

### 时效过滤：旧闻防线（`maxAgeHours` / `dropUndatedSources`）

抓新闻最容易踩的坑就是"源看起来还在更新，其实早就停更了"。脚本用两道防线兜住：

1. **单条过滤**：条目带发布时间且超过 `maxAgeHours`（默认 48）→ 直接丢弃，并在日志里按源统计条数。
2. **整源过滤**：RSS/Atom 源如果**所有条目都没有发布日期**，无法证明时效 → **跳过整个源**并告警。
   这条专门针对"官方 RSS 停更但仍提供陈旧 XML"的情况。
3. 热榜类接口（百度/头条/微博/东财/华尔街见闻）本身就是实时榜或自带时间戳，不受第 2 条影响。

对照实验（把停更源临时加回来跑一次）：

```
✓ 人民网·时政(停更)：5 条
✓ 新华网·时政(无日期)：5 条
...
时效过滤：丢弃超过 48 小时的旧闻 —— 人民网·时政(停更) 5 条
✗ 跳过无出版日期的源（无法确认时效）：新华网·时政(无日期)
```

日报头部会写明本次口径，每条还带发布时间，可自行核对：

```
> 时效过滤：只保留 48 小时内的条目 · 丢弃旧闻 N 条 · 跳过无日期源：xxx
- 来源：东方财富·7×24快讯 · 发布：10-10 17:07 · 同题源：华尔街见闻·全球快讯
```

---

## 4. 摘要策略（三级，默认只用前两级）

1. **源摘要**：热榜/RSS 自带的 `desc` / `description`，先还原 HTML 实体再剥标签、去"查看全文"模板尾巴，按句读截断到 120 字。
2. **规则兜底**：源没给摘要时输出"榜单第 N 位；该源未提供摘要，点开链接查看原文。"，不编造内容。
3. **可选增强**：
   - `enrichFromArticle: true`：对无摘要条目抓原文页 `meta description` / 首个 `<p>`（慢，但零成本）。
   - `llm.enabled: true` + `DEEPSEEK_API_KEY`：调用 DeepSeek 兼容接口把前 N 条改写成 60 字客观简介。
     调用失败会**静默回退**到规则摘要，不会让整份日报失败。

```powershell
$env:DEEPSEEK_API_KEY = "sk-..."
node news-digest.mjs --llm
```

---

## 5. 法定节假日数据：全自动维护（不需要你每年手工配置）

需求是"**只在工作日跑：跳过周末和法定节假日，调休上班日照跑**"。这件事 **cron 表达不了**：

- 法定节假日会落在周一到周五（例如 2026-10-01 ~ 10-07 国庆放假）；
- 调休会把周六周日变成上班日（例如 **2026-10-10 是周六，但它是"国庆节后补班"，属于工作日**）。

所以节假日判断放在**脚本内部**，定时器只管每天叫醒它。

### 5.1 数据从哪来：多源回退链

按顺序尝试，第一个有内容的源胜出，结果写入本地 `holidays.json`（含来源与获取时间，可审计）：

| 顺序 | 数据源 | 说明 |
|---|---|---|
| 1 | `cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{year}.json` | GitHub 上按国务院公告整理的权威数据，走 jsDelivr CDN |
| 2 | `fastly.jsdelivr.net/...` | 同上的备用 CDN |
| 3 | `ghproxy.net/https://raw.githubusercontent.com/...` | 直连 GitHub 不通时的反代 |
| 4 | `api.github.com/repos/NateScarlet/holiday-cn/contents/{year}.json` | GitHub Contents API（base64 正文），最稳但有无鉴权频率限制 |
| 5 | `timor.tech/api/holiday/year/{year}` | 独立第三方接口兜底 |

字段语义统一为 `holiday: true` = 放假，`holiday: false` = 调休补班。
链上任何一条都可在 `config.json` 的 `holidayGate.sources` 里增删或换源。

### 5.2 新一年的安排怎么"自动出现"

1. **缺当年数据就自动拉**：任何一次运行发现本地没有当年记录，立刻走上面这条链拉取并缓存。
2. **提前预取次年**：从 `prefetchFromMonth`（默认 10 月，国务院一般在这时公布次年安排）起，
   每天运行都顺手探测一次次年数据；一旦数据源出现内容，**自动写入本地缓存**，无需人工干预。
3. **绝不缓存空结果**：数据源里通常先出现一个 `{year}.json` **占位文件但 `days` 为空**，
   脚本会识别为"安排尚未公布"，只记录探测时间，等真正公布后自动补上。
4. **探测节流**：`probeIntervalHours`（默认 24）保证同一年份一天最多联网探测一次，不会天天打接口。

实测（2026-10-10）：

```
✓ 已自动获取 2026 年节假日安排：39 条（放假 33 天 / 补班 6 天）← https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/2026.json
  · holiday-cn：2027 年数据为空（安排尚未公布）
数据源仓库年份文件：2007–2027（共 21 个），最新 2027.json 仅有占位文件（0 条），安排尚未公布
本地缓存：...\holidays.json
  ✓ 2026：39 条（放假 33 天） · 获取于 2026-10-10T07:05:18.888Z
  · 2027：未缓存（等待数据源公布，脚本每天会自动重试）
```

### 5.3 手动查看/刷新

```powershell
node news-digest.mjs --update-holidays          # 刷新当年 + 次年，并打印仓库已发布年份
node news-digest.mjs --update-holidays --year 2027
```

日报头部还会写上当前口径，一眼可见是否跟上：

```
> 节假日数据：2026 已缓存 · 2027 未获取
```

### 5.4 完全离线也能用

把 `holidayGate.autoFetch` 设为 `false`，手工维护 `holidays.json` 即可（缺年份时回退"周一至周五即工作日"）：

```json
{
  "2026": {
    "10-01": { "holiday": true,  "name": "国庆节" },
    "10-10": { "holiday": false, "name": "国庆节后补班" }
  }
}
```

`_meta` 段是脚本自动写入的来源/时间信息，手工维护时可以完全不写。

### 5.5 判定规则与可选项

```jsonc
"holidayGate": {
  "enabled": true,
  "mode": "workday",          // workday=只在工作日跑 | everyday=每天跑 | restday=只在休息日跑
  "timeZone": "Asia/Shanghai",
  "autoFetch": true,
  "prefetchNextYear": true,
  "prefetchFromMonth": 10,
  "probeIntervalHours": 24,
  "onNonWorkday": "skip"      // skip=直接退出码2 | run-marked=照跑但标注"今日非工作日"
}
```

判定：有记录 → `holiday === false` 即工作日；无记录 → 回退"周一至周五即工作日"。

---

## 6. 定时运行与任务管理（DSH）

### 6.1 当前已配置的任务

| 项 | 值 |
|---|---|
| 标题 | 每日新闻汇总（10:00 / 13:00 / 17:00） |
| 调度 | `cron: 0 10,13,17 * * *`，时区 `Asia/Shanghai`（工作日由脚本闸门再筛一次） |
| 任务 id | `schedule-42a46274-8f84-4141-839c-5c08ac08bc09` |
| 归属 | **当前这个会话**（提醒会投递到本会话） |
| 状态 | `scheduled` |

**运行是自动的**，但有一个前提：**DSH 应用必须开着**。DSH 自己的退出提示就写着"应用关闭期间，定时任务不会运行"。
关闭期间不会补跑；恢复后只会投递**最近一次**逾期提醒（不会把 12:00 和 18:00 都补上）。

### 6.2 三条必须知道的限制

1. **要开应用**：它不是系统级守护进程。
2. **每次触发都会消耗 token**（会有一次真实的模型调用）：到点后 DSH 做的是**往本会话投递一条用户消息**，
   由模型执行脚本再把内容汇报给你。这条消息会把**整个会话的上下文**一起送进模型，所以：
   - 三次触发 = 三次模型调用，而且这个会话越长、每次越贵；
   - 即使是休息日（脚本退出码 2、只回一个 `—`），也一样会消耗一次调用。

   **完全不想花 token** → 用第 7 节的 Windows 计划任务（零模型调用），然后把这里的 DSH 任务删掉。
   两者可以共存，也可以只留一个。
3. **不保证恰好一次**：宿主重启/崩溃恢复时同一次触发可能重复投递。脚本本身幂等（同日重跑覆盖同名文件），
   配合 🆕 增量标记也不会看到重复内容。

### 6.3 怎么管理这个任务

**方式一：图形界面（推荐日常查看）**
侧栏 →「**自动化任务**」页面。可以搜索/筛选、改名、改指令内容与运行时间、看运行记录、删除，
或点"打开"跳到原会话的右侧栏详情。会话页头的时钟图标能看到本会话的活动提醒。

**方式二：直接让我改**（最省事）
在会话里说一句即可，例如：

- "把每日新闻汇总改成只在 07:30 和 19:00 跑"
- "把每日新闻汇总的条数上限改成 60"
- "把每日新闻汇总的路径改成 D:\news-digest"
- "删掉每日新闻汇总的定时任务"

我内部对应调用 `schedule_list / schedule_update / schedule_delete`。

**方式三：查/改/删的对应关系**

| 操作 | 界面 | 对话 |
|---|---|---|
| 查看 | 自动化任务页面 | `schedule_list` |
| 改名/改指令/改时间 | 任务详情里编辑 | `schedule_update` |
| 删除 | 任务行的删除按钮 | `schedule_delete` |

⚠️ 这个任务绑定在**当前会话**上。**不要归档或删除这个会话**——归档时会连同它的活动定时任务一起被清理。
如果你希望任务跟着另一个会话走，在新的会话里重新创建一次即可。

### 6.4 手动运行（两种含义）

**含义一：手动跑脚本**（最常用，不消耗模型调用）

```powershell
cd C:\path\to\news-digest
node news-digest.mjs            # 尊重节假日闸门
node news-digest.mjs --force    # 强制生成，忽略闸门
```

或直接双击 `run-digest.cmd`。

**含义二：立刻触发一次 DSH 定时任务的逻辑**
定时任务本身没有"立即执行"按钮。等价做法是在会话里直接说：
"**现在跑一次每日新闻汇总**"——我会执行脚本并按同样的格式汇报。

### 6.5 启用/关闭定时任务能力

DSH 的定时任务是**可选的实验性 bundle**：侧栏 → 插件管理 →「官方」分组 → **自动化任务**
（`@deepseek-ai/dsh-experimental-schedule-bundle`）。你已经启用，所以现在根 Agent 有
`schedule_create/list/update/delete` 四个工具。关掉它，任务页面会一起消失，但**已存储的任务仍留在磁盘上**。

---

## 7. 定时运行 · 方案 B：Windows 任务计划程序（推荐，零 token）

这是**完全脱离 DSH 会话**的运行方式：Windows 自己按点拉起 node，不经过任何模型，
所以**不消耗 token**，也不需要 DSH 应用开着。

| | DSH 定时任务 | Windows 计划任务 |
|---|---|---|
| 消耗 token | ✅ 每次触发一次模型调用（含整个会话上下文） | ❌ 零消耗 |
| DSH 关掉后 | 不跑 | 照跑 |
| 产物 | 摘要**推进聊天窗口** + 本地文件 | 只有本地文件 |
| 何时该用 | 你想"到点在对话里看到摘要" | 你只要"每天有一份日报落盘" |

### 7.1 开关脚本 `windows-task.ps1`

一个脚本管全部：装、卸、启、停、看、跑、查日志。

```powershell
cd C:\path\to\news-digest
.\windows-task.ps1                                     # 看状态（默认动作）
.\windows-task.ps1 -Action Install                     # 安装/更新，默认 10:00/13:00/17:00
.\windows-task.ps1 -Action Install -At 08:00,20:00     # 换时间点
.\windows-task.ps1 -Action Install -OutDir D:\news     # 换输出目录（要绝对路径）
.\windows-task.ps1 -Action Install -ExtraArgs '--max 60'   # 固化额外参数
.\windows-task.ps1 -Action Disable                     # 临时停用（配置保留）
.\windows-task.ps1 -Action Enable                      # 恢复
.\windows-task.ps1 -Action Run                         # 现在就跑一次（等效手动运行，不花 token）
.\windows-task.ps1 -Action Log                         # 看最近一次运行日志的结尾
.\windows-task.ps1 -Action Remove                      # 彻底卸载
```

- **重复执行 `-Action Install` 就是"保存当前设置"**：同名任务被覆盖，不用先卸载。
- 时间点写 24 小时制 `HH:mm`，多个用逗号分隔。**不需要也不要在计划任务里排除周末**——
  节假日/调休由脚本自己判断，所以每天触发就是正确配置。
- 手动跑一次也有**两种**方式：双击 `run-digest.cmd`（跑完 `pause`，适合看输出），
  或 `.\windows-task.ps1 -Action Run`（会额外写日志，适合排查）。

### 7.2 当前状态

本机**已安装** `DailyNewsDigest`，每天 **10:00 / 13:00 / 17:00** 触发，下次运行时间是下一天 10:00。
用 `.\windows-task.ps1` 可随时查看。

### 7.3 实现要点（为什么这么写）

- 计划任务的动作是 `pwsh -File windows-task.ps1 -Action Run`，而不是直接跑 node：
  这样每次运行都会把输出**逐行落盘**到 `logs\digest-<日期>.log`，并把脚本的真实退出码回传给计划任务
  （`Get-ScheduledTaskInfo` 的"上次结果"会显示 `0 成功 / 1 报错 / 2 休息日跳过 / 3 无新增`）。
- 用 **node 的绝对路径**（计划任务不读你的 PATH），并设置工作目录为脚本目录。
- 勾选 **"错过触发后尽快启动"**（`-StartWhenAvailable`）：笔记本合盖、关机、休眠错过的时间点，
  开机后会补跑一次（只补一次，不会把三次都补上）。
- 默认主体是**"只在用户登录时运行"（Interactive，无需管理员）**。
  如果希望锁屏/未登录也跑，用**管理员** PowerShell 重新注册并改用 S4U：

  ```powershell
  $a = New-ScheduledTaskAction -Execute 'C:\Program Files\PowerShell\7\pwsh.exe' `
       -Argument '-NoProfile -ExecutionPolicy Bypass -File "C:\path\to\news-digest\windows-task.ps1" -Action Run' `
       -WorkingDirectory 'C:\path\to\news-digest'
  $t = New-ScheduledTaskTrigger -Daily -At 10:00
  $p = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U
  Register-ScheduledTask -TaskName DailyNewsDigest -Action $a -Trigger $t -Principal $p -Force
  ```

- ⚠️ **不要在 DSH 沙箱里运行这个脚本**：沙箱禁止访问任务计划程序服务，
  会报"拒绝访问"或"系统找不到指定的路径"。请开一个**普通 PowerShell 窗口**运行。
  （脚本会检测这种情况并给出提示，不会误报成"未安装"。）

两个方案可以共存：Windows 任务保证**一定落盘**，DSH 任务负责**把摘要推进会话**。
只想省钱就把 DSH 那条删掉（见 6.3 节）。

---

**等价的裸命令**（不想用脚本时）：

```powershell
schtasks /Create /TN "DailyNewsDigest" /SC DAILY /ST 10:00 /F `
  /TR "node C:\path\to\news-digest\news-digest.mjs"
```

缺点是只能一个时间点、没有日志、退出码也看不出来，所以只建议应急用。

---

## 8. 一天多跑几次：怎么自定义时间点

新闻源都是**实时接口**，每次运行都会重新抓当前热榜，所以多跑几次拿到的是当时的最新内容。

### 8.1 时间点在哪里改

DSH 定时任务的时间就是一个 **cron 表达式**，改它即可（Windows 计划任务则用
`.\windows-task.ps1 -Action Install -At 10:00,13:00,17:00` 重装一次）：

| 想要的效果 | cron 表达式 |
|---|---|
| 10:00 / 13:00 / 17:00（当前配置） | `0 10,13,17 * * *` |
| 每 2 小时一次（8–22 点） | `0 8-22/2 * * *` |
| 早中晚 + 睡前 | `0 7,12,18,22 * * *` |
| 每 30 分钟 | `*/30 * * * *` |
| 只在工作日 | `0 8 * * 1-5`（**不建议**，见第 5 节，会漏掉调休上班的周末） |

五段含义：`分 时 日 月 周`。**星期几一定要留给脚本判断**，不要用 `1-5`。

在会话里说一句"把每日新闻汇总改成 07:30 和 19:00 两个时间点"，我就用
`schedule_update` 把 `cron.expression` 换成 `30 7,19 * * *`；也可以在自动化任务页面里直接改。
想彻底拆成多个独立任务（例如早报和晚报内容不同），就 `schedule_create` 建两条。

### 8.2 多时段运行时，文件与内容怎么处理

默认 `fileNameTemplate: "news-{date}.md"` 是**一天一个文件**：当天第 2、3 次运行会**覆盖**同名文件，
`news-latest.md` 始终指向最新一次。这样不会堆出一地文件，代价是看不到当天历史快照。

想要每次运行都留痕，把模板加上 `{time}`（HHmm）：

```jsonc
"fileNameTemplate": "news-{date}-{time}.md"   // → news-2026-10-10-1000.md / -1300.md / -1700.md
```

### 8.3 增量：避免重复刷屏

`trackNewItems: true`（默认开）会把当天已出现过的条目标题记在 `state/last-run.json` 里，
下次运行对比后给新出现的条目打 **🆕** 标记，并在头部写"本次新增：N 条"。
定时任务的提示词里已经让模型**只汇报带 🆕 的条目**，所以第二次、第三次运行不会重复念旧闻。

需要机器可读的增量文件时用：

```powershell
node news-digest.mjs --new-only     # 只含新增条目，文件名加 -new，不动 news-latest.md
```

- 有新增 → 退出码 0，写出 `news-<日期>-new.md`；
- 没有新增 → 退出码 3，不写文件（定时任务里视为正常，回一行"本次无新增"）。

---

## 9. 换个目录放（迁移说明）

脚本本身**与位置无关**：`config.json`、`holidays.json`、`state/` 都相对**脚本所在目录**解析，
`outputDir` 相对**配置文件所在目录**解析。所以整体剪切过去、再跑一次 `node news-digest.mjs` 就能用。

但有 4 处引用了绝对路径，搬完要一起改：

| # | 位置 | 搬完怎么办 |
|---|---|---|
| 1 | DSH 定时任务的提示词里写的目录 | 让我用 `schedule_update` 改提示词，或在自动化任务页面里编辑指令 |
| 2 | Windows 计划任务（如果注册过） | 重新跑 `windows-task.ps1 -Action Install`（同名覆盖），它记录的是绝对路径 |
| 3 | `run-digest.cmd` | 用的是 `%~dp0`（脚本自身目录），**不用改** |
| 4 | `config.json` 里的 `outputDir` | 若是绝对路径（如 `D:\news`）就保持；相对路径跟着配置文件走，**不用改** |

### ⚠️ 最重要的一条：DSH 文件沙箱限制

实测在 DSH 里运行命令时，**会话工作区之外的文件写入会被文件沙箱拒绝**：

```
Access to the path 'C:\path\to\probe' is denied.
```

当前会话的工作区是 `C:\path\to\workspace`，因此：

| 想放的位置 | DSH 定时任务能否正常跑 | Windows 计划任务 |
|---|---|---|
| 当前工作区内（现状） | ✅ 可以 | ✅ 可以 |
| 另一个 DSH 工作区（并在绑定该工作区的会话里建任务） | ✅ 可以 | ✅ 可以 |
| 工作区之外的任意目录（如 `D:\tools\news-digest`） | ❌ 写入被拒（输出、缓存、状态都写不了） | ✅ 可以（计划任务不受 DSH 沙箱约束） |

所以：

- **想留在工作区内** → 把整个 `news-digest` 文件夹剪切到工作区里任意子目录，然后让我改一下定时任务的路径。
- **想放到工作区外**（例如 `D:\tools\news-digest`）→ 推荐：
  1. 用 Windows 计划任务（第 7 节）让它跑，这条路径完全不受沙箱影响；
  2. 同时把 DSH 定时任务删掉，或只保留它做"把摘要推进会话"的角色并放宽沙箱策略（会降低安全边界，不建议）。
- 只让**日报文件**落到别处（脚本还在工作区内）：把 `outputDir` 或 `--out` 指向工作区外同样会被拒；
  要么放工作区内，要么改用 Windows 计划任务。

---

## 10. 目录结构与扩展

```
news-digest/
├─ news-digest.mjs            主脚本（采集/去重/摘要/渲染/节假日闸门/增量对比）
├─ config.json                输出目录、条数、节假日源链、数据源清单
├─ holidays.json              节假日缓存（自动生成，含来源与获取时间，可手工维护）
├─ state/last-run.json        当天已出现条目（增量对比用，自动生成）
├─ windows-task.ps1           Windows 计划任务开关脚本（装/卸/启停/查看/试跑/看日志）
├─ logs/digest-<日期>.log     计划任务每次运行的完整输出（自动生成）
├─ run-digest.cmd             双击即跑（CP936 编码）
├─ LICENSE                    MIT
├─ README.md
└─ digest/                    输出目录
   ├─ news-2026-10-10.md
   ├─ news-2026-10-10-new.md  （--new-only 时）
   ├─ news-2026-10-10.json    （--json 时）
   └─ news-latest.md
```

### 加一个新数据源

1. 标准 RSS/Atom：在 `config.json` 的 `sources` 里加
   `{ "id": "...", "enabled": true, "kind": "rss", "name": "...", "category": "...", "url": "...", "max": 5 }`。
2. 非标准接口：在 `news-digest.mjs` 的 `ADAPTERS` 里加一个 `async (source, ctx) => [...]`，
   返回 `{ title, url, summary, hot, rank }` 数组，其余流程（去重、轮转、摘要、渲染、增量）全部复用。

### 加一个节假日数据源

在 `config.json` 的 `holidayGate.sources` 里加一条 `{ "kind": "...", "url": "...{year}..." }`，
并在 `HOLIDAY_PARSERS` 里补一个把原始返回转换成
`{ days: { "MM-DD": { holiday: bool, name: string } } }` 的函数即可。

---

## 11. 故障排查

- **某源失败**：日志里是 `✗ 名称：原因`，其余源照跑；只要有一个源成功就会出日报。
- **全部失败**：说明网络/DNS/代理有问题。注意本脚本用 Node 的网络栈（不依赖 PowerShell 的 schannel，
  后者在受限环境下会报 `SEC_E_NO_CREDENTIALS`）。
- **没生成文件但退出码 0**：检查是不是 `--dry-run`，或输出目录被 `--out` 改到了别处。
- **退出码 2**：今天按你的规则不该跑（默认非工作日）。`--force` 可强制。
- **退出码 3**：`--new-only` 且确实没新增，正常。
- **`Access to the path ... is denied`**：写到了会话工作区之外，见第 9 节。
- **节假日判断总是"周一至周五"**：当年数据还没发布（占位文件为空）。脚本不会缓存空结果，
  发布后首次运行会自动补上；也可以 `--update-holidays` 手动强制刷新一次。
- **计划任务跑了但没生成文件**：先 `.\windows-task.ps1 -Action Log` 看日志；再看状态里的"上次结果"——
  `2` 是休息日跳过（正常），`3` 是无新增，`1` 才是真报错。
- **`无法访问 Windows 任务计划程序服务：拒绝访问`**：你在 DSH 沙箱里跑了 `windows-task.ps1`。
  沙箱禁止访问任务计划程序，换一个**普通 PowerShell 窗口**即可（脚本本身不需要管理员）。
- **改了 `-At` 但时间没变**：`Install` 是覆盖同名任务，确认命令里确实带了新的 `-At`，
  再用 `.\windows-task.ps1` 复核。
- **计划任务里 node 路径失效**：如果 node 是用 fnm/nvm 装的，默认版本切换后绝对路径会变。
  重新跑一次 `windows-task.ps1 -Action Install` 让它记下新路径。
- **定时任务没触发（DSH）**：确认 DSH 应用正在运行（关掉就不会跑）；确认会话没被归档；确认 bundle 还启用着。
  如果你已经不想要这条，直接删掉它（6.3 节），靠第 7 节的 Windows 计划任务就够了。

---

## 12. 许可证

[MIT](LICENSE) © 2026 haha4445
