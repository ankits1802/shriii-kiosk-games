/** Player report (REP-01..03): fail-closed gating, signed release pack, bands, screen, print and QR. */
export { type BandOutcome, bandForComposite, compositeScore, inverseNormalCdf } from './bands.ts';
export { ditherToMono, escposRaster, type MonoBitmap, PRINTER_DOTS } from './escpos.ts';
export {
  batteryGateOpen,
  buildDemoReportModel,
  buildPlayerReportModel,
  capStatus,
  DEFAULT_DISCLAIMER_KEY,
  type DeliveryMode,
  type DisplayTrait,
  EXAMPLE_DEMO_PROFILE,
  type PlayerReportInputs,
  spokenLines,
} from './model.ts';
export { buildPrintSummary, rasterisePrintSummary } from './print.ts';
export { drawQr, encodeQr, type QrMatrix } from './qr.ts';
export { type ReportScreenOptions, type ReportScreenResult, runReport } from './ReportScreen.ts';
export {
  canonicalJson,
  createReleasePackReader,
  NO_PACK,
  type PackFailure,
  type PackVerification,
  type ReleasePackTrust,
  signingPayload,
  type VerifiedPackReader,
  verifyReleasePack,
} from './releasePack.ts';
export {
  CONSTRUCT_REPORT,
  DISPLAY_RULE,
  PERMANENT_WITHHOLD,
  REPORT_LIMITS,
  SEM_RULE,
} from './rules/rules.generated.ts';
export { TRAIT_ART, traitCard } from './traitArt.ts';
