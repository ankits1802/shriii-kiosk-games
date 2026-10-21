/** Node / Electron-main entry: the sherpa-onnx engine and VAD (native addon, loaded lazily). */
export {
  loadSherpa,
  type SherpaLoader,
  type SherpaModule,
} from './binding.ts';
export {
  resolveKwsModelDir,
  SherpaKeywordEngine,
  type SherpaKeywordEngineOptions,
  type SherpaKwsModelFiles,
} from './SherpaKeywordEngine.ts';
export { SileroVad, type SileroVadOptions } from './SileroVad.ts';
