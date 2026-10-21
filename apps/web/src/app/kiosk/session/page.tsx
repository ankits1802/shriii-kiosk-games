import { KioskMount } from '../kiosk-mount';

/** Spec route /kiosk/session: the kiosk statechart owns which screen shows. */
export default function KioskSessionPage() {
  return <KioskMount entry="session" />;
}
