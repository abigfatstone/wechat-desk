const PHRASES = [
  "提到过", "讨论过", "说过", "聊过", "有没有", "是不是", "能不能", "可不可以",
  "上周", "这周", "本周", "下周", "上个月", "这个月", "最近", "今天", "昨天", "前天",
  "查一下", "查查", "看看", "给我", "帮我", "麻烦", "关于", "相关", "内容",
  "消息", "聊天", "记录", "事情", "东西", "时候", "时间", "什么", "哪个", "哪些",
  "哪里", "谁", "是否", "提到", "讨论", "整理", "请", "把", "让",
];

const EDGE = new Set(["的", "了", "吗", "呢", "吧", "啊", "和", "跟", "与", "在", "是", "有", "没", "我", "你", "他", "她", "它", "们", "请", "把", "被", "对", "从", "到", "就", "都", "也", "还", "又", "给"]);

const DAYS = [
  [/今天|今日/, 1],
  [/昨天|昨日/, 2],
  [/前天/, 3],
  [/上周|上星期/, 14],
  [/这周|本周|这星期/, 7],
  [/上个月/, 45],
  [/这个月|本月/, 31],
];

const SPLIT = /[\s,，。、；;:：!！?？()（）[\]【】"'“”‘’]+/u;

function stripEdges(chunk) {
  const chars = [...chunk];
  while (chars.length && EDGE.has(chars[0])) chars.shift();
  while (chars.length && EDGE.has(chars[chars.length - 1])) chars.pop();
  return chars.join("");
}

// Deterministic, model-free reading of a question into one query. It runs when
// no model is available to produce a plan, so it must never invent a keyword:
// when nothing meaningful is left the caller gets a "recent" scan and is
// expected to report only what it actually saw.
export function planFromQuestion(question, { defaultDays = 7, limit = 30 } = {}) {
  const text = String(question ?? "");
  const days = DAYS.find(([re]) => re.test(text))?.[1] ?? defaultDays;

  let rest = text;
  for (const phrase of [...PHRASES].sort((a, b) => b.length - a.length)) {
    rest = rest.split(phrase).join(" ");
  }

  const tokens = rest
    .split(SPLIT)
    .map(stripEdges)
    .filter((t) => [...t].length >= 2);

  // Longest token wins: a Chinese question packs its subject into one chunk.
  const value = tokens.sort((a, b) => [...b].length - [...a].length)[0] ?? "";
  if (!value) return { op: "recent", value: "", days, limit };

  return { op: "search", value: value.slice(0, 180), days, limit };
}
