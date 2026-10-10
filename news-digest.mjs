#!/usr/bin/env node
/**
 * 每日新闻汇总生成器（零第三方依赖，只使用 Node 18+ 内置能力与全局 fetch）。
 *
 * 流程：
 *   1. 节假日闸门：按中国大陆法定节假日/调休日历判断"今天"要不要跑；
 *   2. 采集：并发抓取 config.json 里启用的热榜接口与 RSS/Atom 源；
 *   3. 归一化 + 去重合并 + 逐源轮转挑选，保证分类多样性；
 *   4. 生成简介：优先用源自带摘要，可选正文补抓，可选 LLM 改写（预留接口）；
 *   5. 输出：写入指定本地文件夹的 Markdown 文本（可选 JSON 伴随文件）。
 *
 * 关于"摘要"：默认是零依赖的抽取式摘要（正文首段/描述截断），不需要任何 API key。
 * 把 config.json 的 llm.enabled 设为 true 并设置 DEEPSEEK_API_KEY 即可切换到模型摘要。
 *
 * 退出码：0 成功；1 出错；2 被节假日闸门跳过（不是失败）。
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const WEEKDAY_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_SKIPPED = 2;
const EXIT_NOTHING_NEW = 3;

//#region 基础设施：日志、参数、抓取

function createLogger(quiet) {
  return {
    info: (...args) => {
      if (!quiet) console.log(...args);
    },
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
  };
}

const HELP = `每日新闻汇总生成器

用法：node news-digest.mjs [选项]

输出：
  --out <dir>          输出目录（覆盖 config.json 的 outputDir）
  --config <file>      配置文件路径（默认脚本同目录 config.json）
  --json               额外输出一份 JSON 伴随文件
  --dry-run            只采集与统计，不写任何文件
  --quiet              静默模式

日期与筛选：
  --date <YYYY-MM-DD>  指定"今天"（用于补跑/回放，默认取实时日期）
  --max <n>            本次总条数上限（覆盖 maxItems）
  --new-only           只输出"本次新增"条目（一天内多次运行时用），
                       文件名自动加 -new，且不覆盖 news-latest.md

节假日数据：
  --update-holidays    强制刷新当年 + 次年的节假日数据并打印状态
  --year <YYYY>        配合 --update-holidays 指定单个年份

摘要：
  --llm                启用 LLM 摘要（需 config.llm 与 DEEPSEEK_API_KEY）
  --no-enrich          关闭正文补抓（即使 config 打开）

其他：
  --force              忽略节假日闸门，强制执行一次
  --list-sources       列出全部数据源及启用状态后退出
  --help               显示本帮助

退出码：0 成功 / 1 出错 / 2 被节假日闸门跳过 / 3 --new-only 但没有新增`;

function parseArgs(argv) {
  const opts = { flags: new Set(), values: {} };
  const takesValue = new Set(["--out", "--config", "--date", "--max", "--year"]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (takesValue.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} 需要一个参数值`);
      opts.values[arg] = value;
      i += 1;
    } else if (arg.startsWith("--")) {
      opts.flags.add(arg);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return opts;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(url, { timeoutMs = 15000, retries = 1, headers = {} } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: "follow",
        headers: { "user-agent": USER_AGENT, accept: "*/*", "accept-language": "zh-CN,zh;q=0.9", ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(400 * (attempt + 1));
    }
  }
  throw lastError;
}

async function fetchJson(url, options) {
  return JSON.parse(await fetchText(url, options));
}

/** 并发受限的映射，单个任务失败不会中断整体。 */
async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: size }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        try {
          results[index] = { ok: true, value: await worker(items[index], index) };
        } catch (error) {
          results[index] = { ok: false, error };
        }
      }
    }),
  );
  return results;
}

//#endregion

//#region 文本处理：实体、HTML、RSS

function decodeEntities(text) {
  const named = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ",
    ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", hellip: "…", mdash: "—", ndash: "–",
    middot: "·", laquo: "«", raquo: "»", times: "×", copy: "©", deg: "°", yen: "¥", euro: "€",
  };
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, group) => {
    if (group.startsWith("#")) {
      const hex = group[1] === "x" || group[1] === "X";
      const code = Number.parseInt(hex ? group.slice(2) : group.slice(1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return named[group] ?? match;
  });
}

function stripCdata(text) {
  return String(text).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

function htmlToText(html) {
  // 顺序很重要：不少 RSS 把 HTML 实体转义后再塞进 description（&lt;p&gt;…），
  // 必须先解码实体、再剥标签，否则会看到一堆 &lt;p&gt; 和内联样式。
  const stripped = decodeEntities(String(html))
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6])>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(stripped).replace(/\s+/g, " ").trim();
}

/** 从 HTML 中截取一段括号平衡的 JSON 对象（用于解析页面内嵌数据）。 */
function sliceJsonObject(text, startIndex) {
  const start = text.indexOf("{", startIndex);
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

function pickTag(block, names) {
  for (const name of names) {
    const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
    if (match) return stripCdata(match[1]).trim();
  }
  return "";
}

function pickLink(block) {
  const atom = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
  if (atom) return decodeEntities(atom[1]).trim();
  const rss = block.match(/<link(?:\s[^>]*)?>([\s\S]*?)<\/link>/i);
  if (rss) return decodeEntities(stripCdata(rss[1]).trim());
  return "";
}

/** 极简 RSS 2.0 / Atom 解析：只取日报需要的字段。 */
function parseFeed(xml) {
  const blocks = [...String(xml).matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)].map((m) => m[2]);
  const items = [];
  for (const block of blocks) {
    const title = htmlToText(pickTag(block, ["title"]));
    const url = pickLink(block);
    if (!title || !url) continue;
    const summary = htmlToText(pickTag(block, ["description", "summary", "content:encoded", "content"]));
    const dateText = pickTag(block, ["pubDate", "published", "updated", "dc:date"]);
    const parsed = Date.parse(dateText);
    items.push({ title, url, summary, published: Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined });
  }
  return items;
}

//#endregion

//#region 日期与时区

/** 用 Intl 取得指定时区下的日历日期与时刻。 */
function nowInZone(timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    clock: `${get("hour")}:${get("minute")}:${get("second")}`,
    offset: new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
      .formatToParts(new Date())
      .find((p) => p.type === "timeZoneName")?.value ?? timeZone,
  };
}

