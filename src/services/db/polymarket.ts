import mongoose, { Schema, Document } from 'mongoose';
import Logger from '../../common/logger';

const logger = new Logger('db-polymarket');

export interface PolyTrade {
    transactionHash: string;
    asset: string;
    proxyWallet: string;
    conditionId: string;
    side: 'BUY' | 'SELL';
    size: number;
    price: number;
    usdAmount: number;
    outcome: string;
    outcomeIndex: number;
    timestamp: Date;
    title?: string;
    slug?: string;
}

interface PolyAlert {
    proxyWallet: string;
    conditionId: string;
    outcomeIndex: number;
    positionUsd: number;
    sentAt: Date;
    messageId?: number;
}

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

interface PolyTradeDocument extends PolyTrade, Document {}

const PolyTradeSchema = new Schema<PolyTradeDocument>(
    {
        transactionHash: { type: String, required: true, unique: true },
        asset: { type: String, required: true },
        proxyWallet: { type: String, required: true },
        conditionId: { type: String, required: true },
        side: { type: String, required: true, enum: ['BUY', 'SELL'] },
        size: { type: Number, required: true },
        price: { type: Number, required: true },
        usdAmount: { type: Number, required: true },
        outcome: { type: String, required: true },
        outcomeIndex: { type: Number, required: true },
        timestamp: { type: Date, required: true },
        title: { type: String },
        slug: { type: String }
    },
    { timestamps: true }
);

PolyTradeSchema.index({ proxyWallet: 1, conditionId: 1, outcomeIndex: 1 });
PolyTradeSchema.index({ timestamp: 1 });

const PolyTradeModel = mongoose.models.PolyTrade || mongoose.model<PolyTradeDocument>('PolyTrade', PolyTradeSchema);

interface PolyAlertDocument extends PolyAlert, Document {}

const PolyAlertSchema = new Schema<PolyAlertDocument>(
    {
        proxyWallet: { type: String, required: true },
        conditionId: { type: String, required: true },
        outcomeIndex: { type: Number, required: true },
        positionUsd: { type: Number, required: true },
        sentAt: { type: Date, required: true },
        messageId: { type: Number }
    },
    { timestamps: true }
);

PolyAlertSchema.index({ proxyWallet: 1, conditionId: 1, outcomeIndex: 1 });

const PolyAlertModel = mongoose.models.PolyAlert || mongoose.model<PolyAlertDocument>('PolyAlert', PolyAlertSchema);

export default class PolymarketDBService {
    static async addTradesBulk(tradeList: PolyTrade[]): Promise<boolean> {
        if (tradeList.length === 0) return true;
        try {
            const result = await PolyTradeModel.insertMany(tradeList, { ordered: false });
            return result.length > 0;
        } catch (err: any) {
            if (err?.code === 11000 || err?.name === 'MongoBulkWriteError') {
                const inserted = err?.result?.insertedCount ?? 0;
                logger.warn(
                    `Trade batch had ${err?.writeErrors?.length ?? 0} duplicate(s), inserted ${inserted} new trade(s)`
                );
                return inserted > 0;
            }
            logger.error(`Error inserting trade batch: ${err}`);
            throw err;
        }
    }

    static async cleanTrades(ttlMs: number): Promise<number> {
        try {
            const cutoff = new Date(Date.now() - ttlMs);
            const result = await PolyTradeModel.deleteMany({ timestamp: { $lt: cutoff } });
            logger.info(`Deleted ${result.deletedCount} old trade records`);
            return result.deletedCount;
        } catch (error) {
            logger.error(`Error cleaning trades: ${error}`);
            throw error;
        }
    }

    static async getTradesToAlert(
        threshold: number,
        sportThreshold: number,
        windowMs: number
    ): Promise<PolyAggregationRecord[]> {
        try {
            const windowStart = new Date(Date.now() - windowMs);
            const matchStage: Record<string, unknown> = { timestamp: { $gte: windowStart } };
            const minThreshold = Math.min(threshold, sportThreshold);

            type AggResult = {
                _id: { wallet: string; cond: string; outcome: number };
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
            };

            const results = await PolyTradeModel.aggregate<AggResult>([
                { $match: matchStage },
                {
                    $group: {
                        _id: {
                            wallet: '$proxyWallet',
                            cond: '$conditionId',
                            outcome: '$outcomeIndex'
                        },
                        outcome: { $first: '$outcome' },
                        title: { $first: '$title' },
                        slug: { $first: '$slug' },
                        totalBuyUsd: {
                            $sum: { $cond: [{ $eq: ['$side', 'BUY'] }, '$usdAmount', 0] }
                        },
                        totalSellUsd: {
                            $sum: { $cond: [{ $eq: ['$side', 'SELL'] }, '$usdAmount', 0] }
                        },
                        avgPrice: { $avg: '$price' },
                        tradeCount: { $sum: 1 },
                        firstTradeAt: { $min: '$timestamp' },
                        lastTradeAt: { $max: '$timestamp' }
                    }
                },
                {
                    $addFields: {
                        netUsd: { $subtract: ['$totalBuyUsd', '$totalSellUsd'] }
                    }
                },
                { $match: { netUsd: { $gte: minThreshold } } }
            ]);

            return results.map((r) => ({
                wallet: r._id.wallet,
                conditionId: r._id.cond,
                outcomeIndex: r._id.outcome,
                outcome: r.outcome,
                title: r.title || '',
                slug: r.slug || '',
                totalBuyUsd: r.totalBuyUsd,
                totalSellUsd: r.totalSellUsd,
                netUsd: r.netUsd,
                avgPrice: r.avgPrice,
                tradeCount: r.tradeCount,
                firstTradeAt: r.firstTradeAt,
                lastTradeAt: r.lastTradeAt
            }));
        } catch (error) {
            logger.error(`Error retrieving trades to alert: ${error}`);
            throw error;
        }
    }

    static async getLastAlert(
        proxyWallet: string,
        conditionId: string,
        outcomeIndex: number
    ): Promise<PolyAlert | null> {
        try {
            return PolyAlertModel.findOne({ proxyWallet, conditionId, outcomeIndex }, null, { sort: { sentAt: -1 } })
                .lean()
                .exec() as Promise<PolyAlert | null>;
        } catch (error) {
            logger.error(`Error retrieving last alert for wallet ${proxyWallet}: ${error}`);
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
