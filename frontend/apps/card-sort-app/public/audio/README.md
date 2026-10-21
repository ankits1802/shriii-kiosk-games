# Spoken prompt slots

Recorded native-speaker prompts go in `public/audio/<language>/<slot>.mp3` and ship inside the
APK. Languages: `en-IN`, `hi-IN`, `mr-IN`, `ta-IN`. Slots (`src/audio/slots.ts`):

| Slot           | When it plays                                              |
| -------------- | ---------------------------------------------------------- |
| `instructions` | Administrator taps "Play spoken instructions"               |
| `begin`        | Tablet handed to the participant                            |
| `correct`      | Reserved: per-trial feedback is a tone plus the tick image  |
| `incorrect`    | Reserved: per-trial feedback is a tone plus the cross image |
| `finished`     | End screen                                                  |

When a file is missing the app falls back to the administrator reading the script aloud. Set
the device's "Audio version" (semver) in Settings once recordings that have passed ITC audio QC
are installed. It is sent as `audio_version` with every record. Recordings follow the
translation workflow (draft → … → `audio_qc` → approved) and are not committed until approved.
