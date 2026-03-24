import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import Logger from '../common/logger';
import { Browser, Page } from 'puppeteer';
import ProxyService, { Proxy } from './proxies';
import { sleep } from 'bun';
import { retry } from '../common/retrier';
import { config } from '../config';

const logger = new Logger('Screenshoter');
puppeteer.use(StealthPlugin());

export default class ScreenshotService {
    private browser: Browser | null = null;
    private proxy: Proxy | null = null;

    constructor(useProxy: boolean) {
        if (useProxy) this.proxy = ProxyService.getRandomProxy();
    }

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
            headless: config.puppeteer.headless,
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
            args
        });

        logger.info(
            `Puppeteer initialized with${this.proxy ? ` proxy ${this.proxy.host}:${this.proxy.port}` : 'out proxy'}`
        );
    }

    async stop(): Promise<void> {
        if (!this.browser) return;
        await this.browser.close();
        this.browser = null;
        logger.info('Puppeteer stopped');
    }

    async capture(url: string, selector?: string, waitFn?: () => boolean): Promise<Buffer | null> {
        const MAX_RETRIES = 3;
        return retry(() => this.captureInternal(url, selector, waitFn), { attempts: MAX_RETRIES }, logger);
    }

    private async captureInternal(url: string, selector?: string, waitFn?: () => boolean): Promise<Buffer | null> {
        let page: Page | null = null;
        try {
            if (!this.browser) await this.start();

            page = await this.browser!.newPage();
            if (!page) throw new Error('Failed to create a new page');

            if (this.proxy)
                await page.authenticate({
                    username: this.proxy.username,
                    password: this.proxy.password
                });
            page.on('framenavigated', async (frame) => {
                if (
                    frame === page!.mainFrame() &&
                    (page!.url().includes('restrictedRegion') || page!.url().includes('restricted'))
                ) {
                    await page!.goBack();
                }
            });

            await page.setViewport({ width: 1280, height: 1400 });
            await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
            await page.evaluateOnNewDocument(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
            });

            await page.goto(url, { waitUntil: 'networkidle2' });
            await page.waitForSelector('body', { timeout: 10_000 });
            await sleep(3000);

            if (waitFn) {
                await page.waitForFunction(waitFn, { timeout: 15_000, polling: 1000 });
                await sleep(1000);
            }

            if (selector) {
                const element = await page.waitForSelector(selector, { timeout: 10_000 });
                if (!element) throw new Error(`Element not found: ${selector}`);
                await sleep(1000);
                const screenshot = await element.screenshot({ type: 'png' });
                return Buffer.from(screenshot);
            }

            const screenshot = await page.screenshot({ type: 'png' });
            return Buffer.from(screenshot);
        } catch (err) {
            logger.error(`Screenshot failed for ${url}: ${err}`);
            throw err;
        } finally {
            if (page) await page.close().catch(() => { });
        }
    }
}
