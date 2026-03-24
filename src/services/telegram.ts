import { Context, Telegraf } from 'telegraf';
import { config } from '../config';
import Logger from '../common/logger';
import { InlineKeyboardMarkup, InputFile } from 'telegraf/types';
import { getRedisClient } from './redis';
import { retry } from '../common/retrier';

const logger = new Logger('Telegram');

interface SendMessageOptions {
    reply_markup?: InlineKeyboardMarkup;
    message_thread_id?: number;
}

export default class TelegramService {
    private bot: Telegraf;
    private handlerRegistrar?: (bot: Telegraf) => void;

    constructor() {
        this.bot = new Telegraf(config.telegram.botToken);
    }

    public registerHandlers(fn: (bot: Telegraf) => void): void {
        this.handlerRegistrar = fn;
    }

    public async start(startCallback: () => void, errorCallback: (err: any) => void): Promise<void> {
        if (!this.handlerRegistrar) {
            throw new Error('Handlers must be registered via registerHandlers() before starting TelegramService.');
        }
        this.registerInternalHandlers();
        this.handlerRegistrar(this.bot);
        await this.ensureBotReady();
        await this.bot.launch(() => {
            startCallback();
            this.sendStartupMessage().catch((err) => logger.error(`Failed to send startup message: ${err}`));
        });
        this.bot.catch(errorCallback);
    }

    public stop(): void {
        try {
            this.bot.stop();
        } catch (err) {
            logger.error(`Failed to stop Telegram bot: ${err}`);
        }
    }

    public getBot(): Telegraf {
        return this.bot;
    }

    private registerInternalHandlers(): void {
        this.bot.on('message', async (ctx, next) => {
            const msg = ctx.message;
            // @ts-ignore
            if (msg && msg.pinned_message) {
                try {
                    await ctx.deleteMessage(msg.message_id);
                } catch (err) {
                    logger.warn(`Failed to delete pin service message: ${err}`);
                }
            }
            return next();
        });
    }

    private async sendStartupMessage(): Promise<void> {
        const STARTUP_MSG_KEY = 'bot:startup_message_id';
        const redis = getRedisClient();

        const oldMsgId = await redis.get(STARTUP_MSG_KEY);
        if (oldMsgId) {
            try {
                await this.bot.telegram.unpinChatMessage(config.telegram.chatID, Number(oldMsgId));
                await this.bot.telegram.deleteMessage(config.telegram.chatID, Number(oldMsgId));
            } catch (err) {
                logger.warn(`Failed to delete old startup message (id=${oldMsgId}): ${err}`);
            }
        }

        const fmt = (n: number) => `$${n.toLocaleString('en-US')}`;
        const message = [
            `<b>🟢 Whale Tracker Bot</b>`,
            ``,
            `┌─ <b>Polymarket configs</b>`,
            `  🎰 Regular threshold: <b>${fmt(config.polymarket.alertThresholdUsd)}</b>`,
            `  ⚽ Sport threshold: <b>${fmt(config.polymarket.sportAlertThresholdUsd)}</b>`,
            `  📈 Re-alert: <b>+${fmt(config.polymarket.minimalGrowthPercent)}%</b> of last position`,
            `  ⏳ Data retention: <b>${config.polymarket.cleanupTTLms / (24 * 60 * 60 * 1000)} days</b>`,
            `└─`,
            ``,
            `┌─ <b>Stake configs</b>`,
            `  🎰 Minimum bet: <b>${fmt(config.stake.minAlertBetUSD)}</b>`,
            `  ⏳ Data retention: <b>${config.stake.cleanupTTLms / (24 * 60 * 60 * 1000)} days</b>`,
            `└─`,
            ``,
            `┌─ <b>Hyperliquid configs</b>`,
            `  🎰 Minimum notional: <b>${fmt(config.hyperliquid.minNotionalUSD)}</b>`,
            `  📈 Re-alert: <b>+${fmt(config.hyperliquid.minimalGrowthPercent)}%</b> of the position increase`,
            `  ⏳ Data retention: <b>${config.hyperliquid.cleanupTTLms / (24 * 60 * 60 * 1000)} days</b>`,
            `└─`
        ].join('\n');

        const msgId = await this.sendMessage(config.telegram.chatID, message);
        await this.bot.telegram.pinChatMessage(config.telegram.chatID, msgId, { disable_notification: true });
        await redis.set(STARTUP_MSG_KEY, msgId);
        logger.info('Startup message sent and pinned');
    }

