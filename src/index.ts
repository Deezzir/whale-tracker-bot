import Logger from './common/logger';
import { connectDB, closeDB } from './services/db';
import { HyperliquidService, StakeService, PolymarketService } from './services/trackers';
import Tg from './services/telegram';
import { closeRedis, connectRedis } from './services/redis';
import { Tracker } from './common/tracker';
import { config } from './config';
import * as utils from './common/utils';
import { HyperTradeDirection } from './services/db';
import { Context } from 'telegraf';
import HealthService from './healthz';

const logger = new Logger('Main');
const telegram: Tg = new Tg();
const hl = new HyperliquidService(
    telegram,
    [{ chatId: config.telegram.chatID, topicId: config.telegram.hsMainPerpsTopicID }],
    [{ chatId: config.telegram.chatID, topicId: config.telegram.hsOtherPerpsTopicID }],
    [{ chatId: config.telegram.chatID, topicId: config.telegram.hsMainSpotTopicID }],
    [{ chatId: config.telegram.chatID, topicId: config.telegram.hsOtherSpotTopicID }],
    [{ chatId: config.telegram.chatID, topicId: config.telegram.trackTopicID }]
);
const stake = new StakeService(
    telegram,
    [{ chatId: config.telegram.chatID, topicId: config.telegram.stakeTopicID }],
    false,
    true
);
const poly = new PolymarketService(telegram, [
    { chatId: config.telegram.chatID, topicId: config.telegram.polyTopicID },
    { chatId: -1003468238602, topicId: 10961 }
]);
const services: Tracker[] = [hl, stake, poly];
const healthServer = new HealthService(config.healthServerPort, services);

let keepAlive: NodeJS.Timeout;

async function extractTrackData(
    ctx: (Context & { match: RegExpMatchArray | null }) | (Context & { args: string[] }),
    command: string
): Promise<{ wallet: string; coin: string; direction: HyperTradeDirection } | null> {
    let direction: string;
    let coin: string;
    let wallet: string;

    if ('args' in ctx) {
        const args = ctx.args;
        if (args.length !== 3) {
            await ctx.reply(`Usage: /${command} <wallet> <coin> <long|short>`);
            return null;
        }
        wallet = args[0];
        coin = args[1].toUpperCase();
        direction = args[2];
    } else if ('match' in ctx && ctx.match) {
        if (ctx.match.length !== 4) {
            await ctx.reply('Invalid untrack command format.');
            return null;
        }
        wallet = ctx.match[1];
        coin = ctx.match[2].toUpperCase();
        direction = ctx.match[3];
    } else {
        await ctx.reply('Invalid command format.');
        return null;
    }

    if (!utils.isValidHyperliquidAddress(wallet)) {
        await ctx.reply(`Invalid Hyperliquid wallet address: '${wallet}'`);
        return null;
    }
    if (!utils.isValidCoinSymbol(coin)) {
        await ctx.reply(`Invalid coin symbol: '${coin}'`);
        return null;
    }
    if (direction !== 'short' && direction !== 'long') {
        await ctx.reply(`Invalid order direction: '${direction}'. Use 'long' or 'short'.`);
        return null;
    }
    return { wallet, coin, direction: direction as HyperTradeDirection };
}

