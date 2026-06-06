import { Context } from 'telegraf';
import { HyperTradeDirection } from './services/db';
import { isValidCoinSymbol, isValidHyperliquidAddress } from './common/utils';
import { HyperliquidService } from './services/trackers';
import OIService from './services/trackers/oi';
import { config } from './config';
import TelegramService from './services/telegram';

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

    if (!isValidHyperliquidAddress(wallet)) {
        await ctx.reply(`Invalid Hyperliquid wallet address: '${wallet}'`);
        return null;
    }
    if (!isValidCoinSymbol(coin)) {
        await ctx.reply(`Invalid coin symbol: '${coin}'`);
        return null;
    }
    if (direction !== 'short' && direction !== 'long') {
        await ctx.reply(`Invalid order direction: '${direction}'. Use 'long' or 'short'.`);
        return null;
    }
    return { wallet, coin, direction: direction as HyperTradeDirection };
}

export function registerHyperliquidHandlers(tg: TelegramService, hl: HyperliquidService) {
    const trackChatID = config.telegram.hlTrackChatID;
    const bot = tg.getBot();

    bot.command('stats', async (ctx) => {
        if (!(await tg.checkMessageSource(ctx, trackChatID, false))) return;
        const args = ctx.args;
        if (args.length !== 1) {
            await ctx.reply('Usage: /stats <coin>');
            return;
        }
        const coin = args[0].toUpperCase();
        if (!isValidCoinSymbol(coin)) {
            await ctx.reply(`Invalid coin symbol: '${coin}'`);
            return;
        }
        const msg = await hl.getCoinStats(coin);
        await ctx.reply(msg, { parse_mode: 'HTML' });
    });

    bot.command('tracked', async (ctx) => {
        if (!(await tg.checkMessageSource(ctx, trackChatID, false))) return;
        const msg = await hl.listTracked();
        await ctx.reply(msg, { parse_mode: 'HTML' });
    });

    bot.command('untrack', async (ctx) => {
        if (!(await tg.checkMessageSource(ctx, trackChatID, false))) return;
        const trackData = await extractTrackData(ctx, 'untrack');
        if (!trackData) return;
        const { wallet, coin, direction } = trackData;
        const msg = await hl.untrack(wallet, coin, direction as HyperTradeDirection);
        await ctx.reply(msg, { parse_mode: 'HTML' });
    });

    bot.command('track', async (ctx) => {
        if (!(await tg.checkMessageSource(ctx, trackChatID, false))) return;
        const trackData = await extractTrackData(ctx, 'track');
        if (!trackData) return;
        const { wallet, coin, direction } = trackData;
        const msg = await hl.track(wallet, coin, direction as HyperTradeDirection);
        await ctx.reply(msg, { parse_mode: 'HTML' });
    });

    bot.action(/^track:(.+)$/, async (ctx) => {
        if (!(await tg.checkMessageSource(ctx, trackChatID, false))) return;
        if (!ctx.match || ctx.match.length !== 2) {
            await ctx.answerCbQuery('Invalid untrack command format.');
            return;
        }
        const { msg, buttons } = await hl.trackById(ctx.match[1]);
        await ctx.answerCbQuery();
        await ctx.reply(msg, { parse_mode: 'HTML' });
        if (buttons) await ctx.editMessageReplyMarkup(buttons);
        await tg.sendMessage(config.telegram.hlTrackChatID, msg);
    });

    bot.action(/^untrack:(.+)$/, async (ctx) => {
        if (!(await tg.checkMessageSource(ctx, trackChatID, false))) return;
        if (!ctx.match || ctx.match.length !== 2) {
            await ctx.answerCbQuery('Invalid untrack command format.');
            return;
        }
        const { msg, buttons } = await hl.untrackById(ctx.match[1]);
        await ctx.answerCbQuery(msg);
        await ctx.reply(msg, { parse_mode: 'HTML' });
        if (buttons) await ctx.editMessageReplyMarkup(buttons);
    });
}

export function registerOIHandlers(tg: TelegramService, oi: OIService) {
    const bot = tg.getBot();

    bot.action(/^bl:(.+)$/, async (ctx) => {
        if (!(await tg.checkMessageSource(ctx, [config.telegram.hlOIChatID, config.telegram.oiChatID], false))) return;

        if (!ctx.match || ctx.match.length !== 2) {
            await ctx.answerCbQuery('Invalid command format.');
            return;
        }

        const { msg, success } = await oi.blacklistById(ctx.match[1]);
        await ctx.answerCbQuery();
        await ctx.reply(msg, { parse_mode: 'HTML' });
        if (success) await ctx.editMessageReplyMarkup(undefined);
    });
}
