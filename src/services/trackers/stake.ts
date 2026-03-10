import { Browser, Page } from 'puppeteer';
import { config } from '../../config';
import DBService, {
    BetOutcome,
    BetType,
    RacingBetOutcome,
    SportBetOutcome,
    StakeBetDocument,
    StakeBetRecord,
    SwishBetOutcome
} from '../db/stake';
import { Tracker } from '../../common/tracker';
import { InlineKeyboardMarkup } from 'telegraf/types';
import { capitalize, formatCurrency, sleep } from '../../common/utils';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import ProxyService from '../proxies';

interface Payload {
    type: string;
    payload: any;
}

interface Currency {
    name: string;
    rates: {
        currency: string;
        rate: number;
    }[];
}

const commonPayload = `
    fragment BetsBoardSport_BetBet on BetBet {
        __typename
        ... on SwishBet {
            potentialMultiplier
            amount
            currency
            outcomes {
                lineType
                odds
                outcome {
                    line
                    name
                    market {
                        competitor {
                            name
                        }
                        game {
                            status
                            fixture {
                                tournament {
                                    category {
                                        sport {
                                            slug
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        ... on SportBet {
            potentialMultiplier
            amount
            currency
            outcomes {
                odds
                fixtureAbreviation
                outcome {
                    name
                }
                market {
                    name
                }
                fixtureName
                fixture {
                    status
                    tournament {
                        category {
                            sport {
                                slug
                            }
                        }
                    }
                }
            }
        }
        ... on RacingBet {
            betPotentialMultiplier: potentialMultiplier
            amount
            currency
            outcomes {
                type
                prices {
                    marketName
                    odds
                }
                event {
                    status
                    meeting {
                        racing {
                            slug
                        }
                        venue {
                            name
                        }
                    }
                }
                selectionSlots {
                    runners {
                        name
                        runnerNumber
                    }
                }
                result {
                    resultedPrices
                }
            }
        }
    }
`;

const highrollerSportBetsPayload = {
    id: crypto.randomUUID(),
    type: 'subscribe',
    payload: {
        query: `
            subscription BetsBoard_HighrollerSportBets {
                highrollerSportBets {
                    iid
                    bet {
                        ...BetsBoardSport_BetBet
                    }
                }
            }
            ${commonPayload}
    `
    }
};

const allSportBetsPayload = {
    id: crypto.randomUUID(),
    type: 'subscribe',
    payload: {
        query: `
            subscription BetsBoard_AllSportBets {
                allSportBets {
                    iid
                    bet {
                        ...BetsBoardSport_BetBet
                    }
                }
            }
            ${commonPayload}
    `
    }
};

puppeteer.use(StealthPlugin());

export default class StakeService extends Tracker {
    private url = config.stake.url;
    private proxy = ProxyService.getRandomProxy();

    private stakeCurrenciesKey = 'stake:currencies';
    private page: Page | null = null;
    private browser: Browser | null = null;
    private betsBatch: Partial<StakeBetDocument>[] = [];
    private betsBatchInterval?: NodeJS.Timeout;

    async start(): Promise<void> {
        if (this.monitoring) return;
        this.monitoring = true;
        this.logger.info('StakeServivce monitoring started');

        const args = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--display=:0',
            '--disable-dev-shm-usage'
        ];
        if (this.proxy) args.push(`--proxy-server=http://${this.proxy.host}:${this.proxy.port}`);

        try {
            this.browser = await puppeteer.launch({
                headless: config.puppeteer.headless,
                userDataDir: config.puppeteer.userDir ? config.puppeteer.userDir : undefined,
                args,
                defaultViewport: { width: 1366, height: 768 }
            });
            this.page = await this.browser.newPage();
            if (this.proxy)
                await this.page.authenticate({
                    username: this.proxy.username,
                    password: this.proxy.password
                });

            await this.page.goto(this.url, { waitUntil: 'networkidle2' });
            this.logger.info('Puppeteer initialized');
            await sleep(10000);
        } catch (error) {
            this.monitoring = false;
            this.page = null;
            this.logger.error(`Error initializing Puppeteer: ${error}`);
            this.tg.sendMessage(config.telegram.chatID, 'Unable to start stake monitoring.');
            return;
        }

