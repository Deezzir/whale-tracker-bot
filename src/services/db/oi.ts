import mongoose, { Schema, Document } from 'mongoose';

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
    isStealthPositioning: boolean;
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
        isStealthPositioning: { type: Boolean, required: true, default: false },
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
    }

    static async getEnabledInstruments(exchange?: string): Promise<IExchangeInstrument[]> {
        const filter: any = { enabled: true };
        if (exchange) filter.exchange = exchange;
        return ExchangeInstrumentModel.find(filter).lean();
    }

    static async insertAlert(record: Omit<IOIAlertRecord, keyof Document>): Promise<void> {
        await OIAlertRecordModel.create(record);
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
        if (observations.length === 0) return 0;

        const ops = observations.map((obs) => ({
            updateOne: {
                filter: { exchange: obs.exchange, instrumentId: obs.instrumentId, intervalStart: obs.intervalStart },
                update: { $set: obs },
                upsert: true
            }
        }));

        await OIObservationModel.bulkWrite(ops, { ordered: false });
        return observations.length;
    }

    static async getRecentOIObservations(
        exchange: string,
        instrumentId: string,
        limit: number
    ): Promise<IOIObservation[]> {
        const docs = await OIObservationModel.find({ exchange, instrumentId, valid: true })
            .sort({ intervalStart: -1 })
            .limit(limit)
            .lean();
        return docs.reverse();
    }
}
