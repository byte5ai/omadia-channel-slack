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
npm test        # prüft manifest.yaml gegen die Core-Invarianten
```

`@omadia/plugin-api` stellt der omadia-Host zur Laufzeit bereit (optionale Peer-Dep). Verlinke es aus einem lokalen omadia-Checkout zum Bauen. Aufbau siehe [byte5ai/omadia](https://github.com/byte5ai/omadia).

## Lizenz

[MIT](LICENSE), byte5 GmbH