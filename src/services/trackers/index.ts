import HyperliquidService from './hyperliquid';
import StakeService from './stake';
import PolymarketService from './polymarket';
import OIService from './oi';

export const trackerNames = [HyperliquidService.name, StakeService.name, PolymarketService.name, OIService.name].map(
    (name) => ({ name: name.replace('Service', '').toLowerCase(), fullName: name })
);

export { HyperliquidService, StakeService, PolymarketService, OIService as CoinglassService };
