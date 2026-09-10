# Plan — Automatische Kapitel & Zusammenfassungen aus BBB-Transkripten

_Erstellt: 2026-08-17 · Repos: `transcribe` (Generator), `bbb-player` (Anzeige)_

## 1. Ziel

Aus den vorhandenen WhisperX-Transkripten pro Aufzeichnung **Kapitel** und pro
Vorlesung eine **inhaltliche Zusammenfassung** erzeugen, beides im Player
anzeigen. Generierung vollständig **lokal** (DSGVO), Rollout schrittweise mit
Qualitätsprüfung an kleinen Stichproben.

**Nicht in Scope:** Learning Analytics Dashboard, Rollen-Gates, der offene
tldraw-Bug im Player, Änderungen an der Transkriptions-Qualität selbst.

---

## 2. Ausgangslage (verifiziert)

### 2.1 Player — Kapitel sind fertig gebaut, Daten fehlen

`src/recording/use-chapters.ts` fetcht pro Recording-Teil `chapters.json` aus dem
Recording-Root:

```json
[{ "start": 0, "title": "Intro" }, { "start": 95, "title": "Demo" }]
```

`start` = Sekunden, recording-relativ, dieselbe Uhr wie `video.currentTime`.
Fehlende oder ungültige Datei ⇒ leeres Array, kein Fehler.

Der Hook shiftet jeden Teil um seinen Offset auf die Lecture-Timeline und fügt
an Teilgrenzen automatisch ein Kapitel ein. Zwei Senken:

- `player-layout.tsx:241` — WebVTT-Blob in `<track kind="chapters">` am
  Webcam-Video ⇒ media-chrome zeichnet Seekbar-Separatoren und Hover-Tooltip.
- `panel/material.tsx:133` — erste, per Default offene Sektion im Material-Tab,
  klickbar zum Springen, aktives Kapitel hervorgehoben.

**Verifiziert:** `https://vroom.b-trend.digital/presentation/<recordId>/chapters.json`
→ **404** auf allen geprüften Recordings. `captions.json` → 200.

Für **Zusammenfassungen** existiert nichts: kein Artefakt, kein Eintrag in
`constants.ts FILES`, keine UI.

### 2.2 transcribe — die Daten liegen bereits in Postgres

| Fakt | Fundstelle |
|---|---|
| `transcripts.vtt` + `.text` + `.language` + `.durationSeconds` in Postgres | `src/lib/db.ts:28` |
| Inngest cron + event Functions, Bun/Hono/Drizzle | `src/inngest/functions/ingest.ts` |
| Cron-Scan-Pattern existiert bereits (`scanRecordings`, stündlich) | `ingest.ts:205` |
| GPU-Serialisierung schon gelöst: `TRANSCRIBE_CONCURRENCY=1`, ~10–13 GB VRAM | `ingest.ts:117` |
| Recordings-Mount ist **read-only** | `docker-compose.prod.yaml:70` (`:ro`) |
| Einziger Schreibweg zu BBB: `putRecordingTextTrack` (nur Captions) | `src/lib/bbb.ts:153` |
| `WHISPER_LANGUAGE` pinbar (`de`) | `.env.schema` |
| `DIARIZE` vorhanden, default `false` ⇒ **keine Sprecher-Labels** in den VTTs | `.env.schema` |

**Der Generator muss die VTT also nicht über HTTP holen** — sie liegt in der DB,
im selben Prozess, mit `recordingId` als Schlüssel.

### 2.3 Referenzdaten (gemessen an `bbb-player/src/recording/mocks/data.vtt`)

| Kennzahl | Wert |
|---|---|
| Dauer | 6 h 19 min (22.763 s) |
| Cues | 3.436 |
| Wörter | 44.007 |
| Tokens (geschätzt) | ~70.000 |
| ø Cue-Dauer | 5,12 s |
| Wörter/Minute | 116 |
| Sprecher-Labels | keine |

### 2.4 Bekannte Datenqualitätsprobleme (`bbb-player/docs/bbb.md` §6)

