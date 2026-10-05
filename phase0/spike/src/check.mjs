// Step 1: can we attach to the shared browser, and is LinkedIn logged in?
import { attach, isLoggedOut } from './lib.mjs';

const { browser, context } = await attach();
console.log(`Attached. Open tabs: ${context.pages().length}`);
for (const p of context.pages()) console.log(' -', p.url());

const cookies = await context.cookies('https://www.linkedin.com');
const hasSession = cookies.some((c) => c.name === 'li_at');
console.log(`LinkedIn session cookie present: ${hasSession ? 'YES' : 'NO'}`);

const page = await context.newPage();
await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });
console.log(`Feed URL after load: ${page.url()}`);
console.log(isLoggedOut(page.url()) ? '❌ Not logged in. Log in via Neko first.' : '✅ Logged in.');

// Shows the exit IP as seen from the browser (should be your residential proxy).
await page.goto('https://api.ipify.org?format=json');
console.log('Browser exit IP:', await page.textContent('body'));

await page.close();
await browser.close(); // detaches only, Chrome keeps running
