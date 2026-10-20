import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { chromium } from "playwright";
import {
  acquireBrowserSessionLock,
  attachBrowserSessionCleanup
} from "./lib/browser-session-lock.mjs";

export const DEFAULT_COMMENT_PAGE_URL =
  "https://creator.douyin.com/creator-micro/interactive/comment";
export const DEFAULT_USER_DATA_DIR = path.resolve(".playwright/douyin-profile");

const DEFAULT_VIEWPORT = null;

export async function promptForEnter(message) {
  const terminal = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    await terminal.question(`${message}\n`);
  } finally {
    terminal.close();
  }
}

export function parseViewport(value) {
  if (!value || value === "auto") return null;
  const match = String(value).match(/^(\d+)[xX×](\d+)$/);
  if (!match)
    throw new Error(`Invalid viewport format: "${value}" (expected WIDTHxHEIGHT, e.g. 1440x900)`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

export async function launchPersistentPage(options = {}) {
  const {
    userDataDir = DEFAULT_USER_DATA_DIR,
    headless = false,
    viewport = DEFAULT_VIEWPORT,
    alwaysNewPage = false
  } = options;

  const resolvedUserDataDir = path.resolve(userDataDir);
  const browserReservation = acquireBrowserSessionLock(resolvedUserDataDir);
  const launchOptions = { headless };
  if (viewport) {
    launchOptions.viewport = viewport;
  } else {
    launchOptions.viewport = null;
  }

  let context;
  try {
    context = await chromium.launchPersistentContext(resolvedUserDataDir, launchOptions);
    attachBrowserSessionCleanup(context, browserReservation);
    const page = alwaysNewPage
      ? await context.newPage()
      : (context.pages()[0] ?? (await context.newPage()));

    await page.bringToFront().catch(() => {});
    return { context, page };
  } catch (error) {
    await context?.close().catch(() => {});
    browserReservation.release();
    throw error;
  }
}

export async function gotoPage(page, pageUrl, navigationTimeoutMs = 60000) {
  await page.goto(pageUrl, {
    waitUntil: "domcontentloaded",
    timeout: navigationTimeoutMs
  });
  await page.bringToFront().catch(() => {});
}