telegram.registerHandlers((bot) => {
    bot.command('stats', async (ctx) => {
        if (!(await telegram.checkMessageSource(ctx, false))) return;
        const args = ctx.args;
        if (args.length !== 1) {
            await ctx.reply('Usage: /stats <coin>');
            return;
        }
        const coin = args[0].toUpperCase();
        if (!utils.isValidCoinSymbol(coin)) {
            await ctx.reply(`Invalid coin symbol: '${coin}'`);
            return;
        }
        const msg = await hl.getCoinStats(coin);
        await ctx.reply(msg, { parse_mode: 'HTML' });
    });

    bot.command('tracked', async (ctx) => {
        if (!(await telegram.checkMessageSource(ctx, false))) return;
        const msg = await hl.listTracked();
        await ctx.reply(msg, { parse_mode: 'HTML' });
    });

    bot.command('untrack', async (ctx) => {
        if (!(await telegram.checkMessageSource(ctx, false))) return;
        const trackData = await extractTrackData(ctx, 'untrack');
        if (!trackData) return;
        const { wallet, coin, direction } = trackData;
        const msg = await hl.untrack(wallet, coin, direction as HyperTradeDirection);
        await ctx.reply(msg, { parse_mode: 'HTML' });
    });

    bot.command('track', async (ctx) => {
        if (!(await telegram.checkMessageSource(ctx, false))) return;
        const trackData = await extractTrackData(ctx, 'track');
        if (!trackData) return;
        const { wallet, coin, direction } = trackData;
        const msg = await hl.track(wallet, coin, direction as HyperTradeDirection);
        await ctx.reply(msg, { parse_mode: 'HTML' });
    });

    bot.action(/^track:(.+)$/, async (ctx) => {
        if (!(await telegram.checkMessageSource(ctx, false))) return;
        if (!ctx.match || ctx.match.length !== 2) {
            await ctx.answerCbQuery('Invalid untrack command format.');
            return;
        }
        const { msg, buttons } = await hl.trackById(ctx.match[1]);
        await ctx.answerCbQuery();
        await ctx.reply(msg, { parse_mode: 'HTML' });
        if (buttons) await ctx.editMessageReplyMarkup(buttons);
        await telegram.sendMessage(config.telegram.chatID, msg, { message_thread_id: config.telegram.trackTopicID });
    });

    bot.action(/^untrack:(.+)$/, async (ctx) => {
        if (!(await telegram.checkMessageSource(ctx, false))) return;
        if (!ctx.match || ctx.match.length !== 2) {
            await ctx.answerCbQuery('Invalid untrack command format.');
            return;
        }
        const { msg, buttons } = await hl.untrackById(ctx.match[1]);
        await ctx.answerCbQuery(msg);
        await ctx.reply(msg, { parse_mode: 'HTML' });
        if (buttons) await ctx.editMessageReplyMarkup(buttons);
    });
});

function startMonitoringServices(): void {
    for (const service of services) {
        logger.info(`Auto-starting service: ${service.constructor.name}`);
        void service.start();
    }
}

async function stopMonitoringServices(): Promise<void> {
    await Promise.allSettled(
        services.map((service) => {
            logger.info(`Stopping service: ${service.constructor.name}`);
            return service.stop();
        })
    );
}

async function shutdown(code: number): Promise<void> {
    logger.info('Shutting down...');
    try {
        if (keepAlive) clearInterval(keepAlive);
        healthServer.stop();
        telegram.stop();
        await Promise.allSettled([closeDB(), closeRedis(), stopMonitoringServices()]);
    } catch (error) {
        logger.error(`Error during shutdown: ${error}`);
    }
    logger.info('Shutdown complete.');
    process.exit(code);
}

async function main(): Promise<void> {
    await connectDB();
    await connectRedis();
    void telegram.start(
        () => {
            logger.info('Telegram bot started successfully.');
        },
        (err) => {
            logger.error(`Telegram bot error: ${err}`);
            shutdown(1);
        }
    );

    logger.info('Starting monitoring services.');
    startMonitoringServices();
    healthServer.start(async (error?: string) => {
        telegram.sendRestarUnhealthyAlert(error).catch((err) => logger.error(`Failed to send unhealthy alert: ${err}`));
        shutdown(1);
    });

    keepAlive = setInterval(() => {}, 60_000);

    process.once('SIGINT', () => void shutdown(0));
    process.once('SIGTERM', () => void shutdown(0));
}

main().catch((error) => {
    logger.error(`Fatal error during startup: ${error}`);
    shutdown(1);
});