        this.betsBatchInterval = setInterval(() => {
            this.flushBetsBatch().catch((error) => this.logger.error(`Error flushing bets batch: ${error}`));
        }, config.stake.batchFlushIntervalMs);

        await this.page.exposeFunction('onWSMessage', this.handleMessage.bind(this));
        await this.subscribeBets();
        this.monitorTask = this.mainLoop();
    }

    async stop(): Promise<void> {
        if (!this.monitoring) return;
        this.monitoring = false;
        await this.monitorTask?.catch((error) => this.logger.error(`Error while awaiting monitor task: ${error}`));
        this.monitorTask = undefined;
        this.logger.info('Monitoring stopped');
        if (this.page) this.page.close();
        if (this.browser) this.browser.close();
        if (this.betsBatchInterval) clearInterval(this.betsBatchInterval);
        this.page = null;
        this.browser = null;
    }

    private async mainLoop(): Promise<void> {
        const scanLoop = async () => {
            while (this.monitoring) {
                try {
                    await this.scanAndAlert();
                } catch (error) {
                    this.logger.error(`Error in scanAndAlert: ${error}`);
                }
                if (!this.monitoring) break;
                await this.cancellableSleep(config.monitor.intervalMs);
            }
        };

        const cleanupLoop = async () => {
            while (this.monitoring) {
                try {
                    await DBService.cleanBets(config.stake.cleanupTTLms);
                } catch (error) {
                    this.logger.error(`TradeService.mainLoop cleanup: ${error}`);
                }
                if (!this.monitoring) break;
                await this.cancellableSleep(config.monitor.cleanupIntervalMs);
            }
        };
        await Promise.all([scanLoop(), cleanupLoop(), this.alertNoData(config.monitor.noDataTimeoutMs)]);
    }

    private async scanAndAlert(): Promise<void> {
        const candidates = await DBService.getStakeBetsToAlert(config.stake.minAlertBetUSD, config.stake.alertAgeMs);

        this.logger.info(`Found ${candidates.length} candidates needing alert`);
        for (const candidate of candidates) {
            try {
                await this.processAlertCandidate(candidate);
            } catch (error) {
                this.logger.error(`Failed to alert bet ${candidate.iid}: ${error}`);
            }
        }
    }

    private async processAlertCandidate(candidate: StakeBetRecord): Promise<void> {
        this.logger.info(
            `Sending alert for high-value bet: IID ${candidate.iid} ${formatCurrency(candidate.amountUSD)}`
        );
        const result = this.formatAlertMessage(candidate);
        if (!result) return;
        const { msg, buttons } = result;
        let sentWithPhoto = false;
        if (config.puppeteer.screenshotEnabled) {
            const screenshot = await this.screenshoter.capture(
                `${this.url}/sports/home?iid=${candidate.iid}&modal=bet`,
                'div[data-modal-card="true"]'
            );
            if (screenshot) {
                await this.tg.sendPhoto(config.telegram.chatID, screenshot, msg, {
                    reply_markup: buttons,
                    message_thread_id: config.telegram.stakeTopicID
                });
                sentWithPhoto = true;
            }
        }
        if (!sentWithPhoto) {
            await this.tg.sendMessage(config.telegram.chatID, msg, {
                reply_markup: buttons,
                message_thread_id: config.telegram.stakeTopicID
            });
        }
        await DBService.markStakeBetAlerted(candidate.id);
    }

    private getEventDetails(type: BetType, outcomes: BetOutcome[]): string[] {
        const lines: string[] = [];
        switch (type) {
            case 'SwishBet':
                for (const outcome of outcomes as SwishBetOutcome[]) {
                    lines.push(`${outcome.event.live ? '🔴 LIVE' : '⏱️ PREMATCH'}`);
                    lines.push(`Sport: ${outcome.event.sport}`);
                    lines.push(`Competitor: ${outcome.event.competitor}`);
                    lines.push(
                        `${capitalize(outcome.event.lineType)} ${outcome.event.lineValue} - ${outcome.event.lineName}`
                    );
                    lines.push(`Odds: ${outcome.odds.toFixed(2)}`);
                    lines.push('');
                }
                break;
            case 'SportBet':
                for (const outcome of outcomes as SportBetOutcome[]) {
                    lines.push(`${outcome.event.live ? '🔴 LIVE' : '⏱️ PREMATCH'}`);
                    lines.push(`<b>${outcome.event.name} (${outcome.event.abbreviation})</b>`);
                    lines.push(`Sport: ${capitalize(outcome.event.sport)}`);
                    lines.push(`Outcome: ${outcome.event.outcome} (${outcome.event.market})`);
                    lines.push('');
                }
                break;
            case 'RacingBet':
                for (const outcome of outcomes as RacingBetOutcome[]) {
                    lines.push(`${outcome.event.live ? '🔴 LIVE' : '⏱️ PREMATCH'}`);
                    lines.push(`Sport: ${capitalize(outcome.event.sport)}`);
                    lines.push(`Venue: ${outcome.event.venue}`);
                    lines.push(`Runners:`);
                    for (const runner of outcome.event.runners) {
                        lines.push(` - ${runner.name} (#${runner.number !== null ? runner.number : 'N/A'})`);
                    }
                    lines.push(`Odds:`);
                    for (const odd of outcome.event.odds) {
                        lines.push(` - ${odd.type}: ${odd.odds.toFixed(2)}`);
                    }
                    lines.push('');
                }
                break;
            default:
                return [];
        }
        return lines;
    }

    private formatAlertMessage(candidate: StakeBetRecord): {
        msg: string;
        buttons: InlineKeyboardMarkup;
    } | null {
        const amount = formatCurrency(candidate.amountUSD);
        const multiplier = candidate.potentialMultiplier || 0;
        const potentialWin = formatCurrency(multiplier * candidate.amountUSD);
        const eventDetails = this.getEventDetails(candidate.type, candidate.outcomes);
        const header = candidate.amountUSD >= 250_000 ? '🚀 <b>HUGE BET</b> 🚀' : '💎 <b>HIGHROLLER</b> 💎';

        const lines = [
            `${header}`,
            '',
            `<b>Size:</b> <code>${amount}</code>`,
            `<b>Multiplier:</b> <code>${multiplier.toFixed(2)}x</code>`,
            `<b>Potential Win:</b> <code>${potentialWin}</code>`,
            '',
            candidate.outcomes.length > 1 ? `🎯 <b>EXPRESS</b> 🎯` : `🎯 <b>SINGLE</b> 🎯`,
            '',
            ...eventDetails
        ];
        return {
            msg: lines.join('\n'),
            buttons: {
                inline_keyboard: [
                    [
                        {
                            text: '🔗 View on Stake.com',
                            url: `${this.url}/sports/home?iid=${candidate.iid}&modal=bet`
                        }
                    ]
                ]
            }
        };
    }

    private async fetchCurrencies(): Promise<Map<string, number>> {
        const cached = await this.redis.get(this.stakeCurrenciesKey);
        if (cached) return new Map(JSON.parse(cached));

        if (!this.page) throw new Error('Puppeteer page is not initialized');

        const currencies = await this.page.evaluate(async (api: string) => {
            const res = await fetch(api, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    query: `query CurrencyConfiguration($isAcp: Boolean!) {
                                currencyConfiguration(isAcp: $isAcp) {
                                    currencies {
                                        name
                                        rates {
                                            currency
                                            rate
                                        }
                                    }
                                }
                            }`,
                    variables: { isAcp: false }
                })
            });
            const data = await res.json();
            return data.data.currencyConfiguration.currencies as Currency[];
        }, config.stake.api);

        const rateMap = new Map<string, number>();
        for (const currency of currencies) {
            const usd = currency.rates.find((r) => r.currency === 'usd');
            if (!usd) continue;
            rateMap.set(currency.name, usd.rate);
        }
        await this.redis.setEx(this.stakeCurrenciesKey, config.monitor.cacheTTLMs / 1000, JSON.stringify([...rateMap]));
        return rateMap;
    }

    private async subscribeBets(): Promise<void> {
        if (!this.page) throw new Error('Puppeteer page is not initialized');

        const allSportsPayload = allSportBetsPayload;
        const highrollerPayload = highrollerSportBetsPayload;
        const startPayload = { type: 'connection_init', payload: { language: 'en' } };
        const wssUrl = config.stake.wss;

        await this.page.evaluate(
            (wssUrl: string, startPayload: Payload, allSportsPayload: Payload, highrollerPayload: Payload) => {
                const log = (message: string, level: 'info' | 'error' | 'warn' = 'info') => {
                    (window as any).onWSMessage(
                        JSON.stringify({
                            type: 'log',
                            level,
                            message
                        })
                    );
                };
                if (!(window as any).stakeWSManager) (window as any).stakeWSManager = {};
                const manager = (window as any).stakeWSManager;

                const cleanup = (
                    wsKey: 'wsAll' | 'wsHighroller',
                    intervalKey: 'pingIntervalAll' | 'pingIntervalHighroller'
                ) => {
                    if (manager[wsKey]) {
                        try {
                            manager[wsKey].close();
                        } catch {}
                        manager[wsKey] = null;
                    }
                    if (manager[intervalKey]) {
                        clearInterval(manager[intervalKey]);
                        manager[intervalKey] = null;
                    }
                };

                cleanup('wsAll', 'pingIntervalAll');
                cleanup('wsHighroller', 'pingIntervalHighroller');

                const createConnection = (
                    name: string,
                    wsKey: 'wsAll' | 'wsHighroller',
                    intervalKey: 'pingIntervalAll' | 'pingIntervalHighroller',
                    subscriptionPayload: Payload,
                    reconnectFn: () => void
                ) => {
                    const ws = new WebSocket(wssUrl, 'graphql-transport-ws');
                    manager[wsKey] = ws;

                    ws.onopen = () => {
                        log(`WebSocket (${name}) connected`, 'info');
                        ws.send(JSON.stringify(startPayload));
                        manager[intervalKey] = setInterval(() => {
                            if (ws.readyState === WebSocket.OPEN) {
                                ws.send(JSON.stringify({ type: 'ping' }));
                            }
                        }, 15000);
                    };

                    ws.onmessage = (event) => {
                        const data = JSON.parse(event.data);
                        if (data.type === 'connection_ack') {
                            log(`WebSocket (${name}) connection acknowledged`, 'info');
                            ws.send(JSON.stringify(subscriptionPayload));
                            return;
                        }
                        if (data.type === 'ping') {
                            ws.send(JSON.stringify({ type: 'pong' }));
                            return;
                        }
                        if (data.type === 'pong') {
                            return;
                        }
                        (window as any).onWSMessage(event.data);
                    };

                    ws.onerror = (err) => log(`WebSocket (${name}) error: ${err}`, 'error');
                    ws.onclose = () => {
                        log(`WebSocket (${name}) closed. Reconnecting...`, 'warn');
                        if (manager[intervalKey]) {
                            clearInterval(manager[intervalKey]);
                            manager[intervalKey] = null;
                        }
                        setTimeout(() => reconnectFn(), 1000);
                    };
                };

                manager.connectAll = () => {
                    createConnection('AllSportBets', 'wsAll', 'pingIntervalAll', allSportsPayload, manager.connectAll);
                };

                manager.connectHighroller = () => {
                    createConnection(
                        'HighrollerSportBets',
                        'wsHighroller',
                        'pingIntervalHighroller',
                        highrollerPayload,
                        manager.connectHighroller
                    );
                };

                manager.connectAll();
                manager.connectHighroller();
            },
            wssUrl,
            startPayload,
            allSportsPayload,
            highrollerPayload
        );
    }

    private handleBrowserLog(log: any): void {
        if (!log.type || log.type !== 'log' || !log.message) return;
        switch (log.level) {
            case 'info':
                this.logger.info(`${log.message}`);
                break;
            case 'warn':
                this.logger.warn(`${log.message}`);
                break;
            case 'error':
                this.logger.error(`${log.message}`);
                break;
            default:
                this.logger.info(`${log.message}`);
        }
    }

    private async handleMessage(message: any): Promise<void> {
        try {
            const parsed = JSON.parse(message);
            if (parsed.type === 'log') {
                this.handleBrowserLog(parsed);
                return;
            }
            if (parsed.type !== 'next') return;

            const betData = parsed.payload?.data?.allSportBets || parsed.payload?.data?.highrollerSportBets;
            const source = parsed.payload?.data?.allSportBets ? 'AllSportBets' : 'HighrollerSportBets';
            if (!betData?.bet) return;

            const betRaw = betData.bet;
            const outcomes: BetOutcome[] = betRaw.outcomes.map((o: any) => {
                let outcome: SwishBetOutcome | SportBetOutcome | RacingBetOutcome;
                switch (betRaw.__typename) {
                    case 'SwishBet':
                        outcome = {
                            odds: o.odds ?? 0,
                            event: {
                                live: o?.outcome?.market?.game?.fixture?.status === 'live',
                                sport:
                                    o?.outcome?.market?.game?.fixture?.tournament?.category?.sport?.slug ?? 'unknown',
                                competitor: o?.outcome?.market?.competitor?.name ?? 'unknown',
                                lineType: o?.lineType ?? 'unknown',
                                lineValue: o?.outcome?.line ?? 0,
                                lineName: o?.outcome?.name ?? 'unknown'
                            }
                        } satisfies SwishBetOutcome;
                        break;
                    case 'RacingBet':
                        outcome = {
                            event: {
                                live: o?.event?.status === 'live',
                                type: o?.type ?? 'unknown',
                                sport: o?.event?.meeting?.racing?.slug ?? 'unknown',
                                venue: o?.event?.meeting?.venue?.name ?? 'unknown',
                                runners: [],
                                odds: []
                            }
                        } satisfies RacingBetOutcome;
                        if (Array.isArray(o.prices)) {
                            for (const price of o.prices) {
                                outcome.event.odds.push({
                                    odds: price?.odds ?? 0,
                                    type: price?.marketName ?? 'unknown'
                                });
                            }
                        }
                        if (Array.isArray(o.selectionSlots)) {
                            for (const slot of o.selectionSlots) {
                                for (const runner of slot.runners ?? []) {
                                    outcome.event.runners.push({
                                        name: runner?.name ?? 'unknown',
                                        number: runner?.runnerNumber ?? null
                                    });
                                }
                            }
                        }
                        break;
                    case 'SportBet':
                        outcome = {
                            odds: o.odds ?? 0,
                            event: {
                                live: o?.fixture?.status === 'live',
                                sport: o?.fixture?.tournament?.category?.sport?.slug ?? 'unknown',
                                name: o?.fixtureName ?? 'unknown',
                                abbreviation: o?.fixtureAbreviation ?? 'unknown',
                                outcome: o?.outcome?.name ?? 'unknown',
                                market: o?.market?.name ?? 'unknown'
                            }
                        } satisfies SportBetOutcome;
                        break;
                    default:
                        outcome = {} as any;
                }
                return outcome;
            });

            const amountUSD = await (async () => {
                const currencyRates = await this.fetchCurrencies();
                const rate = currencyRates.get(betRaw.currency);
                if (!rate) return 0;
                return betRaw.amount * rate;
            })();
            await this.handleBet({
                type: betRaw.__typename,
                potentialMultiplier: betRaw.potentialMultiplier ?? betRaw.betPotentialMultiplier ?? null,
                amountUSD,
                iid: betData.iid,
                outcomes
            });
            if (amountUSD >= 1000)
                this.logger.debug(
                    `Detected high-value bet: IID ${betData.iid} ${formatCurrency(amountUSD)} (${source})`
                );
        } catch (err) {
            this.logger.error(`Error parsing message: ${err}`);
        }
    }

    private async handleBet(bet: Partial<StakeBetDocument>): Promise<void> {
        this.betsBatch.push(bet);
        if (this.betsBatch.length >= config.stake.batchSize) this.flushBetsBatch();
    }

    private async flushBetsBatch(): Promise<void> {
        await this.flushMutex.runExclusive(async () => {
            if (this.betsBatch.length === 0) return;
            const batchToFlush = [...this.betsBatch];
            this.betsBatch = [];
            this.lastDataTimestamp = Date.now();

            const seenIids = new Set<string>();
            const uniqueBets = batchToFlush.filter((bet) => {
                if (!bet.iid || seenIids.has(bet.iid)) return false;
                seenIids.add(bet.iid);
                return true;
            });
            if (uniqueBets.length === 0) return;

            try {
                this.logger.info(`Flushing bets batch of size ${uniqueBets.length}`);
                await DBService.addStakeBetsBulk(uniqueBets);
            } catch (error) {
                this.logger.error(`Error flushing bets batch: ${error}`);
            }
        });
    }
}
