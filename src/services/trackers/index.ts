import HyperliquidService from './hyperliquid';
import StakeService from './stake';
import PolymarketService from './polymarket';
import CoinglassService from './coinglass';

export const trackerNames = [
    HyperliquidService.name,
    StakeService.name,
    PolymarketService.name,
    CoinglassService.name
].map((name) => ({ name: name.replace('Service', '').toLowerCase(), fullName: name }));

export { HyperliquidService, StakeService, PolymarketService, CoinglassService };
