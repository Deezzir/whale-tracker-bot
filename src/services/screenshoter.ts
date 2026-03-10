import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import Logger from '../common/logger';
import { Browser } from 'puppeteer';
import ProxyService from './proxies';
import { sleep } from 'bun';

const logger = new Logger('Screenshoter');
puppeteer.use(StealthPlugin());

export default class ScreenshotService {
    private browser: Browser | null = null;
    private proxy = ProxyService.getRandomProxy();

    async start(): Promise<void> {
        if (this.browser) return;

        const args = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--display=:0',
            '--disable-dev-shm-usage'
        ];
        if (this.proxy) args.push(`--proxy-server=http://${this.proxy.host}:${this.proxy.port}`);

        this.browser = await puppeteer.launch({
            headless: true,
            args
        });
        logger.info('Puppeteer initialized');
    }

    async stop(): Promise<void> {
        if (!this.browser) return;
        await this.browser.close();
        this.browser = null;
        logger.info('Puppeteer stopped');
    }

    async capture(url: string, selector?: string): Promise<Buffer | null> {
        try {
            if (!this.browser) await this.start();

            const page = await this.browser!.newPage();
            if (this.proxy)
                await page.authenticate({
                    username: this.proxy.username,
                    password: this.proxy.password
                });

            try {
                await page.setViewport({ width: 1280, height: 1400 });
                await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
                await page.evaluateOnNewDocument(() => {
                    Object.defineProperty(navigator, 'webdriver', { get: () => false });
                });

                await page.goto(url, { waitUntil: 'networkidle2' });
                await page.waitForSelector('body', { timeout: 10_000 });
                await sleep(3000);

                if (selector) {
                    const element = await page.waitForSelector(selector, { timeout: 10_000 });
                    if (!element) throw new Error(`Element not found: ${selector}`);
                    const screenshot = await element.screenshot({ type: 'png' });
                    return Buffer.from(screenshot);
                }

                const screenshot = await page.screenshot({ type: 'png' });
                return Buffer.from(screenshot);
            } finally {
                await page.close();
            }
        } catch (err) {
            logger.error(`Screenshot failed for ${url}: ${err}`);
            return null;
        }
    }
}