- 8 Recordings mit 7-Byte-VTT (stille Meetings)
- ~21 Recordings mit falsch erkannter Sprache (`cy`, `en`, `pt`, `uk` statt `de`)
- mind. 1 Recording mit 47 Zeichen/Sekunde (Whisper-Artefakt, abgeschlossen)

### 2.5 Gefundener Bug: `recordings.meeting_id` ist nicht eindeutig definiert

`scanRecordings` schreibt über `readLocalRecording()` → `parseRecordingMetadataXml()`
die **externalId** aus `<meta><meetingId>` (z. B. `d0c9f47b…-23-37[39]`).
`sweep` schreibt über `fetchRecordings()` die **interne** `meetingID` aus der
getRecordings-API. Beides landet in derselben Spalte. Welcher Wert drinsteht,
hängt davon ab, welcher Cron das Recording zuerst entdeckt hat.

Für die Transkription folgenlos. Für die Vorlesungs-Gruppierung (§4.3) fatal.
**Muss vor Stufe 3 behoben werden** — siehe Phase 2, Schritt 2.1.

---

## 3. Architektur: dreistufiges Map-Reduce

Der Grund ist hart und nicht verhandelbar: 70k Tokens am Stück sind auf einer
16-GB-Karte nicht robust. Der KV-Cache eines 8B-Modells in fp16 belegt bei 70k
Tokens rund 9 GB — zusätzlich zu den Gewichten und neben WhisperX, das schon
10–13 GB will.

Chunking ist deshalb keine Notlösung, sondern zugleich der Weg zur
gesamtheitlichen Zusammenfassung:

```
Stufe 1  MAP      pro Chunk (~400 Cues)   → Themengrenzen als Cue-Index + 1 Satz
Stufe 2  MERGE    ohne LLM, deterministisch → chapters.json pro Recording
Stufe 3  REDUCE   1 Call pro Vorlesung      → summary.json über alle Teile
```

**Der Clou bei Stufe 3:** Input sind nur Kapiteltitel plus die Ein-Satz-Inhalte
aller Teile — zusammen etwa 2–4k Tokens statt 70k. Das Modell sieht die
komplette Vorlesung und braucht dabei weniger Kontext als ein einzelner Chunk
in Stufe 1. Läuft auch auf 8 GB.

### 3.1 Stufe 1 — Map

- Chunk-Größe: **400 Cues** (≈ 34 min ≈ 8.200 Tokens), **Overlap 40 Cues**.
  Eine 6h19-Aufnahme ergibt damit 9 Chunks.
- Cues werden **nummeriert** in den Prompt gegeben:
  `[0142] Und damit kommen wir zum Thema VLANs.`
- Das Modell antwortet ausschließlich mit Cue-**Indizes**, nie mit Zeiten:
  ```json
  { "boundaries": [ { "cue": 142, "title": "VLANs und Tagging",
                      "gist": "Einführung in VLAN-Segmentierung und 802.1Q-Tagging." } ] }
  ```
- **Damit ist Zeit-Halluzination strukturell unmöglich.** Ein Index außerhalb des
  Chunks wird verworfen, nicht korrigiert.

### 3.2 Stufe 2 — Merge (reines TypeScript, unit-getestet)

In dieser Reihenfolge:

1. **Overlap-Dedup** — Grenzen aus überlappenden Chunks, die weniger als
   3 Cues auseinanderliegen, zu einer zusammenfassen (die aus dem früheren
   Chunk gewinnt, sie hat mehr Vorlauf gesehen).
2. **Index → Zeit** — Cue-Index auf `cue.startSeconds` mappen.
3. **Folien-Snap** — liegt innerhalb von ±30 s ein Folienwechsel, die Grenze
   dorthin ziehen. Quelle: `shapes.svg` des Recordings (`<image>`-Elemente mit
   `in`-Attribut). Ohne Folien: übersprungen, keine Fehlerbedingung.
4. **Mindestabstand** — Grenzen, die `min_gap` unterschreiten, verschmelzen
   (die spätere fällt weg).
5. **Deckelung** — bleiben mehr als `max_chapters`, die mit dem kleinsten
   Abstand zum Vorgänger streichen, bis die Zahl passt.