/** 纯日历星期（1=周一 … 7=周日），不受运行机器时区影响。 */
function isoWeekdayOfDate(date) {
  const [year, month, day] = date.split("-").map(Number);
  return ((new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7) + 1;
}

function isDateString(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`));
}

/**
 * 解析中国时区的日期时间。
 * 东方财富等接口返回 "2026-10-10 17:17:11"（无时区信息），必须显式按 +08:00 解析，
 * 否则换台机器（不同系统时区）就会算错新鲜度。也接受 unix 秒/毫秒时间戳。
 */
function parseChinaTime(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value > 1e12 ? value : value * 1000).toISOString();
  }
  const match = String(value ?? "").match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return undefined;
  const parsed = Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] ?? "00"}+08:00`);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

//#endregion

//#region 节假日数据：多源拉取、自动缓存、自动预取新一年

/** 各数据源的原始返回 → { days: { "MM-DD": { holiday, name } } }（holiday=true 放假，false 补班）。 */
const HOLIDAY_PARSERS = {
  /** timor.tech 节假日接口。未发布的年份返回 code != 0 或空 holiday。 */
  timor(payload) {
    if (payload?.code !== 0 || !payload.holiday) return undefined;
    const days = {};
    for (const day of Object.values(payload.holiday)) {
      if (!day?.date) continue;
      days[String(day.date).slice(5)] = { holiday: day.holiday !== false, name: day.name ?? "" };
    }
    return { days };
  },
  /** holiday-cn：GitHub 上按国务院公告整理的权威数据，isOffDay=true 放假，false 补班。 */
  "holiday-cn"(payload) {
    if (!Array.isArray(payload?.days)) return undefined;
    const days = {};
    for (const day of payload.days) {
      if (!day?.date) continue;
      days[String(day.date).slice(5)] = { holiday: day.isOffDay === true, name: day.name ?? "" };
    }
    return { days }; // days 可能为空对象：仓库里已有该年占位文件，但安排尚未公布
  },
  /** 经 GitHub Contents API 取文件（base64 正文），作为 CDN 不通时的稳定后备。 */
  "github-file"(payload) {
    if (typeof payload?.content !== "string") return undefined;
    const text = Buffer.from(payload.content, "base64").toString("utf8");
    return HOLIDAY_PARSERS["holiday-cn"](JSON.parse(text));
  },
};

/** 默认数据源链：GitHub 数据源（走国内可达的 CDN/代理）优先，GitHub API 与 timor 兜底。 */
function defaultHolidaySources(gate) {
  return [
    { kind: "holiday-cn", url: "https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{year}.json" },
    { kind: "holiday-cn", url: "https://fastly.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{year}.json" },
    { kind: "holiday-cn", url: "https://ghproxy.net/https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/{year}.json" },
    { kind: "github-file", url: "https://api.github.com/repos/NateScarlet/holiday-cn/contents/{year}.json" },
    { kind: "timor", url: gate.apiTemplate ?? "https://timor.tech/api/holiday/year/{year}" },
  ];
}

function holidaySources(gate) {
  return Array.isArray(gate.sources) && gate.sources.length > 0 ? gate.sources : defaultHolidaySources(gate);
}

function holidayCachePath(gate) {
  return path.isAbsolute(gate.dataFile ?? "holidays.json")
    ? gate.dataFile
    : path.join(HERE, gate.dataFile ?? "holidays.json");
}

async function readHolidayCache(gate, log) {
  const file = holidayCachePath(gate);
  if (!existsSync(file)) return { file, data: {} };
  try {
    return { file, data: JSON.parse(await readFile(file, "utf8")) };
  } catch {
    log.warn(`节假日缓存无法解析，将重建：${file}`);
    return { file, data: {} };
  }
}

async function writeHolidayCache(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

/** 按数据源链依次尝试，返回第一个有内容的年份数据；只有占位文件时返回 { pending: true }。 */
async function fetchHolidayYearFromNetwork(year, gate, log) {
  let sawPlaceholder = false;
  for (const source of holidaySources(gate)) {
    const url = String(source.url).replace("{year}", String(year));
    try {
      const payload = await fetchJson(url, { timeoutMs: 15000, retries: 0 });
      const parser = HOLIDAY_PARSERS[source.kind];
      if (!parser) {
        log.warn(`未知的节假日数据源类型：${source.kind}`);
        continue;
      }
      const parsed = parser(payload);
      if (!parsed) {
        log.info(`  · ${source.kind} 返回结构无法识别`);
        continue;
      }
      if (Object.keys(parsed.days).length === 0) {
        sawPlaceholder = true;
        log.info(`  · ${source.kind}：${year} 年数据为空（安排尚未公布）`);
        continue;
      }
      return { days: parsed.days, source: url };
    } catch (error) {
      log.info(`  · ${source.kind} 取 ${year} 年数据失败：${error.message}`);
    }
  }
  return sawPlaceholder ? { pending: true } : undefined;
}

/**
 * 保证某年的节假日数据在本地可用：命中缓存直接用，否则联网拉取并写回缓存。
 * 未发布/拉取失败的年份只记录"探测时间"，绝不缓存空结果。
 */
async function ensureHolidayYear(year, gate, { log, force = false } = {}) {
  const { file, data } = await readHolidayCache(gate, log);
  const cached = data[year];
  if (!force && cached && Object.keys(cached).length > 0) {
    return { days: cached, source: data._meta?.[year]?.source ?? "本地缓存", fromCache: true };
  }
  if (gate.autoFetch === false) return { days: cached, source: "本地缓存（已关闭自动获取）", fromCache: true };

  const meta = (data._meta ??= {});
  const probes = (meta.probes ??= {});
  const intervalMs = (gate.probeIntervalHours ?? 24) * 3600 * 1000;
  const lastProbe = Date.parse(probes[year] ?? "");
  if (!force && Number.isFinite(lastProbe) && Date.now() - lastProbe < intervalMs) {
    return { days: cached, source: "本地缓存", fromCache: true, probedRecently: true };
  }
  probes[year] = new Date().toISOString();

  const fetched = await fetchHolidayYearFromNetwork(year, gate, log);
  if (!fetched || fetched.pending) {
    await writeHolidayCache(file, data);
    if (fetched?.pending) {
      log.warn(`⚠ ${year} 年放假安排尚未公布（数据源已有占位文件），本次跳过；后续运行会自动重试并写入缓存`);
    }
    return { days: cached, source: fetched?.pending ? "安排尚未公布" : "拉取失败", fromCache: true, pending: Boolean(fetched?.pending) };
  }
  data[year] = fetched.days;
  const days = Object.values(fetched.days);
  meta[year] = {
    source: fetched.source,
    fetchedAt: new Date().toISOString(),
    count: days.length,
    offDays: days.filter((day) => day.holiday).length,
  };
  await writeHolidayCache(file, data);
  log.info(`✓ 已自动获取 ${year} 年节假日安排：${meta[year].count} 条（放假 ${meta[year].offDays} 天 / 补班 ${meta[year].count - meta[year].offDays} 天）← ${fetched.source}`);
  return { days: fetched.days, source: fetched.source, fromCache: false, acquired: true };
}

/** 探测数据源仓库当前已提供哪些年份（用于"新一年安排是否已发布"）。 */
async function discoverPublishedYears(gate, log) {
  const url = gate.discoveryUrl ?? "https://api.github.com/repos/NateScarlet/holiday-cn/contents";
  try {
    const listing = await fetchJson(url, { timeoutMs: 15000, retries: 0, headers: { accept: "application/vnd.github+json" } });
    if (!Array.isArray(listing)) return undefined;
    return listing.map((entry) => entry.name).filter((name) => /^\d{4}\.json$/.test(name)).map((name) => Number(name.slice(0, 4))).sort((a, b) => a - b);
  } catch (error) {
    log.warn(`无法探测数据源仓库年份清单：${error.message}`);
    return undefined;
  }
}

/**
 * 判断某天在"中国大陆法定节假日 + 调休"口径下是不是工作日。
 * 数据字段 holiday=true 表示放假，holiday=false 表示调休补班（周末上班）。
 */
async function evaluateWorkday(date, gate, log) {
  const zone = gate.timeZone ?? "Asia/Shanghai";
  const weekday = isoWeekdayOfDate(date);
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const current = await ensureHolidayYear(year, gate, { log });

  // 预取下一年的安排：国务院一般在当年 10-11 月公布次年放假安排，
  // 所以从 prefetchFromMonth（默认 10 月）起每天都顺手探测一次，
  // 一旦数据源出现新年份就自动写入本地缓存，无需人工维护。
  let nextYearInfo;
  if (gate.prefetchNextYear !== false && month >= (gate.prefetchFromMonth ?? 10)) {
    nextYearInfo = await ensureHolidayYear(year + 1, gate, { log });
  }

  const entry = current.days?.[date.slice(5)];
  const years = { [year]: current };
  if (nextYearInfo) years[year + 1] = nextYearInfo;
  const base = {
    zone,
    year,
    years,
    nextYear: nextYearInfo ? year + 1 : undefined,
    acquired: [current, nextYearInfo].filter((info) => info?.acquired).length,
  };
  if (entry) {
    const restDay = entry.holiday !== false;
    return {
      ...base,
      workday: !restDay,
      source: "法定节假日日历",
      name: entry.name ?? "",
      // 补班日给出更准确的措辞：例如"国庆节补班"，而不是让人误以为在放假。
      label: restDay ? entry.name ?? "" : `${entry.name ?? "调休"}补班`,
      holiday: restDay,
    };
  }
  return {
    ...base,
    workday: weekday <= 5,
    source: current.fromCache && current.days ? "回退规则（周一至周五）" : "回退规则（周一至周五，无节假日数据）",
    name: "",
    label: weekdayLabelOf(date),
    holiday: weekday > 5,
  };
}

function weekdayLabelOf(date) {
  return WEEKDAY_LABELS[isoWeekdayOfDate(date) - 1];
}

//#endregion

//#region 数据源适配器

/** 百度热榜条目标记枚举。 */
const BAIDU_HOT_TAGS = { "1": "新", "2": "热", "3": "爆", "4": "商" };

const ADAPTERS = {
  /** 百度热搜榜：页面内嵌 `s-data:{...}` JSON。 */
  async baidu(source, ctx) {
    const html = await fetchText(source.url, ctx.fetchOptions);
    const marker = html.indexOf("s-data:");
    const raw = marker < 0 ? undefined : sliceJsonObject(html, marker);
    if (!raw) throw new Error("页面中未找到 s-data 数据块");
    const data = JSON.parse(raw);
    const cards = data?.data?.cards ?? [];
    const entries = cards.flatMap((card) => card.content ?? []);
    // 注意：百度条目里的 index 是从 0 开始的组内序号，不保证唯一，榜位一律用数组下标。
    return entries.map((entry, index) => {
      const query = entry.query || entry.word || "";
      const direct = /^https?:\/\/(?!www\.baidu\.com\/s)/.test(entry.rawUrl ?? "") ? entry.rawUrl : "";
      // hotTag 是数字枚举（1=新 2=热 3=爆 4=商），直接打印会得到"0/3"这种噪音。
      const tag = BAIDU_HOT_TAGS[String(entry.hotTag ?? "")] ?? "";
      return {
        title: htmlToText(query),
        url: direct || `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`,
        summary: htmlToText(entry.desc || ""),
        hot: Number(entry.hotScore) || undefined,
        rank: index + 1,
        tag: tag || undefined,
      };
    });
  },

  /** 今日头条热榜公开接口。 */
  async toutiao(source, ctx) {
    const payload = await fetchJson(source.url, ctx.fetchOptions);
    const list = payload?.data ?? [];
    return list.map((entry, index) => {
      const label = typeof entry.LabelDesc === "string" ? entry.LabelDesc.trim() : "";
      // 头条的 LabelDesc 常常只是"热门事件"这类占位词，没有信息量就不要当摘要。
      const summary = /^(热门事件|热榜|置顶|广告)$/.test(label) ? "" : label;
      const id = entry.ClusterIdStr ?? entry.ClusterId;
      return {
        title: htmlToText(entry.Title || ""),
        // 原始 Url 带一长串埋点参数，只保留路径部分。
        url: String(entry.Url || `https://www.toutiao.com/trending/${id}/`).split("?")[0],
        summary: htmlToText(summary),
        hot: Number(entry.HotValue) || undefined,
        rank: index + 1,
      };
    });
  },

  /** 标准 RSS / Atom。 */
  async rss(source, ctx) {
    const xml = await fetchText(source.url, ctx.fetchOptions);
    return parseFeed(xml);
  },

  /** 微博热搜：必须带 Referer，否则返回 403。 */
  async weibo(source, ctx) {
    const payload = await fetchJson(source.url, {
      ...ctx.fetchOptions,
      headers: { referer: "https://weibo.com/" },
    });
    const list = payload?.data?.realtime ?? [];
    return list.map((entry, index) => {
      const word = entry.word ?? entry.note ?? "";
      return {
        title: htmlToText(word),
        url: `https://s.weibo.com/weibo?q=${encodeURIComponent(entry.word_scheme || `#${word}#`)}&t=31&band_rank=${index + 1}&Refer=top`,
        summary: htmlToText(entry.note && entry.note !== word ? entry.note : ""),
        hot: Number(entry.num) || undefined,
        rank: index + 1,
        tag: entry.label_name || undefined,
      };
    });
  },

  /** 华尔街见闻·全球快讯（display_time 是 unix 秒）。 */
  async wallstreetcn(source, ctx) {
    const payload = await fetchJson(source.url, ctx.fetchOptions);
    return (payload?.data?.items ?? []).map((entry) => ({
      title: htmlToText(entry.title || entry.content_text || ""),
      url: entry.uri || `https://wallstreetcn.com/livenews/${entry.id}`,
      summary: htmlToText(entry.content_text || ""),
      published: parseChinaTime(Number(entry.display_time)),
    }));
  },

  /** 东方财富 7×24 快讯：返回 `var ajaxResult={...}` 形式的 JSONP。 */
  async "eastmoney-kuaixun"(source, ctx) {
    const text = await fetchText(source.url, ctx.fetchOptions);
    const payload = JSON.parse(text.replace(/^[^=]*=/, "").replace(/;\s*$/, ""));
    return (payload?.LivesList ?? []).map((entry) => ({
      title: htmlToText(entry.title || ""),
      url: entry.url_unique || entry.url_w || "",
      // digest 以【标题】开头，去掉以免和 title 重复
      summary: htmlToText(String(entry.digest ?? "").replace(/^【[^】]*】/, "")),
      published: parseChinaTime(entry.showtime),
    }));
  },

  /** 东方财富·要闻列表。 */
  async "eastmoney-news"(source, ctx) {
    const payload = await fetchJson(source.url, ctx.fetchOptions);
    return (payload?.data?.list ?? []).map((entry) => ({
      title: htmlToText(entry.title || ""),
      url: entry.uniqueUrl || entry.url || "",
      summary: htmlToText(String(entry.summary ?? "").replace(/^【[^】]*】/, "")),
      published: parseChinaTime(entry.showTime),
    }));
  },

  /** 知乎日报（无需登录的公开接口）。 */
  async "zhihu-daily"(source, ctx) {
    const payload = await fetchJson(source.url, ctx.fetchOptions);
    const stories = [...(payload?.top_stories ?? []), ...(payload?.stories ?? [])];
    return stories.map((entry, index) => ({
      title: htmlToText(entry.title || ""),
      url: entry.url || `https://daily.zhihu.com/story/${entry.id}`,
      summary: htmlToText(entry.hint || ""),
      rank: index + 1,
    }));
  },

  /** B 站全站排行榜。 */
  async bilibili(source, ctx) {
    const payload = await fetchJson(source.url, ctx.fetchOptions);
    const list = payload?.data?.list ?? [];
    return list.map((entry, index) => ({
      title: htmlToText(entry.title || ""),
      url: entry.short_link_v2 || `https://www.bilibili.com/video/${entry.bvid}`,
      summary: htmlToText(entry.desc || ""),
      hot: Number(entry.stat?.view) || undefined,
      rank: index + 1,
      tag: entry.owner?.name ? `UP：${entry.owner.name}` : undefined,
    }));
  },

  /** Hacker News 前十（默认关闭，英文源）。 */
  async hn(source, ctx) {
    const ids = await fetchJson(source.url, ctx.fetchOptions);
    const picked = (ids ?? []).slice(0, Math.max(source.max ?? 5, 5));
    const items = await mapPool(picked, 4, async (id) => {
      const item = await fetchJson(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, ctx.fetchOptions);
      return {
        title: htmlToText(item?.title ?? ""),
        url: item?.url || `https://news.ycombinator.com/item?id=${id}`,
        summary: item?.text ? htmlToText(item.text) : `HN 讨论 ${item?.descendants ?? 0} 条`,
        hot: Number(item?.score) || undefined,
      };
    });
    return items.filter((r) => r.ok).map((r) => r.value);
  },
};

async function collectSource(source, ctx, log) {
  const adapter = ADAPTERS[source.kind];
  if (!adapter) throw new Error(`未知的数据源类型：${source.kind}`);
  const raw = await adapter(source, ctx);
  const limit = source.max ?? ctx.config.perSourceMax ?? 5;
  return raw
    .filter((item) => item.title && item.url)
    .slice(0, limit)
    .map((item) => ({
      ...item,
      sourceId: source.id,
      sourceName: source.name,
      category: source.category ?? "其他",
    }));
}

//#endregion

//#region 时效过滤：把"旧闻"和"无法证明时效的源"挡在日报之外

/**
 * 两道防线：
 *  1) 单条过滤：带发布时间的条目，超过 maxAgeHours 一律丢弃；
 *  2) 整源过滤：RSS/Atom 源如果**所有条目都没有日期**，就无法证明时效性——直接跳过整个源。
 *     这条是针对"官方 RSS 早已停更但仍在提供陈旧 XML"的情形（人民网/新华网就是如此）。
 * 热榜类接口（百度/头条/微博/东财/华尔街见闻）本身就是实时榜或自带时间，不受第 2 条影响。
 */
function applyFreshness(items, config, log) {
  const maxAgeHours = config.maxAgeHours ?? 48;
  const now = Date.now();
  const bySource = new Map();
  for (const item of items) {
    if (!bySource.has(item.sourceId)) bySource.set(item.sourceId, []);
    bySource.get(item.sourceId).push(item);
  }

  const kept = [];
  const skippedSources = [];
  const staleBySource = [];
  let droppedStale = 0;
  for (const [sourceId, list] of bySource) {
    const source = config.sources.find((s) => s.id === sourceId);
    const dated = list.filter((item) => item.published);
    if (source?.kind === "rss" && (config.dropUndatedSources ?? true) && dated.length === 0) {
      skippedSources.push(source?.name ?? sourceId);
      continue;
    }
    let stale = 0;
    for (const item of list) {
      if (item.published) {
        const ageHours = (now - Date.parse(item.published)) / 3600000;
        if (Number.isFinite(ageHours) && ageHours > maxAgeHours) {
          stale += 1;
          continue;
        }
      }
      kept.push(item);
    }
    droppedStale += stale;
    if (stale > 0) staleBySource.push(`${source?.name ?? sourceId} ${stale} 条`);
  }

  if (skippedSources.length > 0) {
    log.warn(`✗ 跳过无出版日期的源（无法确认时效）：${skippedSources.join("、")}`);
  }
  if (staleBySource.length > 0) {
    log.info(`时效过滤：丢弃超过 ${maxAgeHours} 小时的旧闻 —— ${staleBySource.join("、")}`);
  }
  return { items: kept, skippedSources, droppedStale, maxAgeHours };
}

//#endregion

//#region 去重、挑选、摘要

function normalizeTitle(title) {
  return String(title)
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, "");
}

function bigrams(text) {
  const grams = new Set();
  for (let i = 0; i < text.length - 1; i += 1) grams.add(text.slice(i, i + 2));
  return grams;
}

function similarity(a, b) {
  if (a === b) return 1;
  if (a.length >= 6 && b.length >= 6 && (a.includes(b) || b.includes(a))) return 0.95;
  const setA = bigrams(a);
  const setB = bigrams(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const gram of setA) if (setB.has(gram)) shared += 1;
  return (2 * shared) / (setA.size + setB.size);
}

/** 合并同一件事的不同来源报道，保留摘要信息量最大的那条。 */
function dedupe(items, log) {
  const groups = [];
  for (const item of items) {
    const key = normalizeTitle(item.title);
    const hit = groups.find((group) => similarity(group.key, key) >= 0.62);
    if (!hit) {
      groups.push({ key, item: { ...item, mergedFrom: [] } });
      continue;
    }
    const merged = hit.item;
    const richer = (item.summary?.length ?? 0) > (merged.summary?.length ?? 0);
    if (richer) {
      hit.item = { ...item, mergedFrom: [...merged.mergedFrom, merged.sourceName] };
      hit.key = key;
    } else {
      merged.mergedFrom = [...merged.mergedFrom, item.sourceName];
    }
    if (!merged.hot && item.hot) merged.hot = item.hot;
  }
  const kept = groups.map((group) => group.item);
  if (items.length !== kept.length) log.info(`去重：${items.length} 条 → ${kept.length} 条`);
  return kept;
}

/** 逐源轮转取件，避免某个榜单一口气占满日报。 */
function interleave(items, maxItems) {
  const buckets = new Map();
  for (const item of items) {
    if (!buckets.has(item.sourceId)) buckets.set(item.sourceId, []);
    buckets.get(item.sourceId).push(item);
  }
  for (const bucket of buckets.values()) bucket.sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));
  const order = [...buckets.keys()];
  const picked = [];
  let exhausted = false;
  while (picked.length < maxItems && !exhausted) {
    exhausted = true;
    for (const id of order) {
      const bucket = buckets.get(id);
      const next = bucket.shift();
      if (!next) continue;
      exhausted = false;
      picked.push(next);
      if (picked.length >= maxItems) break;
    }
  }
  return picked;
}

