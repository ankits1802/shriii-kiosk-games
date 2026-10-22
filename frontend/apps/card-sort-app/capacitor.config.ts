import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'org.shriii.cardsort',
  appName: 'SHRIII Card Sort',
  webDir: 'dist',
  android: {
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
  },
  plugins: {
    CapacitorSQLite: {
      androidIsEncryption: false,
    },
  },
};

export default config;
