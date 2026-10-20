import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { findTargetWorkWithRetry } from "../src/lib/works-panel.mjs";

function workCard(title, publishText) {
  return `<div class="work-card" style="width: 420px; min-height: 48px; margin: 8px">${title}<br>${publishText}</div>`;
}

test("跨境网络导致作品延迟加载时继续扫描而不是提前判定不存在", async () => {
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();
    await page.setContent(`
      <button>选择作品</button>
      <div class="douyin-creator-interactive-sidesheet-body"
           style="display:block;width:500px;height:240px;overflow-y:auto">
        <div id="works-list">
          ${workCard("较新的作品", "发布于2026年07月15日 10:00")}
        </div>
      </div>
    `);

    await page.evaluate(
      ({ html }) => {
        window.setTimeout(() => {
          document.querySelector("#works-list")?.insertAdjacentHTML("beforeend", html);
        }, 4000);
      },
      {
        html: workCard("网络延迟后出现的目标作品", "发布于2026年03月11日 19:58")
      }
    );

    const target = await findTargetWorkWithRetry(page, {
      workTitle: "网络延迟后出现的目标作品",
      workPublishText: "发布于2026年03月11日 19:58",
      selectWhenMatched: false,
      timeoutMs: 8000,
      idleMs: 200,
      uiTimeoutMs: 1000
    });

    assert.equal(target.title, "网络延迟后出现的目标作品");
    assert.equal(target.publishText, "发布于2026年03月11日 19:58");
  } finally {
    await browser.close();
  }
});

test("作品标题被平台改短后可用唯一发布时间安全匹配", async () => {
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();
    await page.setContent(`
      <button>选择作品</button>
      <div class="douyin-creator-interactive-sidesheet-body"
           style="display:block;width:500px;height:240px;overflow-y:auto">
        ${workCard("阿里虾的日记|Day126-工具分享", "发布于2026年07月07日 20:47")}
        ${workCard("另一个作品", "发布于2026年07月06日 20:47")}
      </div>
    `);

    const target = await findTargetWorkWithRetry(page, {
      workTitle: "阿里虾的日记|Day126-自己写的工具怎么分享给别人？一招搞定，不花一分钱",
      workPublishText: "发布于2026年07月07日 20:47",
      selectWhenMatched: false,
      timeoutMs: 3000,
      idleMs: 200,
      uiTimeoutMs: 1000
    });

    assert.equal(target.title, "阿里虾的日记|Day126-工具分享");
    assert.equal(target.publishText, "发布于2026年07月07日 20:47");
  } finally {
    await browser.close();
  }
});