function truncate(text, maxChars) {
  const clean = String(text).replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  const head = clean.slice(0, maxChars);
  const cut = head.replace(/[^，。！？；、,.!?;\s]*$/, "").trim();
  return `${cut || head}…`;
}

/** 去掉 RSS 摘要里常见的"查看全文"之类模板尾巴。 */
function cleanSummaryText(text) {
  return String(text ?? "")
    .replace(/(查看全文|阅读全文|查看原文|点击查看|原文链接|Read more|Continue reading)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function ruleSummary(item, maxChars) {
  const raw = cleanSummaryText(item.summary);
  if (raw) return truncate(raw, maxChars);
  const bits = [];
  if (item.rank) bits.push(`榜单第 ${item.rank} 位`);
  if (item.tag) bits.push(item.tag);
  const prefix = bits.length > 0 ? `${bits.join(" · ")}；` : "";
  return `${prefix}该源未提供摘要，点开链接查看原文。`;
}

/** 可选：抓取原文页的 meta description 作为摘要（默认关闭）。 */
async function enrichFromArticle(items, ctx, log) {
  const targets = items.filter((item) => !item.summary);
  if (targets.length === 0) return;
  log.info(`正文补抓：尝试 ${targets.length} 条无摘要条目…`);
  await mapPool(targets, 3, async (item) => {
    try {
      const html = await fetchText(item.url, { ...ctx.fetchOptions, timeoutMs: 12000, retries: 0 });
      const meta =
        html.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]*content=["']([^"']+)["']/i) ||
        html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*(?:name|property)=["'](?:description|og:description)["']/i);
      const paragraph = html.match(/<p[^>]*>([\s\S]{40,400}?)<\/p>/i);
      const text = htmlToText(meta?.[1] || paragraph?.[1] || "");
      if (text) item.rawSummary = text;
    } catch {
      /* 补抓失败不影响主流程 */
    }
  });
}

/** 可选：调用 DeepSeek 兼容接口改写简介；失败时静默回退到规则摘要。 */
async function llmSummaries(items, llm, ctx, log) {
  const apiKey = process.env[llm.apiKeyEnv ?? "DEEPSEEK_API_KEY"];
  if (!apiKey) {
    log.warn(`已启用 LLM 摘要，但环境变量 ${llm.apiKeyEnv ?? "DEEPSEEK_API_KEY"} 为空，回退到规则摘要`);
    return false;
  }
  const batch = items.slice(0, llm.maxItems ?? 20);
  const payload = {
    model: llm.model ?? "deepseek-chat",
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "你是中文新闻编辑。为每条新闻写一句客观简介：不超过 60 个字，陈述事实，不加评论、不加标题党措辞、不编造原文没有的信息。只输出 JSON。",
      },
      {
        role: "user",
        content: JSON.stringify({
          要求: '返回 {"items":[{"i":序号,"summary":"简介"}]}，序号与输入一致',
          新闻: batch.map((item, index) => ({
            i: index,
            title: item.title,
            source: item.sourceName,
            raw: truncate(item.summary || item.rawSummary || "", 200),
          })),
        }),
      },
    ],
  };
  try {
    const response = await fetch(`${(llm.baseUrl ?? "https://api.deepseek.com").replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(llm.timeoutMs ?? 60000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${truncate(await response.text(), 200)}`);
    const body = await response.json();
    const content = body?.choices?.[0]?.message?.content ?? "";
    const parsed = JSON.parse(content);
    let applied = 0;
    for (const entry of parsed?.items ?? []) {
      const target = batch[entry?.i];
      if (target && typeof entry.summary === "string" && entry.summary.trim()) {
        target.llmSummary = truncate(entry.summary, 80);
        applied += 1;
      }
    }
    log.info(`LLM 摘要：成功改写 ${applied}/${batch.length} 条`);
    return applied > 0;
  } catch (error) {
    log.warn(`LLM 摘要失败（${error.message}），回退到规则摘要`);
    return false;
  }
}