6. **Erstes Kapitel bei `start: 0`** erzwingen, falls Stufe 1 keine Grenze
   am Anfang gesetzt hat.

**Formel:**

```ts
const minutes     = durationSeconds / 60;
const maxChapters = clamp(Math.round(1.1 * Math.sqrt(minutes)), 5, 20);
const minGapSec   = Math.max(180, durationSeconds / (2 * maxChapters));
```

| Dauer | max. Kapitel | Mindestabstand |
|---|---|---|
| 45 min | 7 | 3,0 min |
| 90 min | 10 | 4,5 min |
| 180 min | 15 | 6,0 min |
| 379 min | 20 | 9,5 min |

Sublinear, weil eine 6-Stunden-Aufzeichnung nicht acht Mal so viele Themen
behandelt wie eine 45-Minuten-Einheit — sie behandelt dieselben länger. Lineares
Skalieren erzeugt bei 6 h dreißig-plus Kapitel und macht die Seekbar unlesbar.

Beide Zahlen gehen zusätzlich als Vorgabe in den Prompt. Dass ein kleines Modell
sich nicht daran hält, ist der Normalfall — deshalb setzt Stufe 2 sie nochmal
deterministisch durch.

### 3.3 Stufe 3 — Reduce

Input: alle Kapitel (`title` + `gist`) **aller Teile einer Vorlesung**, in
zeitlicher Reihenfolge, mit Teil-Markierung. Output:

```json
{
  "abstract": "…5–8 Sätze Fließtext…",
  "topics":     ["…", "…"],
  "objectives": ["…", "…"],
  "terms":      ["…", "…"],
  "organizational": ["…"],
  "parts": ["<recordId1>", "<recordId2>"],
  "generatedAt": 1755400000,
  "model": "gemma4:12b",
  "promptVersion": "chapters-v1"
}
```

`organizational` = Termine, Abgabefristen, Hausaufgaben, angekündigte
Prüfungsinhalte. Leeres Array, wenn nichts vorkam. Kein interner/vertraulicher
Teil — bewusste Entscheidung, siehe §9.

---

## 4. Datenmodell

### 4.1 Neue Tabelle (Drizzle-Migration)

```ts
export const insights = pgTable("insights", {
  id: serial("id").primaryKey(),
  recordingId: text("recording_id").notNull().unique()
    .references(() => recordings.id),
  /** chapters.json-Inhalt, exakt im Player-Schema. */
  chapters: jsonb("chapters"),
  /** summary.json-Inhalt; für alle Teile einer Vorlesung identisch. */
  summary: jsonb("summary"),
  /** Gruppierungsschlüssel: externalId + Kalenderdatum. */
  lectureKey: text("lecture_key"),
  model: text("model"),
  promptVersion: text("prompt_version"),
  /** Gesetzt statt chapters, wenn das Recording übersprungen wurde. */
  skipReason: text("skip_reason"),
  createdAt: integer("created_at").default(sql`extract(epoch from now())::integer`),
});
```

`skipReason` ersetzt das ursprünglich angedachte `chapters.skip`-Marker-File —
gleiche Funktion, aber in der DB statt im Dateisystem, weil der Generator ohnehin
keinen Schreibzugriff auf das published-Verzeichnis hat.

### 4.2 Skip-Gate

Vor jedem GPU-Aufruf prüfen, in dieser Reihenfolge:

| Bedingung | `skipReason` |
|---|---|
| `vtt` fehlt oder < 1024 Bytes | `empty-transcript` |
| `transcripts.language` ≠ `de` | `unexpected-language:<lang>` |
| `text.length / durationSeconds` > 25 | `garbled-transcript` |
| `durationSeconds` < 300 | `too-short` |

Ein Recording mit gesetztem `skipReason` wird vom Scan übersprungen. Ein
manueller Re-Run (`POST /insights/:id/regenerate`) löscht die Zeile und
versucht es erneut — so kommt ein Recording nach einem Server-Fix zurück ins
Rennen, ohne dass der Cron jede Stunde die GPU dafür anwirft.

### 4.3 Vorlesungs-Gruppierung

