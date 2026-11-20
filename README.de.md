<div align="center">

# @omadia/plugin-channel-slack

### Sprich mit deinen omadia-Agenten aus Slack.

Ein signiertes omadia-Plugin, das Slack mit deinem Agenten-Team verbindet. Es leitet DMs und @-Erwähnungen in den Orchestrator und postet die Antwort in derselben Unterhaltung zurück.

[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](LICENSE)
[![Built for omadia](https://img.shields.io/badge/built%20for-omadia-2496ED.svg)](https://github.com/byte5ai/omadia)
[![TypeScript](https://img.shields.io/badge/built%20with-TypeScript-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

[**Haupt-Repo**](https://github.com/byte5ai/omadia) · [**Website**](https://omadia.ai) · [**Plugin-Hub**](https://hub.omadia.ai) · [**Was es kann**](#was-es-kann) · [**Installation**](#installation)

🇬🇧 This guide is also available [in English](./README.md).

</div>

---

omadia ist ein selbst-hostbares agentisches OS: stelle Multi-Agent-Teams aus signierten Plugins zusammen, betreibe sie auf der eigenen Maschine und erhalte für jede Aktion eine nachvollziehbare Spur. Dieses Plugin lässt Menschen diese Agenten direkt aus Slack erreichen. Haupt-Repo: [byte5ai/omadia](https://github.com/byte5ai/omadia).

## Was es kann

Verbindet Slack mit omadia. DMs und @-Erwähnungen werden in den omadia-Orchestrator geleitet, und die Antwort kommt in derselben Unterhaltung zurück.

Es gibt zwei Transports:

- **Events API** über einen öffentlichen HTTPS-Webhook. Empfohlen für die Produktion.
- **Socket Mode** als Fallback, wenn du keinen öffentlichen Host hast.

## So funktioniert es in omadia

Ein Channel-Plugin (`kind: channel`). Der omadia-Kernel aktiviert es aus der `manifest.yaml`, dann empfängt es Slack-Events über den Webhook oder den Socket, leitet jede Nachricht an den Orchestrator-Chat-Agenten weiter und postet die Antwort nach Slack zurück. Du brauchst zuerst einen dem Orchestrator zugewiesenen LLM-Provider, sonst gibt es nichts, womit geantwortet werden kann.

## Installation

1. Installiere über den [Plugin-Hub](https://hub.omadia.ai) in der omadia-Admin-UI (Store, Upload), oder lade das gebaute ZIP direkt hoch.
2. Trage die Setup-Felder unten ein. Für dieses Plugin gibt es keinen API-Key.
3. Weise dem Orchestrator zuerst einen LLM-Provider zu, damit der Chat-Agent ein Modell hat, auf dem er läuft.

## Agenten in Slack

**Ansprechen.** Dieses Plugin betreibt **eine Slack-App pro Installation**: ein Bot-Token, ein Bot-Name, ein Avatar. Der Sprecher zeigt sich deshalb nicht über die Plattform, und mehrere Agenten im selben Slack erreichst du mit dem nativen Befehl **`/agent`**:

- `/agent Mira` wählt Mira für dich in dieser Unterhaltung, `/agent` hebt deine Auswahl auf, `/agents` listet die Agenten, die dir hier zur Verfügung stehen.
- Das Plugin leitet nur den Text weiter (der Resolver des Kernels übergibt den Turn an einen Chat-Agenten, der `/agent`, `/agent Mira` und `/agents` selbst ausführt). Der omadia-Kernel speichert die Auswahl pro Person und Unterhaltung, prüft die Verfügbarkeit und antwortet mit einer kurzen System-Meldung, die nur du siehst (ephemere Nachricht).
- Slack erlaubt keine Slash-Commands in Threads. Schreibe dort `@DeinBot /agent Mira`, das wird genauso behandelt.
- Lege den Befehl in deiner Slack-App an (**Slash Commands**): `/agent`, Request URL `<public_base_url>/api/slack/commands` (Events API) oder keine URL (Socket Mode). Siehe die Setup-Anleitung.

**Eigene Identität pro Agent: von diesem Plugin nicht unterstützt.** Slack selbst kann es: eine Slack-App pro Agent gibt jedem eigenen Namen, Avatar und eine eigene `@Erwähnung`. `chat:write.customize` ändert nur Name und Avatar je Nachricht und ist keine ansprechbare Identität, deshalb wird es nicht benutzt. Eine Plugin-Installation hält genau einen Token-Satz (Bot-Token, Signing Secret bzw. App-Level-Token); App-pro-Agent bräuchte also eine Installation je App, und der Kernel kennt noch keinen Channel-Schlüssel für eine Slack-Bot-Identität, mit dem er so einen Bot an seinen Agenten bindet. Was es dich pro Agent kosten würde: eine Slack-App anlegen und pflegen, ihre Scopes, Request URL bzw. App-Level-Token, im Workspace installieren und in Channels einladen. Bis dahin: `/agent`.

**So sehen Antworten aus.** Wie die Nachricht eines Kollegen: keine Statuszeile, kein Chip, keine Fußzeile, keine Buttons, keine Folgefragen-Liste.

- Ein Agent in der Unterhaltung: keine Namenszeile. Mehrere Agenten: eine schlichte Zeile `Name:`, wo der Sprecher sonst unklar wäre. Die Sprecher-Historie liegt im Speicher; nach einem Neustart wird eine Unterhaltung ab dem zweiten Sprecher wieder als Mehr-Agenten-Unterhaltung erkannt.
- Was ein befragter Kollege beigetragen hat, steht als Klartext (`Mira: ...`).
- Meldungen des Systems (zum Beispiel „dieser Agent ist für dich nicht verfügbar") sind eigener Klartext, nie unter dem Namen eines Agenten.
- Auswahlfragen werden zu einer nummerierten Liste im Text.
- Die KI-Kennzeichnung ist Teil des Antworttextes und folgt der Häufigkeits-Einstellung des Betreibers.
- Es gibt **keine Empfangsbestätigung per Reaktion** mehr (das frühere Augen-Emoji) und keinen Tipp-Indikator: Slack bietet einem Bot außerhalb der KI-Assistenten-Oberfläche keinen. Bei langer Arbeit bestätigt der Agent nach 8 Sekunden einmal („ich kümmere mich darum", unter seinem Namen, wie ihn der Kernel vorab nennt) und antwortet dann. Ein Slash-Command, der seine 30-Minuten-`response_url` überlebt, wird als ephemere Folgenachricht beantwortet.

**Wer fragt.** Der Kernel erfährt den Absender als Principal in der einen Form, die alle Kanäle nutzen (`channelUserPrincipal` des SDK): `user:<E-Mail>`, wenn Slack die E-Mail des Mitglieds liefert (`users.info`, Bot-Scope `users:read.email`; Slack bestätigt Workspace-Adressen), sonst `user:slack-user:<Member-ID, klein>`. Auswahl und Verfügbarkeit hängen daran, und die Personensuche der Conductor-Schritte schreibt dieselbe Form, damit eine Freigabe den Turn der Person trifft. Derselbe `users.info`-Aufruf liefert die Sprache: `de` oder `en` gehen an den Kernel, damit seine Meldungen und die Bestätigung „ich kümmere mich darum" sie sprechen (andere Sprachen: Deutsch). Ohne `users:read.email` gilt die ID-Form; ein fehlgeschlagener Abruf blockiert nie eine Nachricht.

**Wo deine Auswahl liegt.** `/agent` wird für dich und den **Channel** (bzw. die DM) gespeichert, in dem du den Befehl tippst, nie für den ganzen Workspace. Eine Workspace-Bindung beantwortet weiter normale Nachrichten in jedem Channel; `/agent` geht an den Eintrag des Channels, damit deine Wahl in diesem Channel bleibt. Slack kennt keine Auswahl pro Thread: sie gilt pro Channel.

**Absagen.** Antwortet kein Agent auf einen Turn (deaktiviert, gelöscht, für dich nicht verfügbar, niemand angesprochen), bekommst du die `system`-Meldung des Kernels, nie die Antwort eines anderen Agenten. `/agent` funktioniert dann trotzdem, du kannst also einen Agenten wählen. Eine Antwort ohne Sprecher wird zurückgehalten und durch eine kurze System-Meldung ersetzt (fail-closed).

**Proaktive Nachrichten.** Das Plugin meldet dem Kernel einen Direktnachrichten- und einen Konversations-Sende-Provider an (Erinnerungen, Freigaben, Berichte). Sie liefern `system`-Nachrichten über denselben einen Outbox-Weg, können Slack-Mitglieder @erwähnen und nicht „als" ein bestimmter Agent posten (eine Slack-App ist eine Identität). Eine Umfrage oder Fragekarte wird abgelehnt, der Kernel postet sie dann selbst als nummerierte Klartext-Frage und merkt sie sich als offen (der Provider meldet dafür die Slack-`ts` der Nachricht). Du antwortest mit der Nummer, als Antwort im Thread der Frage oder, wenn es die einzige offene Frage ist und du den Bot ansprichst, als Nachricht im Channel bzw. in der DM.

**Nachrichten-Protokoll für den Kernel.** Damit das geht, meldet das Plugin dem Kernel jede menschliche Nachricht in Channel, Thread oder DM (`created`-Ereignisse über `emitConversationMessage`, per Feature-Detection; der Kernel behält sie nur für eine Unterhaltung, die er moderiert, und verwirft den Rest): Unterhaltung = Slack-Channel-ID, `messageId` = `ts`, eine Thread-Antwort trägt die Thread-Wurzel als `replyToMessageId`, eine Erwähnung des Bots setzt `addressedToBot`. Slash-Commands, abgeschaltete DMs und Channels außerhalb der Allowlist werden nicht gemeldet. Das startet für sich keinen Turn; darüber entscheidet weiter die Mention-Regel. Eine Nachricht, die einen Turn starten würde, wird vorher gemeldet (`reportConversationMessage`, wartet höchstens 1,5 s): nimmt der Kernel sie als getippte Antwort auf eine offene Frage, startet kein Turn, der Agent beantwortet also nicht zusätzlich „2". Bei Timeout oder Fehler und auf einem älteren Kernel läuft der Turn wie bisher. Der Kernel kennt den Bot als empfangende Identität unter dem Schlüssel **`slack-bot:<Bot-Member-ID>`** (z. B. `slack-bot:U0ABC123`). Slack hat im Kernel-Kontrakt noch keinen Binding-Key pro Bot; das ist der Schlüssel, mit dem man abonniert (und später `asChannelKey` deklariert).

**Gruppen.** Der Bot liest, wer in einem Channel oder Gruppenchat ist (`conversations.members`), und gibt dem Kernel eine ehrliche Teilnehmerliste (vollständig, teilweise oder unbekannt). Die Zielgruppen-Prüfung des Kernels braucht sie: ohne Liste antwortet ein Agent in einer Gruppe nicht. Ergänze die Bot-Scopes `channels:read`, `groups:read`, `im:read` und `mpim:read`. Ein fehlender Scope erscheint im Log als „Liste unbekannt", nicht als Raten.

## Konfiguration

| Feld | Hinweis |
| --- | --- |
| Bot User OAuth Token (`xoxb-...`) | Pflicht. |
| Public HTTPS Base-URL | Für den Events-API-Transport. |
| Signing Secret | Für den Events-API-Transport. |
| App-Level Token (`xapp-...`) | Nur für Socket Mode. |
| Channel-Verhalten | Wie der Bot in Channels reagiert. |
| DMs erlauben | Lässt den Bot Direktnachrichten beantworten. |
| Allowlist | Optional. |

Nutze für die Produktion den Events-API-Transport. Socket Mode funktioniert ohne öffentlichen Host.

## Aus dem Quellcode bauen

```bash
npm install
npm run build   # tsc, schreibt dist/
npm test        # node:test über esbuild; braucht das gebaute Channel-SDK eines omadia-Checkouts
```

Die Tests bündeln `@omadia/channel-sdk` und `@omadia/plugin-api` aus `../middleware/packages/*/dist` (überschreibbar mit `OMADIA_CHANNEL_SDK_DIST` und `OMADIA_PLUGIN_API_DIST`). `@omadia/plugin-api` stellt der omadia-Host zur Laufzeit bereit (optionale Peer-Dep). Verlinke es aus einem lokalen omadia-Checkout zum Bauen. Aufbau siehe [byte5ai/omadia](https://github.com/byte5ai/omadia).

## Lizenz

[MIT](LICENSE), byte5 GmbH