//#endregion

//#region 增量跟踪：一天内多次运行时标记"本次新增"

function stateFilePath(config, configPath) {
  const file = config.stateFile ?? "state/last-run.json";
  return path.isAbsolute(file) ? file : path.join(path.dirname(configPath), file);
}

async function readState(file) {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return {};
  }
}

async function writeState(file, date, clock, items) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    `${JSON.stringify(
      { date, updatedAt: `${date} ${clock}`, count: items.length, titles: items.map((item) => normalizeTitle(item.title)) },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

/** 与当天上一次运行对比，给条目打上 isNew 标记。 */
function markNewItems(items, state, date) {
  const hadPreviousRun = state?.date === date;
  const previous = new Set(hadPreviousRun ? state.titles ?? [] : []);
  let newCount = 0;
  for (const item of items) {
    item.isNew = !previous.has(normalizeTitle(item.title));
    if (item.isNew) newCount += 1;
  }
  return { hadPreviousRun, newCount, previousAt: hadPreviousRun ? state.updatedAt : undefined, previousCount: previous.size };
}

//#endregion

//#region 输出渲染

function formatNumber(value) {
  return Number(value).toLocaleString("en-US");
}

/** 把 ISO 发布时间渲染成指定时区的「MM-DD HH:mm」，方便核对时效。 */
function formatPublished(iso, timeZone) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

/** 拼一行"节假日数据从哪来"的说明，方便判断本地缓存是否跟上新一年。 */
function holidayDataNote(holiday) {
  if (!holiday?.years) return "";
  const parts = [];
  for (const [year, info] of Object.entries(holiday.years)) {
    parts.push(info?.days ? `${year} 已缓存${info.acquired ? "（本次自动获取）" : ""}` : `${year} 未获取`);
  }
  return parts.join(" · ");
}

function renderMarkdown(context) {
  const {
    date, weekdayLabel, generatedAt, zone, holiday, sourcesUsed, items, config, banner, llmUsed, delta, incremental,
    freshness,
  } = context;
  const tracked = Boolean(config.trackNewItems);
  const newMark = (item) => (tracked && item.isNew ? "🆕 " : "");
  const lines = [];
  lines.push(`# 每日新闻汇总 · ${date}（${weekdayLabel}）${incremental ? " · 增量" : ""}`);
  lines.push("");
  lines.push(`> 生成时间：${generatedAt}（${zone}）`);
  lines.push(`> 数据源：${sourcesUsed.length} 个 —— ${sourcesUsed.map((s) => s.name).join("、")}`);
  lines.push(`> 条目数：${items.length}${config.maxItems ? `（上限 ${config.maxItems}）` : ""}`);
  if (holiday) {
    const verdict = holiday.workday ? "工作日" : "休息日";
    const suffix = holiday.label ? `（${holiday.label}）` : "";
    lines.push(`> 日期判定：${verdict}${suffix} · 依据：${holiday.source}`);
    const note = holidayDataNote(holiday);
    if (note) lines.push(`> 节假日数据：${note}`);
  }
  if (tracked && delta) {
    lines.push(
      delta.hadPreviousRun
        ? `> 本次新增：${delta.newCount} 条（对比当天 ${delta.previousAt} 的上一次运行，上次共 ${delta.previousCount} 条）`
        : `> 本次新增：${delta.newCount} 条（当天首次运行）`,
    );
  }
  if (freshness) {
    const bits = [`只保留 ${freshness.maxAgeHours} 小时内的条目`];
    if (freshness.droppedStale > 0) bits.push(`丢弃旧闻 ${freshness.droppedStale} 条`);
    if (freshness.skippedSources.length > 0) bits.push(`跳过无日期源：${freshness.skippedSources.join("、")}`);
    lines.push(`> 时效过滤：${bits.join(" · ")}`);
  }
  lines.push(`> 摘要方式：${llmUsed ? "DeepSeek 模型改写" : "源摘要 + 规则截断（零依赖）"}`);
  if (banner) lines.push(`> 注意：${banner}`);
  lines.push("");

  lines.push("## 一、摘要速览");
  lines.push("");
  const briefCount = Math.min(config.briefCount ?? 15, items.length);
  for (let i = 0; i < briefCount; i += 1) {
    const item = items[i];
    lines.push(`${i + 1}. ${newMark(item)}**${item.title}** —— ${item.summary}（${item.sourceName}）`);
  }
  lines.push("");

  lines.push("## 二、分类详情");
  const ordered = [...(config.categoryOrder ?? [])];
  for (const item of items) if (!ordered.includes(item.category)) ordered.push(item.category);
  for (const category of ordered) {
    const group = items.filter((item) => item.category === category);
    if (group.length === 0) continue;
    lines.push("");
    lines.push(`### ${category}（${group.length} 条）`);
    lines.push("");
    group.forEach((item, index) => {
      lines.push(`#### ${index + 1}. ${newMark(item)}${item.title}`);
      lines.push("");
      const meta = [`来源：${item.sourceName}`];
      if (tracked) meta.push(item.isNew ? "状态：本次新增" : "状态：沿用上次");
      if (item.published) meta.push(`发布：${formatPublished(item.published, zone)}`);
      if (item.rank) meta.push(`榜位：第 ${item.rank} 位`);
      if (item.hot) meta.push(`热度：${formatNumber(item.hot)}`);
      if (item.tag) meta.push(`标记：${item.tag}`);
      if (item.mergedFrom?.length) meta.push(`同题源：${item.mergedFrom.join("、")}`);
      lines.push(`- ${meta.join(" · ")}`);
      lines.push(`- 简介：${item.summary}`);
      lines.push(`- 链接：<${item.url}>`);
      lines.push("");
    });
  }

  lines.push("---");
  lines.push("");
  lines.push(
    incremental
      ? "_本文件是增量输出（只含本次新增条目），当天完整日报见同目录的 `news-<日期>.md`。_"
      : "_本文件由 `news-digest.mjs` 自动生成：改数据源或条数请编辑 `config.json`，重跑 `node news-digest.mjs --force`。_",
  );
  return `${lines.join("\n")}\n`;
}