```
lectureKey = `${externalMeetingId}::${YYYY-MM-DD aus startTime}`
```

Das ist dieselbe Regel, die `view.php:190` anwendet (Datum + Gruppe), nur aus
BBB-Daten reproduziert statt aus der Moodle-DB gelesen: die `externalId` aus
`metadata.xml` (`…-23-37[39]`) ist stabil pro Moodle-Aktivität und Gruppe.

**Voraussetzung:** der Bug aus §2.5 muss behoben sein, sonst enthält
`recordings.meeting_id` je nach Discovery-Weg zwei verschiedene Dinge.

**Zu verifizieren, bevor Stufe 3 gebaut wird:** dass zwei Teile derselben
Vorlesung tatsächlich dieselbe `externalId` tragen. Befehl in §11.

---

## 5. Der Generator (Inngest)

Drei Funktionen, analog zum bestehenden Muster in `ingest.ts`.

### 5.1 `insights/scan` — cron, stündlich

Findet Recordings mit `status = 'completed'`, vorhandenem Transkript und ohne
Zeile in `insights`. Dispatcht `insights/generate` pro Recording, gechunkt wie
`DISCOVERY_BATCH`/`DISPATCH_CHUNK` im bestehenden Code.

Zusätzlich: Vorlesungen, bei denen **alle** Teile Kapitel haben, aber noch keine
`summary` gesetzt ist, dispatchen `insights/summarize` mit dem `lectureKey`.

### 5.2 `insights/generate` — event, pro Recording

```ts
{
  id: "insights/generate",
  retries: 2,
  concurrency: { key: "gpu", limit: 1 },   // ← teilt den Slot mit processRecording
  singleton: { mode: "skip", key: "event.data.recordingId" },
}
```

**Die geteilte Concurrency ist zwingend.** Auf 16 GB kann kein LLM neben
WhisperX laufen. `processRecording` muss denselben Key bekommen — das ist eine
Änderung an bestehendem Code, aber eine Zeile.

Zusätzlich `OLLAMA_KEEP_ALIVE=0` setzen, damit Ollama das Modell nach jedem
Request aus dem VRAM wirft und WhisperX seine 13 GB wiederbekommt. Kostet ~5 s
Ladezeit pro Chunk — irrelevant gegenüber der Inferenz, und die Alternative ist
ein OOM mitten in einer Transkription.

Ablauf: Skip-Gate → VTT parsen → chunken → Stufe 1 pro Chunk → Stufe 2 →
`insights.chapters` schreiben.

Fehlerbehandlung analog `processRecording`: CUDA-/OOM-Meldungen als
`NonRetriableError` durchreichen, statt dreimal dieselbe Minute zu verbrennen.

### 5.3 `insights/summarize` — event, pro Vorlesung

Liest alle `insights.chapters` mit demselben `lectureKey`, baut den Reduce-Prompt,
schreibt das Ergebnis **in jede Zeile der Vorlesung** (identischer Inhalt).

Redundanz um den Preis weniger KB — dafür ist die Zusammenfassung über jeden
einzelnen Teil erreichbar, auch bei einem Deep-Link direkt auf Teil 3.

### 5.4 Neue HTTP-Routen (`src/index.ts`, Hono + zod-openapi)

| Methode | Pfad | Zweck |
|---|---|---|
| `GET` | `/insights/{recordingId}/chapters.json` | Player-Format, unverändert |
| `GET` | `/insights/{recordingId}/summary.json` | Player-Format |
| `GET` | `/insights/{recordingId}` | beides + Metadaten, für Review |
| `POST` | `/insights/{recordingId}/regenerate` | Zeile löschen + neu dispatchen |

Die ersten beiden liefern bei fehlender Zeile `404` — der Player behandelt das
bereits als „keine Kapitel".

---

## 6. Prompts

### 6.1 Stufe 1 (Kapitelgrenzen)

Harte Regeln, im System-Prompt und im Validator doppelt:

- Antwort **ausschließlich** JSON, kein Fließtext davor oder danach.
- `cue` ist eine Zahl aus dem gezeigten Bereich.
- `title`: **maximal 60 Zeichen**, nominal formuliert, kein Satzzeichen am Ende,
  kein einleitendes Verb.
  Gut: `VLANs: Segmentierung und Tagging` · `Patchplan aus der Raumskizze`
  Schlecht: `In diesem Abschnitt lernen die Teilnehmer, wie VLANs funktionieren`
- `gist`: genau ein Satz, maximal 200 Zeichen.
- Sprache = `transcripts.language`, nicht hart Deutsch.
- Zielvorgabe im Prompt: `zwischen 1 und N Grenzen in diesem Abschnitt`, wobei
  N aus `maxChapters` anteilig auf die Chunk-Länge heruntergerechnet wird.

**Warum nominale statt lernzielorientierter Titel:** Lernziel-Formulierungen
ziehen bei 8–14B-Modellen zuverlässig Füllphrasen an, werden 70–100 Zeichen lang
und sind dann sowohl im Seekbar-Tooltip als auch in der schmalen Material-Spalte
abgeschnitten. Ein Stil-Constraint, der die Ausgabe *länger* macht, ist bei
kleinen Modellen der schlechteste Fall. Der Doppelpunkt-Zusatz transportiert die
Lernziel-Information ohne Satzbau.

### 6.2 Stufe 3 (Zusammenfassung)