    public async sendRestarUnhealthyAlert(error?: string): Promise<void> {
        let message = `<b>🛑 Restarting bot, some services are unhealthy.</b>`;
        if (error) message += `\n\n${error}`;
        await this.sendMessage(config.telegram.ownerUserID, message);
    }

    public async sendNoDataAlert(trackerName: string, timeoutMs: number, attempt: number): Promise<void> {
        this.sendMessage(
            config.telegram.ownerUserID,
            `⚠️ Alert: No data received for ${Math.floor(timeoutMs / 60000)} minutes from ${trackerName}. Attempt ${attempt}.`
        ).catch((err) => logger.error(`Failed to send no data alert: ${err}`));
    }

    public async sendMessage(chatID: number, message: string, extra?: SendMessageOptions): Promise<number> {
        const MAX_RETRIES = 3;
        return retry(
            async () => {
                const msg = await this.bot.telegram.sendMessage(chatID, message, {
                    parse_mode: 'HTML',
                    link_preview_options: { is_disabled: true },
                    reply_markup: extra?.reply_markup,
                    message_thread_id: extra?.message_thread_id
                });
                return msg.message_id;
            },
            { attempts: MAX_RETRIES },
            logger
        );
    }

    public async sendPhoto(
        chatID: number,
        photo: Buffer,
        caption: string,
        extra?: SendMessageOptions
    ): Promise<number> {
        const MAX_RETRIES = 3;
        return retry(
            async () => {
                const inputFile: InputFile = {
                    source: photo,
                    filename: `photo_${Date.now()}.jpg`
                };
                const msg = await this.bot.telegram.sendPhoto(chatID, inputFile, {
                    caption,
                    parse_mode: 'HTML',
                    reply_markup: extra?.reply_markup,
                    message_thread_id: extra?.message_thread_id
                });
                return msg.message_id;
            },
            { attempts: MAX_RETRIES },
            logger
        );
    }

    public async sendReply(
        chatID: number,
        text: string,
        replyToMessageId: number,
        extras?: SendMessageOptions
    ): Promise<void> {
        const MAX_RETRIES = 3;
        await retry(
            async () => {
                await this.bot.telegram.sendMessage(chatID, text, {
                    parse_mode: 'HTML',
                    link_preview_options: { is_disabled: true },
                    reply_parameters: { message_id: replyToMessageId },
                    message_thread_id: extras?.message_thread_id,
                    reply_markup: extras?.reply_markup
                });
            },
            { attempts: MAX_RETRIES },
            logger
        );
    }

    public async checkMessageSource(ctx: Context, requireOwner: boolean): Promise<boolean> {
        if (!ctx.chat || !ctx.from) {
            await ctx.reply('Unable to determine chat or user information.');
            return false;
        }
        if (ctx.chat.type === 'private') {
            await ctx.reply('The bot is only available in the group.');
            return false;
        }
        if (ctx.chat.id !== config.telegram.chatID) {
            await ctx.reply('This command can only be used in the target group.');
            return false;
        }
        const member = await this.bot.telegram.getChatMember(ctx.chat.id, ctx.from.id);
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

    private async ensureBotReady(): Promise<void> {
        const botInfo = await this.bot.telegram.getMe();
        const member = await this.bot.telegram.getChatMember(config.telegram.chatID, botInfo.id);
        if (member.status !== 'administrator' && member.status !== 'creator') {
            throw new Error(`The bot is not an administrator in group ${config.telegram.chatID} `);
        }
        const chat = await this.bot.telegram.getChat(config.telegram.chatID);
        if (chat.type !== 'supergroup') {
            throw new Error(`The target chat ${config.telegram.chatID} is not a supergroup`);
        }
    }
}