async function writeAtomic(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, filePath);
}

//#endregion

//#region 主流程

const DEFAULT_CONFIG = {
  outputDir: "./digest",
  fileNameTemplate: "news-{date}.md",
  keepLatestCopy: true,
  writeJsonSidecar: false,
  maxItems: 40,
  briefCount: 15,
  perSourceMax: 5,
  summaryMaxChars: 120,
  maxAgeHours: 48,
  dropUndatedSources: true,
  enrichFromArticle: false,
  fetchConcurrency: 4,
  fetchTimeoutMs: 15000,
  fetchRetries: 1,
  categoryOrder: ["热点", "要闻", "国际", "财经", "科技", "社区", "娱乐"],
  trackNewItems: true,
  stateFile: "state/last-run.json",
  holidayGate: {
    enabled: true,
    mode: "workday",
    timeZone: "Asia/Shanghai",
    dataFile: "holidays.json",
    apiTemplate: "https://timor.tech/api/holiday/year/{year}",
    autoFetch: true,
    prefetchNextYear: true,
    prefetchFromMonth: 10,
    probeIntervalHours: 24,
    discoveryUrl: "https://api.github.com/repos/NateScarlet/holiday-cn/contents",
    sources: [],
    onNonWorkday: "skip",
  },
  llm: { enabled: false, baseUrl: "https://api.deepseek.com", model: "deepseek-chat", apiKeyEnv: "DEEPSEEK_API_KEY", maxItems: 20 },
  sources: [],
};

