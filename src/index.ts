import { Context, Telegraf } from 'telegraf';
import { config } from './config';
import * as common from './common';
import { connectDB, closeDB, TradeDirection } from './services/db';
import TradeService from './services/trade';
import StakeService from './services/stake';
import { closeRedis, connectRedis } from './services/redis';
import { Tracker } from './common/tracker';

const bot = new Telegraf(config.telegram.botToken);
const tradeService = new TradeService(bot);
const stakeService = new StakeService(bot);
const services: Tracker[] = [tradeService, stakeService];

async function checkMessageSource(ctx: Context, requireOwner: boolean): Promise<boolean> {
    if (!ctx.chat || !ctx.from) {
        await ctx.reply('Unable to determine chat or user information.');
        return false;
    }
    if (ctx.chat.type === 'private') {
        await ctx.reply('The bot is only available in the group.');
        return false;
    }
    if (ctx.chat.id !== config.telegram.targetGroupID) {
        await ctx.reply('This command can only be used in the target group.');
        return false;
    }
    const member = await bot.telegram.getChatMember(ctx.chat.id, ctx.from.id);
    if (member.status !== 'administrator' && member.status !== 'creator') {
        if (!config.telegram.ownerUserID || ctx.from.id !== config.telegram.ownerUserID) {
            await ctx.reply('Only group administrators can control monitoring.');
            return false;
        }
    }
    if (requireOwner && ctx.from.id !== config.telegram.ownerUserID) {
        await ctx.reply('Only the bot owner can control monitoring.');
        return false;
    }
    return true;
}

async function ensureBotReady(): Promise<void> {
    const botInfo = await bot.telegram.getMe();
    const member = await bot.telegram.getChatMember(config.telegram.targetGroupID, botInfo.id);
    if (member.status !== 'administrator' && member.status !== 'creator') {
        throw new Error(`The bot is not an administrator in group ${config.telegram.targetGroupID}`);
    }
    const chat = await bot.telegram.getChat(config.telegram.targetGroupID);
    if (chat.type !== 'supergroup') {
        throw new Error(`The target chat ${config.telegram.targetGroupID} is not a supergroup`);
    }
}

async function extractTrackData(
    ctx: (Context & { match: RegExpMatchArray | null }) | (Context & { args: string[] }),
    command: string
): Promise<{ wallet: string; coin: string; direction: TradeDirection } | null> {
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

    if (!common.isValidHyperliquidAddress(wallet)) {
        await ctx.reply(`Invalid Hyperliquid wallet address: '${wallet}'`);
        return null;
    }
    if (!common.isValidCoinSymbol(coin)) {
        await ctx.reply(`Invalid coin symbol: '${coin}'`);
        return null;
    }
    if (direction !== 'short' && direction !== 'long') {
        await ctx.reply(`Invalid order direction: '${direction}'. Use 'long' or 'short'.`);
        return null;
    }
    return { wallet, coin, direction: direction as TradeDirection };
}

