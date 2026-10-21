// @vitest-environment node
/**
 * ENG-07 AC: the logger SDK is under 25 kB gzipped (its own code; Dexie is the shared storage engine
 * and is reported separately for information).
 */
import { describe, expect, it } from 'vitest';
import { LOGGER_SDK_BUDGET_GZIP_BYTES, measureLoggerBundle } from '../tools/measure-bundle.ts';

describe('logger SDK bundle size (ENG-07)', () => {
  it('stays within the 25 kB gzip budget', async () => {
    const { sdk, withDexie } = await measureLoggerBundle();
    console.info(
      `[logger-sdk] sdk ${sdk.gzipBytes} B gzip (${sdk.rawBytes} B raw); ` +
        `with dexie ${withDexie.gzipBytes} B gzip (${withDexie.rawBytes} B raw)`,
    );
    expect(sdk.gzipBytes).toBeGreaterThan(1000);
    expect(sdk.gzipBytes).toBeLessThanOrEqual(LOGGER_SDK_BUDGET_GZIP_BYTES);
    expect(withDexie.gzipBytes).toBeGreaterThan(sdk.gzipBytes);
  }, 120_000);
});
