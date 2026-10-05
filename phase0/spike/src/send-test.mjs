// Step 3: send ONE test message (optionally with an image) into an existing thread,
// using the real UI in a bridge tab, at human pace.
//
//   docker compose run --rm -e CONFIRM=yes spike node src/send-test.mjs \
//     "https://www.linkedin.com/messaging/thread/<THREAD_ID>/" "Test from bridge 👋" [/app/files/test.png]
//
// Use a thread with yourself or a colleague who expects it.
// Selectors are role/label based. If LinkedIn changed its UI, adjust them here;
// finding stable ones is part of what Phase 0 validates.
import { attach, isLoggedOut, jitter } from './lib.mjs';

const [threadUrl, text, filePath] = process.argv.slice(2);
if (!threadUrl || !text) {
  console.error('Usage: send-test.mjs <threadUrl> <text> [filePath]');
  process.exit(1);
}
if (process.env.CONFIRM !== 'yes') {
  console.error('Refusing to send without CONFIRM=yes');
  process.exit(1);
}

const { browser, context } = await attach();
const page = await context.newPage();
await page.goto(threadUrl, { waitUntil: 'domcontentloaded' });
if (isLoggedOut(page.url())) throw new Error('Not logged in');

const composer = page.getByRole('textbox', { name: /write a message/i }).first();
await composer.waitFor({ timeout: 20_000 });
await jitter(1500, 3000);

if (filePath) {
  // The composer's hidden file input. setInputFiles works without opening the OS dialog.
  const input = page.locator('input[type="file"]').first();
  await input.setInputFiles(filePath);
  console.log('Attached file, waiting for upload preview…');
  await jitter(3000, 5000);
}

await composer.click();
await composer.pressSequentially(text, { delay: 40 + Math.random() * 60 });
await jitter(800, 1800);

await page.getByRole('button', { name: /^send$/i }).first().click();
console.log('Clicked Send. Verifying…');

await page.getByText(text, { exact: false }).last().waitFor({ timeout: 15_000 });
console.log('✅ Message visible in thread.');

await jitter(2000, 3000);
await page.close();
await browser.close();
