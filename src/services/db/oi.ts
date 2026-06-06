import mongoose, { Schema, Document } from 'mongoose';
import Logger from '../../common/logger';

const logger = new Logger('OIDB');

export interface IExchangeInstrument extends Document {
    exchange: string;
    instrumentId: string;
    baseAsset: string;
    quoteAsset: string;
    source: 'COINGLASS' | 'HYPERLIQUID';
    lastRefreshedAt: Date;
    enabled: boolean;
}

const ExchangeInstrumentSchema = new Schema<IExchangeInstrument>(
    {
        exchange: { type: String, required: true, index: true },
        instrumentId: { type: String, required: true },
        baseAsset: { type: String, required: true },
        quoteAsset: { type: String, required: true },
        source: { type: String, required: true, enum: ['COINGLASS', 'HYPERLIQUID'], default: 'COINGLASS' },
        lastRefreshedAt: { type: Date, required: true },
        enabled: { type: Boolean, required: true, default: true }
    },
    { timestamps: true }
);

ExchangeInstrumentSchema.index({ exchange: 1, instrumentId: 1 }, { unique: true });

const ExchangeInstrumentModel = mongoose.model<IExchangeInstrument>('ExchangeInstrument', ExchangeInstrumentSchema);

export type TriggerType = 'FAST_SPIKE' | 'SLOW_ACCUMULATION' | 'SUSTAINED_BUILD';
export type Severity = 'HIGH' | 'CRITICAL';

export interface IOIAlertRecord extends Document {
    exchange: string;
    instrumentId: string;
    baseAsset: string;
    triggerType: TriggerType;
    triggerValue: number;
    previousOI: number;
    currentOI: number;
    deltaOIPercent: number;
    severity: Severity;
    priceChangePercent: number | null;
    detectedAt: Date;
    sentAt: Date;
    chatId: number;
    messageId: number | null;
    cooldownUntil: Date;
}

const OIAlertRecordSchema = new Schema<IOIAlertRecord>(
    {
        exchange: { type: String, required: true },
        instrumentId: { type: String, required: true },
        baseAsset: { type: String, required: true },
        triggerType: { type: String, required: true, enum: ['FAST_SPIKE', 'SLOW_ACCUMULATION', 'SUSTAINED_BUILD'] },
        triggerValue: { type: Number, required: true },
        previousOI: { type: Number, required: true },
        currentOI: { type: Number, required: true },
        deltaOIPercent: { type: Number, required: true },
        severity: { type: String, required: true, enum: ['HIGH', 'CRITICAL'] },
        priceChangePercent: { type: Number, default: null },
        detectedAt: { type: Date, required: true },
        sentAt: { type: Date, required: true },
        chatId: { type: Number, required: true },
        messageId: { type: Number, default: null },
        cooldownUntil: { type: Date, required: true }
    },
    { timestamps: true }
);

OIAlertRecordSchema.index({ exchange: 1, instrumentId: 1, sentAt: -1 });

const OIAlertRecordModel = mongoose.model<IOIAlertRecord>('OIAlertRecord', OIAlertRecordSchema);

export interface IOIWhitelistEntry extends Document {
    exchange: string;
    instrumentId: string;
}

const OIWhitelistEntrySchema = new Schema<IOIWhitelistEntry>(
    {
        exchange: { type: String, required: true },
        instrumentId: { type: String, required: true }
    },
    { timestamps: true }
);

OIWhitelistEntrySchema.index({ exchange: 1, instrumentId: 1 }, { unique: true });

const OIWhitelistEntryModel = mongoose.model<IOIWhitelistEntry>('OIWhitelistEntry', OIWhitelistEntrySchema);

export interface IOIObservation extends Document {
    exchange: string;
    instrumentId: string;
    baseAsset: string;
    quoteAsset: string;
    source: 'COINGLASS' | 'HYPERLIQUID';
    intervalStart: Date;
    observedAt: Date;
    openInterest: number;
    rawOpenInterest?: number;
    markPrice?: number;
    midPrice?: number;
    valid: boolean;
    invalidReason?: string;
}

