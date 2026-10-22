'use client';

import {
  AlertOctagonIcon,
  ArrowRightIcon,
  BanIcon,
  FileWarningIcon,
  VolumeXIcon,
} from 'lucide-react';
import { StatusBadge } from '@/components/data/status-badge';
import { Badge } from '@/components/ui/badge';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { KeyValues, NeedsApi } from '../shared/components';
import { AudioSlot } from './audio-slot';
import { statusById, transitionOptions } from './catalogue-model';
import type { CatalogueLine, ContentSnapshot } from './content-types';

export function LineDetail({
  line,
  snapshot,
  onOpenChange,
}: {
  readonly line: CatalogueLine | null;
  readonly snapshot: ContentSnapshot;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const statuses = statusById(snapshot.workflow);
  return (
    <Sheet open={line !== null} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-2xl">
        {line && (
          <>
            <SheetHeader>
              <SheetTitle className="font-mono text-base">{line.id}</SheetTitle>
              <SheetDescription>
                {line.category}
                {line.moduleId ? ` · ${line.moduleId}` : ''} · {line.speakerRole} · tone {line.tone}
              </SheetDescription>
            </SheetHeader>
            <div className="space-y-5 px-4 pb-6">
              <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
                <p className="text-xs text-muted-foreground">
                  Reference script ({snapshot.referenceLanguage}): for recording and translation
                  only, never synthesised
                </p>
                <p className="text-sm leading-6">{line.referenceText}</p>
                <p className="text-xs text-muted-foreground">{line.context}</p>
                <div className="flex flex-wrap gap-2 pt-1">
                  <Badge variant="outline">
                    target {(line.targetDurationMs / 1000).toFixed(2)} s
                  </Badge>
                  {line.voiceForbidden && (
                    <Badge variant="warning">
                      <VolumeXIcon aria-hidden="true" />
                      never voiced on speakers
                    </Badge>
                  )}
                </div>
              </div>

              <Tabs
                defaultValue={
                  snapshot.languages.find((l) => l !== snapshot.referenceLanguage) ??
                  snapshot.referenceLanguage
                }
              >
                <TabsList>
                  {snapshot.languages.map((lang) => (
                    <TabsTrigger key={lang} value={lang} className="font-mono text-xs">
                      {lang}
                    </TabsTrigger>
                  ))}
                </TabsList>
                {snapshot.languages.map((lang) => {
                  const rec = line.recording[lang];
                  const isRef = lang === snapshot.referenceLanguage;
                  const entry = snapshot.translations[lang]?.entries[line.id];
                  const options = isRef ? [] : transitionOptions(snapshot.workflow, entry);
                  const status = entry ? statuses.get(entry.status) : undefined;
                  return (
                    <TabsContent key={lang} value={lang} className="space-y-4 pt-2">
                      <KeyValues
                        items={[
                          [
                            'Recording',
                            <StatusBadge key="r" status={rec?.status ?? 'not_scripted'} />,
                          ],
                          [
                            'Catalogue ITC state',
                            <StatusBadge key="i" status={rec?.itcState ?? 'draft'} />,
                          ],
                          ...(!isRef
                            ? ([
                                [
                                  'Translation',
                                  entry ? (
                                    <span key="t" className="flex flex-wrap items-center gap-2">
                                      <StatusBadge
                                        status={entry.status}
                                        tone={
                                          entry.status === 'flagged_for_revision'
                                            ? 'serious'
                                            : entry.status === 'approved'
                                              ? 'good'
                                              : 'neutral'
                                        }
                                        label={status?.label ?? entry.status}
                                      />
                                      {entry.stale && (
                                        <span className="flex items-center gap-1 text-xs text-warning">
                                          <FileWarningIcon className="size-3" aria-hidden="true" />
                                          source changed since translation
                                        </span>
                                      )}
                                    </span>
                                  ) : (
                                    'No entry'
                                  ),
                                ],
                              ] as const)
                            : []),
                        ]}
                      />
                      {status?.machineDraft && (
                        <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs">
                          <AlertOctagonIcon
                            className="mt-0.5 size-3.5 shrink-0 text-warning"
                            aria-hidden="true"
                          />
                          {status.description}
                        </p>
                      )}
                      {entry && (
                        <div className="space-y-3">
                          <div>
                            <p className="text-xs text-muted-foreground">Recording script</p>
                            <p lang={lang} className="text-base leading-7">
                              {entry.text || '—'}
                            </p>
                          </div>
                          <div>
                            <p className="text-xs text-muted-foreground">Back-translation</p>
                            <p className="text-sm">{entry.backTranslation || '—'}</p>
                          </div>
                          {entry.registerNote && (
                            <p className="text-xs text-muted-foreground">{entry.registerNote}</p>
                          )}
                          {!entry.record && (
                            <p className="text-xs text-muted-foreground">
                              Not recorded in this language (record: false).
                            </p>
                          )}
                        </div>
                      )}

                      {!isRef && (
                        <div className="space-y-2">
                          <p className="text-sm font-medium">Next ITC steps</p>
                          {options.length === 0 ? (
                            <p className="text-xs text-muted-foreground">
                              No further steps from this state.
                            </p>
                          ) : (
                            <ul className="space-y-1.5 text-xs">
                              {options.map((o) => (
                                <li key={o.to.id} className="rounded-md border px-3 py-2">
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <ArrowRightIcon className="size-3" aria-hidden="true" />
                                    <span className="font-medium">{o.to.label}</span>
                                    <span className="text-muted-foreground">
                                      signed by{' '}
                                      <code className="font-mono">
                                        {o.signoffRole === '*' ? 'any reviewer' : o.signoffRole}
                                      </code>
                                    </span>
                                  </div>
                                  {o.missing.length > 0 && (
                                    <p className="mt-1 flex items-center gap-1 text-warning">
                                      <BanIcon className="size-3" aria-hidden="true" />
                                      needs {o.missing.join(', ').replaceAll('_', ' ')} first
                                    </p>
                                  )}
                                  {o.barredSigners.length > 0 && (
                                    <p className="mt-1 text-muted-foreground">
                                      Independent signer: {o.barredSigners.join(', ')} may not sign
                                      this step.
                                    </p>
                                  )}
                                  {o.commentRequired && (
                                    <p className="mt-1 text-muted-foreground">
                                      A review comment is required.
                                    </p>
                                  )}
                                </li>
                              ))}
                            </ul>
                          )}
                          <NeedsApi endpoint="lineTransition" compact />
                        </div>
                      )}

                      {entry && entry.history.length > 0 && (
                        <div className="space-y-1">
                          <p className="text-sm font-medium">Sign-off trail</p>
                          <ol className="space-y-1 text-xs">
                            {entry.history.map((h) => (
                              <li
                                key={`${h.date}-${h.toStatus}-${h.by}`}
                                className="flex flex-wrap gap-x-2"
                              >
                                <span className="tabular-nums text-muted-foreground">{h.date}</span>
                                <span>
                                  {statuses.get(h.fromStatus)?.label ?? h.fromStatus} →{' '}
                                  {statuses.get(h.toStatus)?.label ?? h.toStatus}
                                </span>
                                <span className="text-muted-foreground">
                                  {h.by} ({h.role})
                                </span>
                                {h.comment && (
                                  <span className="w-full text-muted-foreground">
                                    “{h.comment}”
                                  </span>
                                )}
                              </li>
                            ))}
                          </ol>
                        </div>
                      )}

                      <AudioSlot
                        lineId={line.id}
                        language={lang}
                        targetDurationMs={line.targetDurationMs}
                        qc={snapshot.qc}
                        recordingStatus={rec?.status ?? 'not_scripted'}
                        voiceForbidden={line.voiceForbidden}
                      />
                    </TabsContent>
                  );
                })}
              </Tabs>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