function registerHandlers(): void {
    bot.command('start', async (ctx) => {
        if (!(await checkMessageSource(ctx, true))) return;
        if (serviceActive()) {
            await ctx.reply('Monitoring is already running.');
            return;
        }
        common.logInfo(`Starting monitoring.`);
        if (ctx) await ctx.reply('Monitoring started.');
        startMonitoringServices();
    });

    bot.command('stop', async (ctx) => {
        if (!(await checkMessageSource(ctx, true))) return;
        if (!serviceActive()) {
            await ctx.reply('Monitoring is not running.');
            return;
        }
        common.logInfo('Monitoring stopped.');
        stopMonitoringServices();
    });

    bot.command('stats', async (ctx) => {
        if (!(await checkMessageSource(ctx, false))) return;
        const args = ctx.args;
        if (args.length !== 1) {
            await ctx.reply('Usage: /stats <coin>');
            return;
        }
        const coin = args[0].toUpperCase();
        if (!common.isValidCoinSymbol(coin)) {
            await ctx.reply(`Invalid coin symbol: '${coin}'`);
            return;
        }
        const msg = await tradeService.getCoinStats(coin);
        await ctx.reply(msg, { parse_mode: 'HTML' });
    });

    bot.command('tracked', async (ctx) => {
        if (!(await checkMessageSource(ctx, false))) return;
        const msg = await tradeService.listTracked();
        await ctx.reply(msg, { parse_mode: 'HTML' });
    });

    bot.command('untrack', async (ctx) => {
        if (!(await checkMessageSource(ctx, false))) return;
        const trackData = await extractTrackData(ctx, 'untrack');
        if (!trackData) return;
        const { wallet, coin, direction } = trackData;
        const msg = await tradeService.untrack(wallet, coin, direction as TradeDirection);
        await ctx.reply(msg, { parse_mode: 'HTML' });
    });

    bot.command('track', async (ctx) => {
        if (!(await checkMessageSource(ctx, false))) return;
        const trackData = await extractTrackData(ctx, 'track');
        if (!trackData) return;
        const { wallet, coin, direction } = trackData;
        const msg = await tradeService.track(wallet, coin, direction as TradeDirection);
        await ctx.reply(msg, { parse_mode: 'HTML' });
    });

    bot.action(/^track:(.+)$/, async (ctx) => {
        if (!(await checkMessageSource(ctx, false))) return;
        if (!ctx.match || ctx.match.length !== 2) {
            await ctx.answerCbQuery('Invalid untrack command format.');
            return;
        }
        const { msg, buttons } = await tradeService.trackById(ctx.match[1]);
        await ctx.answerCbQuery();
        await ctx.reply(msg, { parse_mode: 'HTML' });

        if (buttons) await ctx.editMessageReplyMarkup(buttons);

        await bot.telegram.sendMessage(config.telegram.targetGroupID, msg, {
            parse_mode: 'HTML',
            message_thread_id: config.telegram.targetTrackTopicID
        });
    });

    bot.action(/^untrack:(.+)$/, async (ctx) => {
        if (!(await checkMessageSource(ctx, false))) return;
        if (!ctx.match || ctx.match.length !== 2) {
            await ctx.answerCbQuery('Invalid untrack command format.');
            return;
        }
        const { msg, buttons } = await tradeService.untrackById(ctx.match[1]);
        await ctx.answerCbQuery(msg);
        await ctx.reply(msg, { parse_mode: 'HTML' });
        if (buttons) await ctx.editMessageReplyMarkup(buttons);
    });
}

function startMonitoringServices(): void {
    for (const service of services) {
        common.logInfo(`Auto-starting service: ${service.constructor.name}`);
        void service.start();
    }
}

function stopMonitoringServices(): void {
    for (const service of services) {
        common.logInfo(`Stopping service: ${service.constructor.name}`);
        void service.stop();
    }
}

function serviceActive(): boolean {
    for (const service of services) {
        if (service.isActive()) {
            return true;
        }
    }
    return false;
}

function shutdown(code: number): void {
    try {
        bot.stop();
    } catch { }

    void closeDB();
    void closeRedis();
    stopMonitoringServices();

    setTimeout(() => process.exit(code), 100);
}

async function main(): Promise<void> {
    await connectDB();
    await connectRedis();

    registerHandlers();
    await ensureBotReady();

    if (config.monitor.autostart) {
        common.logInfo('Auto-starting monitoring services.');
        startMonitoringServices();
    }

    await bot.launch(() => common.logInfo('Bot started'));

    process.once('SIGINT', () => shutdown(0));
    process.once('SIGTERM', () => shutdown(0));
    bot.catch((err) => {
        common.logError(`Bot error: ${err}`);
        shutdown(1);
    });
}

main().catch((error) => {
    common.logError(`Fatal error during startup: ${error}`);
    process.exit(1);
});
