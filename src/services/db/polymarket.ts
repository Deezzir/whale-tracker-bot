import mongoose, { Schema, Document } from 'mongoose';
import Logger from '../../common/logger';

const logger = new Logger('PolymarketDB');

export interface PolyTradeInput {
    proxyWallet: string;
    conditionId: string;
    side: 'BUY' | 'SELL';
    price: number;
    usdAmount: number;
    outcome: string;
    outcomeIndex: number;
    timestamp: Date;
    title?: string;
    slug?: string;
}

interface PolyAggregationDocument extends Document {
    proxyWallet: string;
    conditionId: string;
    outcomeIndex: number;
    dateKey: string;
    outcome: string;
    title: string;
    slug: string;
    totalBuyUsd: number;
    totalSellUsd: number;
    netUsd: number;
    priceSum: number;
    tradeCount: number;
    firstTradeAt: Date;
    lastTradeAt: Date;
}

const PolyAggregationSchema = new Schema<PolyAggregationDocument>(
    {
        proxyWallet: { type: String, required: true },
        conditionId: { type: String, required: true },
        outcomeIndex: { type: Number, required: true },
        dateKey: { type: String, required: true },
        outcome: { type: String, default: '' },
        title: { type: String, default: '' },
        slug: { type: String, default: '' },
        totalBuyUsd: { type: Number, default: 0 },
        totalSellUsd: { type: Number, default: 0 },
        netUsd: { type: Number, default: 0 },
        priceSum: { type: Number, default: 0 },
        tradeCount: { type: Number, default: 0 },
        firstTradeAt: { type: Date },
        lastTradeAt: { type: Date }
    },
    { timestamps: true }
);

PolyAggregationSchema.index({ proxyWallet: 1, conditionId: 1, outcomeIndex: 1, dateKey: 1 }, { unique: true });
PolyAggregationSchema.index({ dateKey: 1, netUsd: 1 });
PolyAggregationSchema.index({ updatedAt: 1 });

const PolyAggregationModel =
    mongoose.models.PolyAggregation ||
    mongoose.model<PolyAggregationDocument>('PolyAggregation', PolyAggregationSchema);

interface PolyAlert {
    proxyWallet: string;
    conditionId: string;
    outcomeIndex: number;
    positionUsd: number;
    sentAt: Date;
    chatId: number;
    messageId?: number;
}

interface PolyAlertDocument extends PolyAlert, Document {}

const PolyAlertSchema = new Schema<PolyAlertDocument>(
    {
        proxyWallet: { type: String, required: true },
        conditionId: { type: String, required: true },
        outcomeIndex: { type: Number, required: true },
        positionUsd: { type: Number, required: true },
        sentAt: { type: Date, required: true },
        chatId: { type: Number, required: true },
        messageId: { type: Number }
    },
    { timestamps: true }
);

PolyAlertSchema.index({ proxyWallet: 1, conditionId: 1, outcomeIndex: 1, chatId: 1 });
PolyAlertSchema.index({ proxyWallet: 1, conditionId: 1, outcomeIndex: 1, chatId: 1, sentAt: -1 });
PolyAlertSchema.index({ sentAt: 1 });

const PolyAlertModel = mongoose.models.PolyAlert || mongoose.model<PolyAlertDocument>('PolyAlert', PolyAlertSchema);

export interface PolyAggregationRecord {
    wallet: string;
    conditionId: string;
    outcomeIndex: number;
    outcome: string;
    title: string;
    slug: string;
    totalBuyUsd: number;
    totalSellUsd: number;
    netUsd: number;
    avgPrice: number;
    tradeCount: number;
    firstTradeAt: Date;
    lastTradeAt: Date;
}

export interface PositionKey {
    proxyWallet: string;
    conditionId: string;
    outcomeIndex: number;
}

export default class PolymarketDBService {
    private static formatDateKey(timestamp: number, windowMs?: number): string {
        if (!windowMs) {
            return new Date(timestamp).toISOString().slice(0, 10);
        }
        const bucketStart = Math.floor(timestamp / windowMs) * windowMs;
        return new Date(bucketStart).toISOString();
    }

