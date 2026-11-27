import test from "node:test";
import assert from "node:assert/strict";
import { planFromQuestion } from "../lib/plan.mjs";

test("从中文问句里抽出真正的关键词", () => {
  assert.deepEqual(planFromQuestion("上周谁提到过交付日期"), {
    op: "search",
    value: "交付日期",
    days: 14,
    limit: 30,
  });
});

test("保留英文与数字", () => {
  const p = planFromQuestion("查一下 Celine 最近的聊天");
  assert.equal(p.op, "search");
  assert.equal(p.value, "Celine");
  assert.equal(p.days, 7);
});

test("时间词换算成天数", () => {
  assert.equal(planFromQuestion("今天的红包").days, 1);
  assert.equal(planFromQuestion("昨天的红包").days, 2);
  assert.equal(planFromQuestion("上个月讨论的方案").days, 45);
});

test("没有关键词时退化为 recent，而不是拿整句话去搜", () => {
  const p = planFromQuestion("最近有什么消息");
  assert.equal(p.op, "recent");
  assert.equal(p.value, "");
});

test("长度上限与默认值", () => {
  const p = planFromQuestion("关于" + "超长关键词".repeat(50));
  assert.ok(p.value.length <= 180);
  assert.equal(planFromQuestion("").op, "recent");
});
