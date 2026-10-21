/**
 * Market props for scenes and for characters to hold: produce baskets, sacks, coins (pictured
 * quantities), the brass weighing scale with an animated beam and pans, the bullock cart, the vendor's
 * hand cart, a hand lantern, a fuel can and goods (onions, tomatoes, mangoes, rice sacks, bangles, clay
 * pots). All original procedural vector art; quantities are pictured, never written (ENG-11).
 */
export { BrassScale, type BrassScaleOptions, balanceForWeights } from './BrassScale.ts';
export { createCoinPile, createCoinRow, createCoinStack } from './coins.ts';
export { type BasketOptions, createBasket, createSack, type SackOptions } from './containers.ts';
export {
  createGood,
  createGoodsPile,
  drawGood,
  GOODS_KINDS,
  GOODS_SIZE,
  type GoodsKind,
} from './goods.ts';
export { HandLantern } from './lantern.ts';
export { BullockCart, createFuelCan, HandCart } from './vehicles.ts';