    static async addTradesBulk(tradeList: PolyTradeInput[], windowMs?: number): Promise<boolean> {
        if (tradeList.length === 0) return true;
        try {
            const aggregated = new Map<
                string,
                {
                    filter: { proxyWallet: string; conditionId: string; outcomeIndex: number; dateKey: string };
                    totalBuyUsd: number;
                    totalSellUsd: number;
                    netUsd: number;
                    priceSum: number;
                    tradeCount: number;
                    firstTradeAt: Date;
                    lastTradeAt: Date;
                    outcome: string;
                    title: string;
                    slug: string;
                }
            >();

            for (const trade of tradeList) {
                const dateKey = this.formatDateKey(trade.timestamp.getTime(), windowMs);
                const key = `${trade.proxyWallet}:${trade.conditionId}:${trade.outcomeIndex}:${dateKey}`;
                const isBuy = trade.side === 'BUY';
                const existing = aggregated.get(key);
                const nextOutcome = (trade.outcome || '').trim();
                const nextTitle = (trade.title || '').trim();
                const nextSlug = (trade.slug || '').trim();

                if (existing) {
                    existing.totalBuyUsd += isBuy ? trade.usdAmount : 0;
                    existing.totalSellUsd += isBuy ? 0 : trade.usdAmount;
                    existing.netUsd += isBuy ? trade.usdAmount : -trade.usdAmount;
                    existing.priceSum += trade.price;
                    existing.tradeCount += 1;
                    if (trade.timestamp < existing.firstTradeAt) existing.firstTradeAt = trade.timestamp;
                    if (trade.timestamp > existing.lastTradeAt) existing.lastTradeAt = trade.timestamp;
                    if (nextOutcome) existing.outcome = nextOutcome;
                    if (nextTitle) existing.title = nextTitle;
                    if (nextSlug) existing.slug = nextSlug;
                    continue;
                }

                aggregated.set(key, {
                    filter: {
                        proxyWallet: trade.proxyWallet,
                        conditionId: trade.conditionId,
                        outcomeIndex: trade.outcomeIndex,
                        dateKey
                    },
                    totalBuyUsd: isBuy ? trade.usdAmount : 0,
                    totalSellUsd: isBuy ? 0 : trade.usdAmount,
                    netUsd: isBuy ? trade.usdAmount : -trade.usdAmount,
                    priceSum: trade.price,
                    tradeCount: 1,
                    firstTradeAt: trade.timestamp,
                    lastTradeAt: trade.timestamp,
                    outcome: nextOutcome,
                    title: nextTitle,
                    slug: nextSlug
                });
            }

            const bulkOps = Array.from(aggregated.values()).map((entry) => {
                const setFields: Record<string, string> = {};
                if (entry.outcome) setFields.outcome = entry.outcome;
                if (entry.title) setFields.title = entry.title;
                if (entry.slug) setFields.slug = entry.slug;

                const setOnInsertFields: Record<string, string> = {};
                if (!setFields.outcome) setOnInsertFields.outcome = entry.outcome || '';
                if (!setFields.title) setOnInsertFields.title = entry.title || '';
                if (!setFields.slug) setOnInsertFields.slug = entry.slug || '';

                const update: {
                    $inc: {
                        totalBuyUsd: number;
                        totalSellUsd: number;
                        netUsd: number;
                        priceSum: number;
                        tradeCount: number;
                    };
                    $min: { firstTradeAt: Date };
                    $max: { lastTradeAt: Date };
                    $set?: Record<string, string>;
                    $setOnInsert?: Record<string, string>;
                } = {
                    $inc: {
                        totalBuyUsd: entry.totalBuyUsd,
                        totalSellUsd: entry.totalSellUsd,
                        netUsd: entry.netUsd,
                        priceSum: entry.priceSum,
                        tradeCount: entry.tradeCount
                    },
                    $min: { firstTradeAt: entry.firstTradeAt },
                    $max: { lastTradeAt: entry.lastTradeAt }
                };

                if (Object.keys(setFields).length > 0) {
                    update.$set = setFields;
                }

                if (Object.keys(setOnInsertFields).length > 0) {
                    update.$setOnInsert = setOnInsertFields;
                }

                return {
                    updateOne: {
                        filter: entry.filter,
                        update,
                        upsert: true
                    }
                };
            });

            const start = performance.now();
            const result = await PolyAggregationModel.bulkWrite(bulkOps, { ordered: false });
            logger.debug(
                `addTradesBulk: ${tradeList.length} trades aggregated to ${bulkOps.length} ops in ${(performance.now() - start).toFixed(1)}ms`
            );
            return result.ok === 1;
        } catch (error) {
            logger.error(`Error inserting trade batch: ${error}`);
            throw error;
        }
    }

