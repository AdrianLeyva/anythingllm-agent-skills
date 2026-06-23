# Apple Shortcuts Runner

An AnythingLLM custom agent skill that **finds and triggers macOS Apple Shortcuts from the command line** — no UI interaction required. List your installed shortcuts, search them by name, and run any shortcut by name with optional text/file input and captured output.

It uses the built-in **`shortcuts` CLI** (macOS 12 Monterey+) to list/search shortcuts, and runs them through **AppleScript (`osascript`)** in your interactive session. If a shortcut can't run in that context, it automatically falls back to the **Shortcuts app URL scheme** (`open`). Every response includes an `engine` field (`"cli"`, `"applescript"`, or `"url"`) so you know which path ran.

> ⚠️ **Shortcuts can perform real, irreversible actions** (send messages, change settings, control devices/HomeKit, delete files). Only run shortcuts you trust. The AppleScript fallback may trigger a **one-time macOS Automation permission prompt** the first time it controls the Shortcuts app.

## What it does

| Action | Description |
|--------|-------------|
| `list` | Lists every installed shortcut by name |
| `find` | Filters shortcuts whose name contains a case-insensitive substring (`query`) |
| `run`  | Triggers a shortcut by exact `name`, with optional input and captured output |

If `run` is given a name that doesn't exist, it returns **close-matching suggestions** instead of running anything.

## Requirements

- **macOS 12 (Monterey) or later** with the **Shortcuts** app.
- The primary engine is the built-in `/usr/bin/shortcuts` CLI. If it's missing, the skill falls back to AppleScript via `/usr/bin/osascript`. No installation or credentials needed.
- **AnythingLLM** running locally (Desktop app recommended on macOS).

## Setup

1. Copy this folder into your AnythingLLM agent-skills directory:
   ```
   plugins/agent-skills/apple-shortcuts-runner/
   ```
2. Reload the AnythingLLM page — the skill appears automatically (no setup args needed).
3. Enable the skill in your agent's tool list.

## Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | string | Yes | One of `list`, `find`, `run` |
| `name` | string | For `run` | Exact name of the shortcut to run |
| `query` | string | For `find` | Case-insensitive substring matched against shortcut names |
| `input` | string | No | Text passed as input to the shortcut (`run`) |
| `inputPath` | string | No | Path to a file passed as input (`run`, CLI engine only). Takes precedence over `input` |
| `outputPath` | string | No | Path to write the shortcut's output to (`run`). If omitted, output is returned inline |

### Engine differences

- **`list` / `find`** use the `shortcuts` CLI (falling back to AppleScript if the CLI is unavailable).
- **`run` uses AppleScript (`osascript`)** as the primary engine — it executes the shortcut in your interactive login session and returns its output inline (text `input` and file `inputPath` are supported; it also writes to `outputPath` if given).
- **URL-scheme fallback (`engine: "url"`)** — if `osascript` can't run the shortcut (e.g. an action reports *"a required app is missing"*, common with **HomeKit / Home** "Control device" actions), the skill automatically retries by handing the shortcut to the Shortcuts app via its `shortcuts://run-shortcut` URL scheme (`open -g`). Trade-off: **this engine cannot capture the shortcut's output**, and file input is not supported (text `input` is passed along).

> ℹ️ A shortcut whose action depends on an app that is **only installed on your iPhone/iPad** cannot be executed from the Mac by any method — the providing app must exist on the machine that runs it.

## Example prompts

- *"List my Apple Shortcuts"*
- *"Find shortcuts with 'note' in the name"*
- *"Run the shortcut called 'Good Morning'"*
- *"Run the 'Add to Inbox' shortcut with the input 'Buy milk'"*
- *"Run 'Resize Image' on the file at /tmp/photo.jpg and save the result to /tmp/out.jpg"*

## How it works

- All commands are executed with `spawn` and **no shell**, passing arguments as an array — immune to command injection.
- The AppleScript fallback passes the shortcut name and input as `on run argv` arguments, so user values are **never interpolated into the script text**.
- Inline text input is written to a temp file under `os.tmpdir()/anythingllm-shortcuts/` and cleaned up after the run; output is captured to a temp file (or your `outputPath`) and read back.

## Security & notes

- Shortcut names and paths are validated to reject control characters and null bytes.
- This skill **runs existing** shortcuts only — it does not create, edit, or sign them.
- Output is truncated to ~6000 characters in responses; use `outputPath` to keep the full result on disk.