const OIObservationSchema = new Schema<IOIObservation>(
    {
        exchange: { type: String, required: true },
        instrumentId: { type: String, required: true },
        baseAsset: { type: String, required: true },
        quoteAsset: { type: String, required: true },
        source: { type: String, required: true, enum: ['COINGLASS', 'HYPERLIQUID'] },
        intervalStart: { type: Date, required: true },
        observedAt: { type: Date, required: true },
        openInterest: { type: Number, required: true },
        rawOpenInterest: { type: Number },
        markPrice: { type: Number },
        midPrice: { type: Number },
        valid: { type: Boolean, required: true },
        invalidReason: { type: String }
    },
    { timestamps: true }
);

OIObservationSchema.index({ exchange: 1, instrumentId: 1, intervalStart: 1 }, { unique: true });

const OIObservationModel = mongoose.model<IOIObservation>('OIObservation', OIObservationSchema);

export default class OIDBService {
    static async upsertInstrumentUniverse(
        exchange: string,
        instruments: { instrumentId: string; baseAsset: string; quoteAsset: string }[]
    ): Promise<number> {
        try {
            const now = new Date();

            await ExchangeInstrumentModel.updateMany({ exchange }, { enabled: false });

            const ops = instruments.map((inst) => ({
                updateOne: {
                    filter: { exchange, instrumentId: inst.instrumentId },
                    update: {
                        $set: {
                            baseAsset: inst.baseAsset,
                            quoteAsset: inst.quoteAsset,
                            lastRefreshedAt: now,
                            enabled: true
                        }
                    },
                    upsert: true
                }
            }));

            if (ops.length > 0) {
                await ExchangeInstrumentModel.bulkWrite(ops, { ordered: false });
            }

            return instruments.length;
        } catch (error) {
            logger.error(`Error upserting instrument universe for ${exchange}: ${error}`);
            throw error;
        }
    }

    static async getEnabledInstruments(exchange?: string): Promise<IExchangeInstrument[]> {
        try {
            const filter: any = { enabled: true };
            if (exchange) filter.exchange = exchange;
            return ExchangeInstrumentModel.find(filter).lean();
        } catch (error) {
            logger.error(`Error fetching enabled instruments${exchange ? ` for ${exchange}` : ''}: ${error}`);
            throw error;
        }
    }

    static async insertAlert(record: Omit<IOIAlertRecord, keyof Document>): Promise<void> {
        try {
            await OIAlertRecordModel.create(record);
        } catch (error) {
            logger.error(`Error inserting OI alert record: ${error}`);
            throw error;
        }
    }

    static async upsertOIObservations(
        observations: Array<{
            exchange: string;
            instrumentId: string;
            baseAsset: string;
            quoteAsset: string;
            source: 'COINGLASS' | 'HYPERLIQUID';
            intervalStart: Date;
            observedAt: Date;
            openInterest: number;
            rawOpenInterest?: number;
            markPrice?: number;
            midPrice?: number;
            valid: boolean;
            invalidReason?: string;
        }>
    ): Promise<number> {
        try {
            if (observations.length === 0) return 0;

            const ops = observations.map((obs) => ({
                updateOne: {
                    filter: {
                        exchange: obs.exchange,
                        instrumentId: obs.instrumentId,
                        intervalStart: obs.intervalStart
                    },
                    update: { $set: obs },
                    upsert: true
                }
            }));

            await OIObservationModel.bulkWrite(ops, { ordered: false });
            return observations.length;
        } catch (error) {
            logger.error(`Error upserting OI observations: ${error}`);
            throw error;
        }
    }

