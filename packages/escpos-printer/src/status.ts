/**
 * Real-time status (DLE EOT n) decoding. Every response byte has bit 1 and bit 4 set and bits 0 and
 * 7 clear; anything else is rejected as noise.
 *
 * n=1 printer:  bit3 offline.
 * n=2 offline:  bit2 cover open, bit3 paper fed by button, bit5 stopped by paper end, bit6 error.
 * n=3 error:    bit2 autocutter error, bit3 unrecoverable error, bit5 auto-recoverable error.
 * n=4 paper:    bits2+3 roll near end, bits5+6 roll end.
 */

export interface PrinterStatus {
  readonly online: boolean;
  readonly coverOpen: boolean;
  readonly paperNearEnd: boolean;
  readonly paperOut: boolean;
  readonly cutterError: boolean;
  readonly unrecoverableError: boolean;
  readonly recoverableError: boolean;
}

export const FIXED_MASK = 0b1001_0011;
export const FIXED_VALUE = 0b0001_0010;

export function isStatusByte(b: number): boolean {
  return (b & FIXED_MASK) === FIXED_VALUE;
}

export class StatusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StatusError';
  }
}

/** Decode the four DLE EOT responses (n = 1, 2, 3, 4). */
export function decodeStatus(bytes: readonly [number, number, number, number]): PrinterStatus {
  const [printer, offline, error, paper] = bytes;
  for (const b of bytes) {
    if (!isStatusByte(b)) throw new StatusError(`invalid status byte 0x${b.toString(16)}`);
  }
  return {
    online: (printer & 0x08) === 0,
    coverOpen: (offline & 0x04) !== 0,
    paperOut: (offline & 0x20) !== 0 || (paper & 0x60) === 0x60,
    paperNearEnd: (paper & 0x0c) === 0x0c,
    cutterError: (error & 0x04) !== 0,
    unrecoverableError: (error & 0x08) !== 0,
    recoverableError: (error & 0x20) !== 0,
  };
}

/** Encode a status as the four response bytes (virtual printer and tests). */
export function encodeStatus(s: PrinterStatus): [number, number, number, number] {
  const offline = !s.online || s.coverOpen || s.paperOut || s.unrecoverableError || s.cutterError;
  return [
    FIXED_VALUE | (offline ? 0x08 : 0),
    FIXED_VALUE |
      (s.coverOpen ? 0x04 : 0) |
      (s.paperOut ? 0x20 : 0) |
      (s.unrecoverableError || s.cutterError || s.recoverableError ? 0x40 : 0),
    FIXED_VALUE |
      (s.cutterError ? 0x04 : 0) |
      (s.unrecoverableError ? 0x08 : 0) |
      (s.recoverableError ? 0x20 : 0),
    FIXED_VALUE | (s.paperNearEnd || s.paperOut ? 0x0c : 0) | (s.paperOut ? 0x60 : 0),
  ];
}

export type PrintBlocker =
  | 'offline'
  | 'cover_open'
  | 'paper_out'
  | 'cutter_error'
  | 'unrecoverable_error'
  | 'recoverable_error';

/** Why a print cannot start now (null when ready). Paper near end does not block. */
export function printBlocker(s: PrinterStatus): PrintBlocker | null {
  if (s.paperOut) return 'paper_out';
  if (s.coverOpen) return 'cover_open';
  if (s.unrecoverableError) return 'unrecoverable_error';
  if (s.cutterError) return 'cutter_error';
  if (s.recoverableError) return 'recoverable_error';
  if (!s.online) return 'offline';
  return null;
}

export const READY_STATUS: PrinterStatus = {
  online: true,
  coverOpen: false,
  paperNearEnd: false,
  paperOut: false,
  cutterError: false,
  unrecoverableError: false,
  recoverableError: false,
};
