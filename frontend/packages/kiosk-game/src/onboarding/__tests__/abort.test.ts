/**
 * A session abort (walkaway, withdrawal, wipe) must stop every screen: nothing more is logged for the
 * wiped session, and an aborted attract wait never counts as a touch to start.
 */
import './canvasStub.ts';
import { describe, expect, it } from 'vitest';
import { AttractLoop } from '../../attract/AttractLoop.ts';
import { buildDemoReportModel, EXAMPLE_DEMO_PROFILE } from '../../report/model.ts';
import { runReport } from '../../report/ReportScreen.ts';
import { ScreenAbortedError, ScreenKit } from '../ScreenKit.ts';
import { runPractice } from '../screens/practice.ts';
import { runContactOptIn, runSurvey } from '../screens/survey.ts';
import { makeRig } from './fakes.ts';

function abortedRig() {
  const rig = makeRig(() => null, { surveyTimeoutMs: 60_000, optInTimeoutMs: 60_000 });
  const ac = new AbortController();
  const services = { ...rig.services, signal: ac.signal };
  return { rig, services, ac };
}

describe('session abort stops screens without logging', () => {
  it('survey and contact opt-in log nothing once aborted', async () => {
    const { rig, services, ac } = abortedRig();
    const kit = new ScreenKit(services, rig.config);
    const survey = runSurvey(kit);
    setTimeout(() => ac.abort(), 5);
    await expect(survey).rejects.toBeInstanceOf(ScreenAbortedError);
    await expect(runContactOptIn(kit)).rejects.toBeInstanceOf(ScreenAbortedError);
    kit.destroy();
    expect(rig.logger.events).toHaveLength(0);
  });

  it('practice does not log practice.summary after an abort', async () => {
    const { rig, services, ac } = abortedRig();
    const kit = new ScreenKit(services, rig.config);
    const run = runPractice(kit);
    setTimeout(() => ac.abort(), 5);
    await expect(run).rejects.toBeInstanceOf(ScreenAbortedError);
    kit.destroy();
    expect(rig.logger.ofType('practice.summary')).toHaveLength(0);
  });

  it('an aborted attract wait is not a touch to start', async () => {
    const { rig, services, ac } = abortedRig();
    const loop = new AttractLoop(services, rig.config);
    const run = loop.run();
    setTimeout(() => ac.abort(), 5);
    await expect(run).rejects.toBeInstanceOf(ScreenAbortedError);
    loop.destroy();
  });

  it('report does not log report.delivered when aborted mid-way', async () => {
    const { rig, services, ac } = abortedRig();
    rig.voice.delayMs = 20;
    const kit = new ScreenKit(services, rig.config);
    const run = runReport(kit, buildDemoReportModel(EXAMPLE_DEMO_PROFILE, 'hi-IN'), {
      lingerMs: 10,
    });
    setTimeout(() => ac.abort(), 5);
    await expect(run).rejects.toBeInstanceOf(ScreenAbortedError);
    kit.destroy();
    expect(rig.logger.ofType('report.delivered')).toHaveLength(0);
  });
});
