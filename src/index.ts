import { Context, Telegraf } from 'telegraf';
import { config } from './config';
import * as common from './common';
import { connectDB, closeDB } from './services/db';
import TradeService from './services/trade';
import { closeRedis, connectRedis } from './services/redis';

const bot = new Telegraf(config.telegram.botToken);
const tradeService = new TradeService(bot);

async function checkMessageSource(ctx: Context): Promise<boolean> {
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
    if (config.telegram.ownerUserID && ctx.from.id !== config.telegram.ownerUserID) {
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
}

function registerHandlers(): void {
    bot.command('start', async (ctx) => {
        if (!(await checkMessageSource(ctx))) {
            return;
        }
        if (tradeService.isActive()) {
            if (ctx) {
                await ctx.reply('Monitoring is already running.');
            }
            return;
        }
        common.logInfo(`Starting monitoring.`);
        if (ctx) await ctx.reply('Monitoring started.');
        void tradeService.start();
    });

    bot.command('stop', async (ctx) => {
        if (!(await checkMessageSource(ctx))) {
            return;
        }
        if (!tradeService.isActive()) {
            if (ctx) {
                void ctx.reply('Monitoring is not running.');
            }
            return;
        }
        common.logInfo('Monitoring stopped.');
        if (ctx) {
            void ctx.reply('Monitoring stopped.');
        }
        void tradeService.stop();
    });

    bot.command('stats', async (ctx) => {
        if (!(await checkMessageSource(ctx))) {
            return;
        }
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
        const [msg, ok] = await tradeService.getCoinStats(coin);
        if (!ok) {
            await ctx.reply(msg);
            return;
        }
        await ctx.reply(msg, { parse_mode: 'HTML' });
    });
}

async function main(): Promise<void> {
    await connectDB();
    await connectRedis();
    registerHandlers();
    await ensureBotReady();
    await bot.launch(() => common.logInfo('Bot started'));
    process.once('SIGINT', () => {
        bot.stop('SIGINT');
        void closeDB();
        void closeRedis();
        void tradeService.stop();
    });
    process.once('SIGTERM', () => {
        bot.stop('SIGTERM');
        void closeDB();
        void closeRedis();
        void tradeService.stop();
    });
}

main().catch((error) => {
    common.logError(`Fatal error during startup: ${error}`);
    process.exit(1);
});
