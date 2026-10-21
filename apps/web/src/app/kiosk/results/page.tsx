import { KioskMount } from '../kiosk-mount';

/** Spec route /kiosk/results: the kiosk statechart owns which screen shows. */
export default function KioskResultsPage() {
  return <KioskMount entry="results" />;
}
