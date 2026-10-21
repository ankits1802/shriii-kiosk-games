'use client';

import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { type ChartTokens, LIGHT_TOKENS, readChartTokens } from './tokens';

/** Chart tokens for the active theme; re-read from CSS whenever the theme changes. */
export function useChartTokens(): ChartTokens {
  const { resolvedTheme } = useTheme();
  const [tokens, setTokens] = useState<ChartTokens>(LIGHT_TOKENS);
  useEffect(() => {
    // The class on <html> flips before effects run, so computed styles are current here.
    void resolvedTheme;
    setTokens(readChartTokens());
  }, [resolvedTheme]);
  return tokens;
}