- Input: Kapitelliste mit Teil-Markierung.
- `abstract`: 5–8 Sätze, Fließtext, keine Aufzählung, keine Meta-Sätze
  („In dieser Vorlesung wird behandelt…" ist verboten).
- `topics` / `objectives` / `terms`: je 3–8 Einträge, Stichpunkte, keine Sätze.
- `organizational`: nur, wenn tatsächlich Termine/Aufgaben vorkamen. Sonst `[]`.
- Nichts erfinden, was nicht in den Kapiteln steht.

### 6.3 Versionierung

`promptVersion` (z. B. `chapters-v1`) wird mitgeschrieben. Ein Prompt-Update
erhöht die Version; ein Selektiv-Regenerate über
`DELETE FROM insights WHERE prompt_version = 'chapters-v1'` schiebt dann alles
Betroffene zurück in den Scan.

---

## 7. Modellauswahl — Bake-off statt Blindwahl

Kandidaten für 16 GB VRAM (Stand August 2026, **vor der Umsetzung gegen die
aktuelle Ollama-Library prüfen** — der Markt bewegt sich schneller als dieser Plan):

| Modell | VRAM | Kontext | Anmerkung |
|---|---|---|---|
| `gemma4:12b` | ~7,6 GB | 128k | 140+ Sprachen, guter Default-Kandidat |
| `qwen3.5:9b` | ~6,6 GB | 256k | kleinster Footprint, viel Kontextreserve |
| `gpt-oss:20b` | ~14 GB | 128k | MoE; auf 16 GB zu eng neben WhisperX |

**Verfahren:** dieselben 3 Aufzeichnungen (kurz / mittel / 6 h) durch jedes
Kandidatenmodell, plus **einen Cloud-Referenzlauf** auf dem pseudonymisierten
Transkript. Bewertung durch Felix, nicht automatisiert — Fachinhalt
„Meister/in für Veranstaltungstechnik" ist von außen nicht validierbar.

**Bewertungsraster** (je Aufzeichnung, 1–5):

1. Sitzen die Grenzen an echten Themenwechseln?
2. Ist der Titel ohne Anhören verständlich?
3. Ist die Kapitelzahl angemessen?
4. Trifft die Zusammenfassung, worum es ging?
5. Steht Falsches drin? (K.-o.-Kriterium, unabhängig von 1–4)

### 7.1 DSGVO für den Cloud-Referenzlauf

Der Vergleichslauf verarbeitet reale Teilnehmerdaten. Zwei Maßnahmen, beide
vor dem ersten Cloud-Call:

1. **AVV mit dem Anbieter** (Online-Akzeptanz, kein Vertragsverhandeln) plus
   no-training/zero-retention aktivieren. EU-Anbieter vermeiden zusätzlich die
   Drittlandsübermittlung nach Kapitel V.
2. **Pseudonymisierung** vor dem Versand: lokaler NER-Durchlauf ersetzt
   Personennamen durch `[TN-1]`, `[TN-2]`. Für die Kapitelqualität irrelevant,
   und macht den Vergleich sauberer, weil beide Modelle denselben Input sehen.

Verbindliche Bewertung durch den Datenschutzbeauftragten von b-trend — dieser
Plan ist kein Rechtsrat.

---

## 8. Auslieferung an den Player — offene Entscheidung

Aktuell existiert **kein Schreibweg** in `/var/bigbluebutton/published/presentation/<id>/`:
BBBs API kennt nur `putRecordingTextTrack`, der Mount ist `:ro`, und der
transcribe-Service läuft auf einer anderen Instanz als der BBB-Host.

| Option | Aufwand | Player-Änderung | Robustheit |
|---|---|---|---|
| **A** SSH/rsync auf den BBB-Host | mittel | keine | Dateien überleben kein Republish; SSH-Key im Container |
| **B** Write-Endpoint auf dem BBB-Host | hoch | keine | neuer Dienst + Auth auf dem BBB-Host |
| **C** transcribe liefert selbst aus | gering | 1 env var + Fallback | überlebt Republish und BBB-Upgrades |

**Empfehlung: C.** Die Daten liegen ohnehin in Postgres, die Hono-API existiert,
Regenerieren ist ein `UPDATE` statt eines Datei-Deployments, und es entsteht
kein neues Secret. Preis: der Player braucht eine zweite Base-URL, der
transcribe-Host CORS für die Moodle-Origin (Rezept in `bbb-player/docs/bbb.md` §5),
und aus einem reinen Batch-Worker wird ein Dienst im Nutzerpfad. Letzteres
degradiert aber sauber — fällt er aus, zeigt der Player einfach keine Kapitel.

**Die Entscheidung blockiert nichts.** In Phase 1 liegen die Artefakte in der DB
und hinter den Endpoints aus §5.4; für die zwei bis drei Testaufnahmen kopierst
du sie von Hand (§11). Entschieden wird erst, wenn die Qualität steht.

---

## 9. Player-Änderungen

### Phase 1 — keine

Kapitel funktionieren mit dem bestehenden `chapters.json`-Contract. Für die
Testphase reicht eine handkopierte Datei.

### Phase 3 — Zusammenfassung anzeigen

1. **`src/recording/use-summary.ts`** (neu) — analog `use-chapters.ts`, holt
   `summary.json` pro Teil, nimmt das erste nicht-leere.
2. **`src/panel/material.tsx`** — vierte `<details>`-Sektion, oberhalb von
   „Kapitel", `open` per Default. Bestehendes `SectionSummary` wiederverwenden.
3. **`src/locales/messages/{de,en}.json`** — neue Keys unter
   `player.material.summary.*`.
4. Bei Option C zusätzlich: `VITE_INSIGHTS_URL` in `env.ts` und eine
   `buildInsightsURL()` neben `buildFileURL()`, die auf den bisherigen Pfad
   zurückfällt, wenn die Variable nicht gesetzt ist.

**Wenn der Material-Tab dadurch überladen wirkt:** auf einen eigenen Tab
umstellen (`side-panel.tsx` + `tabs`-Array in `player-layout.tsx`, ~15 Zeilen).
Entscheidung nach Augenschein, nicht vorab.

**Kein Rollen-Gate.** Alles unter `/presentation/` liefert nginx ohne Auth aus,
ein Gate im Player wäre reine Kosmetik. Die Zusammenfassung enthält deshalb
bewusst nur Inhalte, die für alle Kursteilnehmer bestimmt sind.

---

## 10. Phasenplan & Definition of Done

### Phase 0 — Vorbereitung (Server, du)

- [ ] `nvidia-smi` → GPU-Modell und VRAM bestätigen
- [ ] `WHISPER_LANGUAGE=de` setzen (verhindert neue Fehl-Locales)
- [ ] Ollama installieren, `OLLAMA_KEEP_ALIVE=0`
- [ ] Kandidatenmodelle ziehen

**DoD:** `ollama run <modell> "Fasse zusammen: …"` antwortet, und `nvidia-smi`
zeigt danach wieder freien Speicher.

### Phase 1 — Generator, Kapitel, Stichprobe

- [ ] Drizzle-Migration `insights`
- [ ] `src/lib/chapters.ts` — Chunking, Cue-Nummerierung, Merge-Algorithmus,
      Formel. **Unit-getestet ohne LLM** (Fixtures mit festen Grenzen).
- [ ] `src/lib/ollama.ts` — Client mit JSON-Mode und Retry bei Parse-Fehler
- [ ] `src/lib/slides.ts` — `shapes.svg` parsen für das Folien-Snapping
- [ ] `insights/generate` + Skip-Gate + geteilte GPU-Concurrency
- [ ] `GET /insights/{id}/chapters.json`
- [ ] Lauf gegen **genau 3** Recordings (kurz / mittel / 6 h)

**DoD:** `bun test` grün · drei `chapters.json` liegen vor · jede erfüllt Formel
und Titellänge · Felix bewertet Kriterien 1–3 mit ≥ 4 und Kriterium 5 mit „nein"
· `nvidia-smi` zeigt während eines Laufs nie beide Modelle gleichzeitig.

### Phase 2 — Vorlesungs-Zusammenfassung

- [ ] **Bug §2.5 beheben** — `meeting_id` vereinheitlichen, Migration für
      bestehende Zeilen
- [ ] Gruppierungsregel an echten Multipart-Vorlesungen verifizieren (§11)
- [ ] `lectureKey` + `insights/summarize` + Reduce-Prompt
- [ ] `GET /insights/{id}/summary.json`

**DoD:** Eine mehrteilige Vorlesung erzeugt **eine** Zusammenfassung, identisch
in allen Teilen abrufbar · Felix bewertet Kriterium 4 mit ≥ 4 und Kriterium 5
mit „nein".

### Phase 3 — Player

- [ ] `use-summary.ts` + Material-Sektion + i18n
- [ ] Auslieferungsoption aus §8 entscheiden und umsetzen

**DoD:** `tsc --noEmit` sauber · alle Tests grün · Kapitel und Zusammenfassung
in einer echten Vorlesung im Browser sichtbar · Seekbar zeigt Separatoren.

### Phase 4 — Rollout

- [ ] `insights/scan` scharf schalten
- [ ] Erst 10 Recordings, prüfen, dann der Rest
- [ ] Nach Vollrollout: `skipReason`-Verteilung auswerten

**DoD:** Jedes Recording hat entweder `chapters` oder ein begründetes
`skipReason` · keine Zeile älter als 48 h ohne beides.

### Nach DoD — vorgemerkte Erweiterungen

- Schema um `summary` **je Kapitel** erweitern (aufklappbar im Material-Tab)
- Schema um `keywords` erweitern (speist die Transkript-Suche)

Beides braucht `use-chapters.ts` + `material.tsx` und wartet bewusst, bis die
Kapitelqualität abgenommen ist.

---

## 11. Befehle

```bash
# --- Phase 0: GPU prüfen -------------------------------------------------
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv

# --- Gruppierungsregel verifizieren (auf dem BBB-Host) -------------------
# Erwartung: zwei Teile derselben Vorlesung teilen sich die externalId.
for d in /var/bigbluebutton/published/presentation/*/; do
  id=$(basename "$d")
  ext=$(grep -o 'externalId="[^"]*"' "$d/metadata.xml" 2>/dev/null | head -1)
  day=$(date -d "@$(( ${id##*-} / 1000 ))" +%F 2>/dev/null)
  echo "$day  $ext  $id"
done | sort | awk '{print $1, $2}' | uniq -c | sort -rn | head -20
# Zeilen mit Zähler >= 2 sind mehrteilige Vorlesungen.

# --- Skip-Gate vorab abschätzen (auf dem BBB-Host) -----------------------
for d in /var/bigbluebutton/published/presentation/*/; do
  v=$(ls "$d"/caption_*.vtt 2>/dev/null | head -1); [ -n "$v" ] || continue
  s=$(stat -c '%s' "$v")
  loc=$(grep -o '"locale": *"[^"]*"' "$d/captions.json" 2>/dev/null \
        | head -1 | sed 's/.*"locale": *"//;s/"//')
  [ "$s" -lt 1024 ] && echo "empty     $(basename "$d")"
  [ -n "$loc" ] && [ "$loc" != "de" ] && echo "lang:$loc  $(basename "$d")"
done | sort | uniq -c

# --- Phase 1: Testlauf ---------------------------------------------------
curl -s localhost:3000/insights/<recordId>/chapters.json | jq .

# --- Testartefakt von Hand ausliefern ------------------------------------
curl -s http://<transcribe-host>:3000/insights/<recordId>/chapters.json \
  > /tmp/chapters.json
scp /tmp/chapters.json \
  root@vroom.b-trend.digital:/var/bigbluebutton/published/presentation/<recordId>/chapters.json
# Gegenprobe:
curl -sI https://vroom.b-trend.digital/presentation/<recordId>/chapters.json | head -1

# --- Selektiv regenerieren nach Prompt-Update ----------------------------
psql "$DATABASE_URL" -c \
  "DELETE FROM insights WHERE prompt_version = 'chapters-v1';"
```

---

## 12. Offene Entscheidungen

| # | Entscheidung | Empfehlung | Fällig |
|---|---|---|---|
| 1 | Auslieferungsweg A / B / C (§8) | **C** | vor Phase 3 |
| 2 | Modell nach Bake-off | offen | Ende Phase 1 |
| 3 | Zusammenfassung: Material-Sektion oder eigener Tab | Sektion, Wechsel nach Augenschein | Phase 3 |
| 4 | `DIARIZE=true` aktivieren? | vorerst nein | nach Phase 4 |

Zu #4: Sprecherwechsel wären ein gutes zusätzliches Kapitelsignal, aber
Diarisierung kostet VRAM in genau dem Budget, das sich WhisperX und das LLM
bereits teilen. Erst messen, wie gut es ohne läuft.

---

## 13. Risiken

| Risiko | Wirkung | Gegenmaßnahme |
|---|---|---|
| LLM belegt VRAM neben WhisperX | OOM mitten in einer Transkription | geteilter Concurrency-Key + `OLLAMA_KEEP_ALIVE=0`; im Testlauf mit `nvidia-smi` verifizieren |
| Kleines Modell hält Formatvorgaben nicht ein | unbrauchbare Titel | JSON-Mode, Validator, Retry; Titellänge in Stufe 2 hart erzwungen |
| Kapitelgrenzen wirken willkürlich | Feature unbrauchbar | Folien-Snapping, Mindestabstand, Bewertung durch Felix vor Rollout |
| Bug §2.5 unbemerkt | Vorlesungen falsch gruppiert, Zusammenfassungen vermischen Themen | vor Phase 2 beheben, Regel vorher verifizieren |
| BBB-Republish löscht handkopierte Dateien | Kapitel verschwinden | genau das Argument für Option C |
| Backlog: ~283 Recordings × 9 Chunks | GPU über Tage belegt, Transkriptionen stauen sich | `DISCOVERY_BATCH` niedrig setzen, Rollout in 10er-Schritten |
| Prompt-Update entwertet alles Bestehende | Neugenerierung von Hand | `promptVersion` + Selektiv-Delete (§6.3) |

---

## 14. Arbeitsweise

- **ponytail** — kleinster Diff, der funktioniert. Der Merge-Algorithmus in
  Stufe 2 ist die einzige Stelle, an der bewusst Sorgfalt statt Kürze gilt:
  dort liegt die Korrektheit.
- **superpowers** — grünes `tsc` ist nicht „fertig". Jede DoD nennt eine
  Beobachtung, keine Behauptung.
- Umsetzung durch Felix per Claude Code mit verbundenen Ordnern.
- Server-Befehle führt Felix selbst aus.
- **Nichts ohne Evidenz shippen** — der tldraw-Verlauf im `bbb-player`-HANDOFF
  zeigt, was zwei geratene Fixes kosten.
