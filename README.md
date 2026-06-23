# AnythingLLM Agent Skills

A collection of [AnythingLLM](https://anythingllm.com) **custom agent skills** that let your agent drive real macOS apps, the network stack, and external APIs straight from chat — no UI interaction required. Each skill is a self-contained plugin (`handler.js` + `plugin.json`) built with **no shell** and argument-safe execution, so user-supplied values can't trigger command or script injection.

## Skills

| Skill | What it does | Requirements |
|-------|--------------|--------------|
| [Apple Reminders](apple-reminders/README.md) | Read, create, edit, and delete Apple Reminders via AppleScript (`osascript`) | macOS + Reminders app |
| [Apple Shortcuts Runner](apple-shortcuts-runner/README.md) | List, search, and run macOS Apple Shortcuts with optional input/output | macOS 12+ + Shortcuts app |
| [Medium Draft Publisher](medium-draft-publisher/README.md) | Create draft (or public/unlisted) posts on Medium via the Medium API | Medium integration token |
| [Network Sniffer](network-sniffer/README.md) | Chat-driven packet capture and analysis built on the Wireshark CLI (`tshark`) | macOS + `tshark` (Wireshark) |

> Most skills target macOS. **Medium Draft Publisher** is platform-independent (it only calls the Medium API).

## Skill details

### [Apple Reminders](apple-reminders/README.md)
Manage Apple Reminders entirely from the command line: list your reminder lists, read reminders (filtered by list/completion), add new ones with notes/due date/priority, edit existing ones, and delete them. Values are passed as `on run argv` arguments, so the engine is immune to AppleScript injection. → [Read more](apple-reminders/README.md)

### [Apple Shortcuts Runner](apple-shortcuts-runner/README.md)
Find and trigger macOS Apple Shortcuts. Lists installed shortcuts, searches by name, and runs any shortcut by name with optional text/file input and captured output. Uses the built-in `shortcuts` CLI with an automatic AppleScript and URL-scheme fallback. → [Read more](apple-shortcuts-runner/README.md)

### [Medium Draft Publisher](medium-draft-publisher/README.md)
Create **draft** posts on Medium from a prompt. Verifies your integration token, creates a draft (or optionally public/unlisted) post on your profile or under a publication, and supports Markdown/HTML, tags, and a canonical URL. → [Read more](medium-draft-publisher/README.md)

### [Network Sniffer](network-sniffer/README.md)
Turn `tshark` into a chat-driven sniffer/analyzer: list interfaces, capture live traffic, filter by IP/domain, scan the network, extract domains, search payloads, surface TLS/cert intel, run threat-detection and PII/secrets scans, follow streams, carve files, match against IOCs, and analyze existing pcaps. **Authorized, passive use only.** → [Read more](network-sniffer/README.md)

## Installation

Each skill installs the same way. Copy the skill folder into your AnythingLLM agent-skills directory:

```
plugins/agent-skills/<skill-name>/
```

Then reload the AnythingLLM page, configure any required settings (e.g. the Medium token), and enable the skill in your agent's tool list. See each skill's README for full setup and parameters.

## Project layout

```
agent_skills/
├── apple-reminders/          # Read/create/edit/delete Apple Reminders
│   ├── handler.js
│   ├── plugin.json
│   └── README.md
├── apple-shortcuts-runner/   # List/search/run Apple Shortcuts
│   ├── handler.js
│   ├── plugin.json
│   └── README.md
├── medium-draft-publisher/   # Create Medium drafts via the Medium API
│   ├── handler.js
│   ├── plugin.json
│   └── README.md
└── network-sniffer/          # Packet capture & analysis via tshark
    ├── handler.js
    ├── plugin.json
    └── README.md
```

Every skill follows the AnythingLLM `skill-1.0.0` schema: `plugin.json` declares the skill's name, description, parameters, and examples, while `handler.js` implements the `runtime.handler`.

## Security

These skills are built defensively:

- **No shell.** Commands run via `spawn` with `shell: false`, passing arguments as an array — immune to command injection.
- **No script interpolation.** AppleScript-based skills pass user values as `on run argv` arguments rather than concatenating them into script source.
- **Input validation.** User input is validated to reject null bytes and control characters.
- **Secret handling.** API tokens are read from skill settings at runtime, never hard-coded, logged, or echoed back.

Use the **Network Sniffer** only on networks and devices you own or have explicit written permission to monitor.

## License

MIT — see each skill's `plugin.json` for license metadata.
