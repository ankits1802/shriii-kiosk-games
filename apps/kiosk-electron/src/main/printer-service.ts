/** Builds the thermal printer from configuration (KSK-08 hardware abstraction). */
import {
  DeviceFileTransport,
  NetworkTransport,
  type PrinterTransport,
  ThermalPrinter,
  VirtualPrinter,
} from '@shriii/escpos-printer';
import type { PrinterConfig } from './config.ts';

export function createPrinter(
  config: PrinterConfig,
  defaultVirtualDir: string,
): ThermalPrinter | null {
  let transport: PrinterTransport;
  switch (config.kind) {
    case 'none':
      return null;
    case 'virtual':
      transport = new VirtualPrinter({ outputDir: config.outputDir ?? defaultVirtualDir });
      break;
    case 'network':
      transport = new NetworkTransport({ host: config.host, port: config.port });
      break;
    case 'device':
      transport = new DeviceFileTransport({ path: config.path });
      break;
  }
  return new ThermalPrinter(transport);
}