    static async cleanTrades(ttlMs: number): Promise<number> {
        try {
            const cutoff = new Date(Date.now() - ttlMs);
            const result = await PolyAggregationModel.deleteMany({ updatedAt: { $lt: cutoff } });
            logger.info(`Deleted ${result.deletedCount} old aggregation records`);
            return result.deletedCount;
        } catch (error) {
            logger.error(`Error cleaning trades: ${error}`);
            throw error;
        }
    }

    static async cleanAlerts(ttlMs: number): Promise<number> {
        try {
            const cutoff = new Date(Date.now() - ttlMs);
            const result = await PolyAlertModel.deleteMany({ sentAt: { $lt: cutoff } });
            logger.info(`Deleted ${result.deletedCount} old alert records`);
            return result.deletedCount;
        } catch (error) {
            logger.error(`Error cleaning alerts: ${error}`);
            throw error;
        }
    }

    static async getTradesToAlert(
        keysToScan: PositionKey[],
        threshold: number,
        sportThreshold: number,
        windowMs?: number
    ): Promise<PolyAggregationRecord[]> {
        try {
            if (keysToScan.length === 0) return [];
            const dateKey = this.formatDateKey(Date.now(), windowMs);
            const minThreshold = Math.min(threshold, sportThreshold);

            const start = performance.now();
            const docs = await PolyAggregationModel.find({
                dateKey,
                netUsd: { $gte: minThreshold },
                $or: keysToScan.map((k) => ({
                    proxyWallet: k.proxyWallet,
                    conditionId: k.conditionId,
                    outcomeIndex: k.outcomeIndex
                }))
            })
                .lean()
                .exec();
            logger.debug(
                `getTradesToAlert: ${keysToScan.length} keys, ${docs.length} results in ${(performance.now() - start).toFixed(1)}ms`
            );

            return docs.map((d) => ({
                wallet: d.proxyWallet,
                conditionId: d.conditionId,
                outcomeIndex: d.outcomeIndex,
                outcome: d.outcome || '',
                title: d.title || '',
                slug: d.slug || '',
                totalBuyUsd: d.totalBuyUsd,
                totalSellUsd: d.totalSellUsd,
                netUsd: d.netUsd,
                avgPrice: d.tradeCount > 0 ? d.priceSum / d.tradeCount : 0,
                tradeCount: d.tradeCount,
                firstTradeAt: d.firstTradeAt,
                lastTradeAt: d.lastTradeAt
            }));
        } catch (error) {
            logger.error(`Error retrieving trades to alert: ${error}`);
            throw error;
        }
    }

    static async getLastAlerts(
        proxyWallet: string,
        conditionId: string,
        outcomeIndex: number,
        chatIds: number[]
    ): Promise<Map<number, PolyAlert>> {
        if (chatIds.length === 0) return new Map();
        try {
            const start = performance.now();
            const docs = await PolyAlertModel.aggregate<{ _id: number; doc: PolyAlert }>([
                { $match: { proxyWallet, conditionId, outcomeIndex, chatId: { $in: chatIds } } },
                { $sort: { sentAt: -1 } },
                { $group: { _id: '$chatId', doc: { $first: '$$ROOT' } } }
            ]);
            logger.debug(
                `getLastAlerts: wallet=${proxyWallet}, ${docs.length} results in ${(performance.now() - start).toFixed(1)}ms`
            );
            const result = new Map<number, PolyAlert>();
            for (const { _id, doc } of docs) {
                result.set(_id, doc);
            }
            return result;
        } catch (error) {
            logger.error(`Error retrieving last alerts for wallet ${proxyWallet}: ${error}`);
            throw error;
        }
    }

    static async insertAlert(alert: PolyAlert): Promise<void> {
        try {
            await PolyAlertModel.create(alert);
        } catch (error) {
            logger.error(`Error inserting alert for wallet ${alert.proxyWallet}: ${error}`);
            throw error;
        }
    }
}
