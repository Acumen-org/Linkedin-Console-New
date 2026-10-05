import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import path from 'node:path';

export const OUT_DIR = '/app/out';

// Attach to the already-running Chrome inside Neko (same profile, same session).
export async function attach() {
  const browser = await chromium.connectOverCDP(process.env.CDP_URL ?? 'http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  if (!context) throw new Error('No browser context found. Is Chrome running inside Neko?');
  return { browser, context };
}

// Opens the bridge's own tab. Humans in Neko keep using their tabs.
export async function openBridgeTab(context, url = 'https://www.linkedin.com/messaging/') {
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return page;
}

export function isLoggedOut(url) {
  return /\/(login|checkpoint|authwall|uas\/login)/.test(url);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const jitter = (min, max) => sleep(min + Math.random() * (max - min));

export async function saveJson(name, data) {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, name);
  await fs.writeFile(file, JSON.stringify(data, null, 2));
  return file;
}