async function loadConfig(configPath, log) {
  if (!existsSync(configPath)) {
    log.warn(`未找到配置文件 ${configPath}，使用内置默认配置（无数据源，将抓不到任何内容）`);
    return DEFAULT_CONFIG;
  }
  const raw = JSON.parse(await readFile(configPath, "utf8"));
  return { ...DEFAULT_CONFIG, ...raw, holidayGate: { ...DEFAULT_CONFIG.holidayGate, ...(raw.holidayGate ?? {}) }, llm: { ...DEFAULT_CONFIG.llm, ...(raw.llm ?? {}) } };
}

async function main() {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);
  const log = createLogger(opts.flags.has("--quiet"));

  if (opts.flags.has("--help")) {
    console.log(HELP);
    return EXIT_OK;
  }

  const configPath = path.resolve(opts.values["--config"] ?? path.join(HERE, "config.json"));
  const config = await loadConfig(configPath, log);
  if (opts.values["--max"]) config.maxItems = Number(opts.values["--max"]);
  if (opts.flags.has("--no-enrich")) config.enrichFromArticle = false;
  if (opts.flags.has("--llm")) config.llm.enabled = true;
  if (opts.flags.has("--json")) config.writeJsonSidecar = true;

  if (opts.flags.has("--list-sources")) {
    for (const source of config.sources) {
      console.log(`${source.enabled ? "[启用]" : "[关闭]"} ${source.id.padEnd(18)} ${source.name.padEnd(14)} ${source.category}  ${source.url}`);
    }
    return EXIT_OK;
  }

  const zone = config.holidayGate.timeZone ?? "Asia/Shanghai";
  const now = nowInZone(zone);
  const date = opts.values["--date"] ?? now.date;
  if (!isDateString(date)) throw new Error(`--date 需要 YYYY-MM-DD 格式，收到：${date}`);
  const weekday = isoWeekdayOfDate(date);
  const weekdayLabel = WEEKDAY_LABELS[weekday - 1];

  // 节假日数据维护命令：不进采集流程，只刷新并报告本地缓存状态。
  if (opts.flags.has("--update-holidays")) {
    const currentYear = Number(now.date.slice(0, 4));
    const years = opts.values["--year"] ? [Number(opts.values["--year"])] : [currentYear, currentYear + 1];
    log.info("=== 节假日数据维护 ===");
    for (const year of years) {
      const info = await ensureHolidayYear(year, config.holidayGate, { log, force: true });
      if (!info?.days) log.warn(`✗ ${year} 年：本地无数据，数据源也尚未公布`);
    }
    const published = await discoverPublishedYears(config.holidayGate, log);
    if (published) {
      const newest = published.at(-1);
      const probe = await fetchHolidayYearFromNetwork(newest, config.holidayGate, { info() {}, warn() {} });
      const state = probe?.days
        ? `已发布 ${Object.keys(probe.days).length} 条`
        : probe?.pending
          ? "仅有占位文件（0 条），安排尚未公布"
          : "读取失败";
      log.info(`数据源仓库年份文件：${published[0]}–${newest}（共 ${published.length} 个），最新 ${newest}.json ${state}`);
    }
    const { data, file } = await readHolidayCache(config.holidayGate, log);
    log.info(`本地缓存：${file}`);
    for (const year of years) {
      const meta = data._meta?.[year];
      const count = data[year] ? Object.keys(data[year]).length : 0;
      log.info(
        count > 0
          ? `  ✓ ${year}：${count} 条（放假 ${meta?.offDays ?? "?"} 天）${meta ? ` · 获取于 ${meta.fetchedAt} · 来源 ${meta.source}` : ""}`
          : `  · ${year}：未缓存（等待数据源公布，脚本每天会自动重试）`,
      );
    }
    return EXIT_OK;
  }

  const outputDir = path.resolve(
    opts.values["--out"] ?? (path.isAbsolute(config.outputDir) ? config.outputDir : path.join(path.dirname(configPath), config.outputDir)),
  );
  const stateFile = stateFilePath(config, configPath);

  log.info(`=== 每日新闻汇总 ===`);
  log.info(`日期：${date}（${weekdayLabel}）｜时区：${zone}｜输出目录：${outputDir}`);

  // 1) 节假日闸门
  let holiday;
  let banner = "";
  if (config.holidayGate.enabled) {
    holiday = await evaluateWorkday(date, config.holidayGate, log);
    const verdict = holiday.workday ? "工作日" : "休息日";
    log.info(`节假日闸门：${verdict}${holiday.label ? `（${holiday.label}）` : ""} · 依据：${holiday.source}`);
    const force = opts.flags.has("--force");
    const mode = config.holidayGate.mode ?? "workday";
    const shouldRun = mode === "everyday" || (mode === "workday" ? holiday.workday : !holiday.workday);
    if (!shouldRun && !force) {
      if ((config.holidayGate.onNonWorkday ?? "skip") === "skip") {
        log.info(`按配置（mode=${mode}）今天不生成日报，直接退出。如需强制生成：--force`);
        return EXIT_SKIPPED;
      }
      banner = `今日不是工作日（${holiday.label || weekdayLabel}），按 onNonWorkday=run-marked 仍然生成`;
      log.warn(banner);
    } else if (!shouldRun && force) {
      banner = `今日不是工作日，但使用了 --force 强制生成`;
      log.warn(banner);
    }
  } else {
    log.info("节假日闸门已关闭，直接生成。");
  }

  // 2) 采集
  const enabled = config.sources.filter((source) => source.enabled);
  if (enabled.length === 0) throw new Error("config.sources 里没有任何启用的数据源");
  const fetchOptions = {
    timeoutMs: config.fetchTimeoutMs,
    retries: config.fetchRetries,
  };
  const ctx = { config, fetchOptions };
  log.info(`开始采集 ${enabled.length} 个数据源（并发 ${config.fetchConcurrency}）…`);
  const results = await mapPool(enabled, config.fetchConcurrency, (source) => collectSource(source, ctx, log));

  const items = [];
  const sourcesUsed = [];
  results.forEach((result, index) => {
    const source = enabled[index];
    if (!result.ok) {
      log.warn(`✗ ${source.name}：${result.error?.message ?? result.error}`);
      return;
    }
    sourcesUsed.push(source);
    log.info(`✓ ${source.name}：${result.value.length} 条`);
    items.push(...result.value);
  });
  if (items.length === 0) throw new Error("所有数据源都失败了，未生成日报");
  log.info(`原始条目：${items.length} 条｜可用数据源：${sourcesUsed.length}/${enabled.length}`);

  // 3) 时效过滤 → 去重 → 挑选
  const fresh = applyFreshness(items, config, log);
  if (fresh.items.length === 0) throw new Error("时效过滤后没有剩余条目，请检查数据源或放宽 maxAgeHours");
  const unique = dedupe(fresh.items, log);
  let picked = interleave(unique, config.maxItems);
  log.info(`最终入选：${picked.length} 条`);

  // 3.5) 与当天上一次运行对比，标记新增条目
  let delta;
  if (config.trackNewItems) {
    delta = markNewItems(picked, await readState(stateFile), date);
    log.info(
      delta.hadPreviousRun
        ? `增量对比：本次新增 ${delta.newCount} 条（上次运行 ${delta.previousAt}，共 ${delta.previousCount} 条）`
        : `增量对比：当天首次运行，${delta.newCount} 条全部计为新增`,
    );
  }

  // 4) 摘要
  let llmUsed = false;
  if (config.enrichFromArticle) await enrichFromArticle(picked, ctx, log);
  if (config.llm.enabled) llmUsed = await llmSummaries(picked, config.llm, ctx, log);
  for (const item of picked) {
    item.summary = item.llmSummary ?? ruleSummary({ ...item, summary: item.summary || item.rawSummary }, config.summaryMaxChars);
  }

  // 5) 输出
  const incremental = opts.flags.has("--new-only");
  if (incremental) {
    picked = picked.filter((item) => item.isNew);
    if (picked.length === 0) {
      log.info("--new-only：与上一次运行相比没有新增条目，不写文件。");
      return EXIT_NOTHING_NEW;
    }
    log.info(`--new-only：只输出 ${picked.length} 条新增条目`);
  }
  const generatedAt = `${now.date} ${now.clock}`;
  const markdown = renderMarkdown({
    date, weekdayLabel, generatedAt, zone, holiday, sourcesUsed,
    items: picked, config, banner, llmUsed, delta, incremental, freshness: fresh,
  });
  const timeCompact = now.clock.slice(0, 5).replace(":", "");
  let fileName = (config.fileNameTemplate ?? "news-{date}.md")
    .replace("{date}", date)
    .replace("{weekday}", weekdayLabel)
    .replace("{time}", timeCompact);
  if (incremental) fileName = fileName.replace(/\.md$/, "-new.md");
  const filePath = path.join(outputDir, fileName);

  if (opts.flags.has("--dry-run")) {
    log.info(`--dry-run：不写文件。预览前 3 条：`);
    for (const item of picked.slice(0, 3)) log.info(`  · ${item.title} —— ${item.summary}`);
    return EXIT_OK;
  }

  await writeAtomic(filePath, markdown);
  log.info(`已写入：${filePath}`);
  if (config.trackNewItems && !incremental) {
    await writeState(stateFile, date, now.clock, picked);
    log.info(`已更新增量状态：${stateFile}`);
  }
  if (config.keepLatestCopy && !incremental) {
    const latestPath = path.join(outputDir, "news-latest.md");
    await writeAtomic(latestPath, markdown);
    log.info(`已更新：${latestPath}`);
  }
  if (config.writeJsonSidecar) {
    const jsonPath = path.join(outputDir, fileName.replace(/\.md$/, ".json"));
    await writeAtomic(
      jsonPath,
      `${JSON.stringify({ date, weekday, zone, generatedAt, holiday, incremental, delta, sourcesUsed: sourcesUsed.map((s) => s.name), items: picked }, null, 2)}\n`,
    );
    log.info(`已写入：${jsonPath}`);
  }
  return EXIT_OK;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`生成失败：${error?.stack ?? error}`);
    process.exit(EXIT_ERROR);
  });

//#endregion
