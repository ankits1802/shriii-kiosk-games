import { useEffect, useRef, useState } from 'react';

interface DetectedBarcode {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}
type BarcodeDetectorCtor = new (opts: { formats: string[] }) => BarcodeDetectorLike;

function detectorCtor(): BarcodeDetectorCtor | null {
  const ctor = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  return typeof ctor === 'function' ? ctor : null;
}

export function qrScanSupported(): boolean {
  return detectorCtor() !== null && !!navigator.mediaDevices?.getUserMedia;
}

/**
 * Camera QR scan using the platform BarcodeDetector (Android WebView / Chrome). Calls `onResult`
 * with each decoded payload until the parent closes it; the parent validates the pid.
 */
export function QrScanner({
  onResult,
  onClose,
}: {
  onResult: (text: string) => void;
  onClose: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const Ctor = detectorCtor();
    if (!Ctor) {
      setError('QR scanning is not available on this device. Type the code instead.');
      return;
    }
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;
    const detector = new Ctor({ formats: ['qr_code'] });
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then(async (s) => {
        if (cancelled) {
          for (const t of s.getTracks()) t.stop();
          return;
        }
        stream = s;
        const el = video.current;
        if (!el) return;
        el.srcObject = s;
        await el.play();
        timer = setInterval(() => {
          if (el.readyState < 2) return;
          detector
            .detect(el)
            .then((codes) => {
              const first = codes[0];
              if (first?.rawValue) onResult(first.rawValue);
            })
            .catch(() => undefined);
        }, 250);
      })
      .catch(() => setError('Camera permission was refused. Type the code instead.'));
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      if (stream) for (const t of stream.getTracks()) t.stop();
    };
  }, [onResult]);

  return (
    <div className="scanner">
      {error ? (
        <p className="error">{error}</p>
      ) : (
        <video ref={video} muted playsInline className="scanner-video" />
      )}
      <button type="button" className="btn secondary" onClick={onClose}>
        Close camera
      </button>
    </div>
  );
}
