import 'dotenv/config';
import { access } from 'node:fs/promises';
import puppeteer from 'puppeteer';

let browser;

try {
  const executablePath =
    process.env.CHROME_PATH || puppeteer.executablePath();

  console.log('Recorder browser:', executablePath);

  await access(executablePath);

  browser = await puppeteer.launch({
    headless: true,
    executablePath,
  });

  console.log('Recorder browser launched:', await browser.version());
  console.log(
    'Chrome is ready. Next, test recording with two consenting participants.',
  );
} catch (error) {
  console.error('Recorder check failed:', error.message);
  console.error(
    'From server-web, run: npx puppeteer browsers install chrome',
  );
  console.error(
    'If CHROME_PATH is set, check that it points to an existing Chrome executable.',
  );

  process.exitCode = 1;
} finally {
  if (browser) {
    await browser.close();
  }
}