import { KioskMount } from '../kiosk-mount';

/** Spec route /kiosk/play: the kiosk statechart owns which screen shows. */
export default function KioskPlayPage() {
  return <KioskMount entry="play" />;
}