    static async getRecentOIObservations(
        exchange: string,
        instrumentId: string,
        limit: number
    ): Promise<IOIObservation[]> {
        try {
            const docs = await OIObservationModel.find({ exchange, instrumentId, valid: true })
                .sort({ intervalStart: -1 })
                .limit(limit)
                .lean();
            return docs.reverse();
        } catch (error) {
            logger.error(`Error fetching recent OI observations for ${exchange} ${instrumentId}: ${error}`);
            throw error;
        }
    }

    static async cleanOldObservations(ttlMs: number): Promise<number> {
        try {
            const cutoff = new Date(Date.now() - ttlMs);
            const result = await OIObservationModel.deleteMany({ intervalStart: { $lt: cutoff } });
            return result.deletedCount;
        } catch (error) {
            logger.error(`Error cleaning old OI observations: ${error}`);
            throw error;
        }
    }

    static async cleanOldAlerts(ttlMs: number): Promise<number> {
        try {
            const cutoff = new Date(Date.now() - ttlMs);
            const result = await OIAlertRecordModel.deleteMany({ sentAt: { $lt: cutoff } });
            return result.deletedCount;
        } catch (error) {
            logger.error(`Error cleaning old OI alert records: ${error}`);
            throw error;
        }
    }

    static async countOIObservations(
        exchange: string,
        instrumentId: string,
        source: 'COINGLASS' | 'HYPERLIQUID'
    ): Promise<number> {
        try {
            return OIObservationModel.countDocuments({ exchange, instrumentId, source, valid: true });
        } catch (error) {
            logger.error(`Error counting OI observations for ${exchange} ${instrumentId}: ${error}`);
            throw error;
        }
    }

    static async addToWhitelistBulk(entries: { exchange: string; instrumentId: string }[]): Promise<void> {
        try {
            if (entries.length === 0) return;

            const ops = entries.map((entry) => ({
                updateOne: {
                    filter: { exchange: entry.exchange, instrumentId: entry.instrumentId },
                    update: { $setOnInsert: entry },
                    upsert: true,
                    setDefaultsOnInsert: true
                }
            }));

            await OIWhitelistEntryModel.bulkWrite(ops, { ordered: false });
        } catch (error) {
            logger.error(`Error adding to OI whitelist in bulk: ${error}`);
            throw error;
        }
    }

    static async removeFromWhitelist(exchange: string, instrumentId: string): Promise<void> {
        try {
            await OIWhitelistEntryModel.deleteOne({ exchange, instrumentId });
        } catch (error) {
            logger.error(`Error removing from OI whitelist for ${exchange} ${instrumentId}: ${error}`);
            throw error;
        }
    }

    static async getWhitelistEntryById(id: string): Promise<{ exchange: string; instrumentId: string } | null> {
        try {
            const doc = await OIWhitelistEntryModel.findOne({ _id: new mongoose.Types.ObjectId(id) })
                .lean<{ exchange: string; instrumentId: string }>()
                .exec();
            return doc;
        } catch (error) {
            logger.error(`Error retrieving trade with id ${id}: ${error}`);
            throw error;
        }
    }

    static async getWhitelistEntry(
        exchange: string,
        instrumentId: string
    ): Promise<{ id: string; exchange: string; instrumentId: string } | null> {
        try {
            const doc = await OIWhitelistEntryModel.findOne({ exchange, instrumentId }).lean().exec();
            return doc ? { id: String(doc._id), exchange: doc.exchange, instrumentId: doc.instrumentId } : null;
        } catch (error) {
            logger.error(`Error retrieving whitelist entry for ${exchange} ${instrumentId}: ${error}`);
            throw error;
        }
    }

    static async getWhitelist(): Promise<{ exchange: string; instrumentId: string }[]> {
        try {
            const entries = await OIWhitelistEntryModel.find().lean();
            return entries.map((e) => ({ exchange: e.exchange, instrumentId: e.instrumentId }));
        } catch (error) {
            logger.error(`Error fetching OI whitelist: ${error}`);
            throw error;
        }
    }
}
