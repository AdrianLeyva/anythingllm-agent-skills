# Apple Reminders

An AnythingLLM custom agent skill that **reads, creates, edits, and deletes Apple Reminders from the command line** — no UI interaction required. List your reminder lists, read reminders (filtered by list and completion status), add new reminders with notes/due date/priority, edit existing ones, and delete them.

It drives the built-in **Reminders** app through **AppleScript (`osascript`)**. Every user-supplied value (titles, notes, ids, dates) is passed as an `on run argv` argument and is **never interpolated into the script text**, so the engine is immune to AppleScript injection.

> ⚠️ **Editing and deleting reminders changes real data in your Reminders app and syncs through iCloud.** Deletes are not reversible from here. Use the exact `id` (from the `get` action) when you need to target one specific reminder.

## What it does

| Action | Description |
|--------|-------------|
| `lists`  | Lists every reminder list with its reminder count |
| `get`    | Reads reminders, optionally scoped to a `list` and filtered by completion |
| `create` | Adds a reminder (`name`, optional `notes`, `dueDate`, `priority`, `list`) |
| `edit`   | Modifies a reminder (rename, change notes/due/priority, mark complete) |
| `delete` | Removes a reminder |

## Requirements

- **macOS** with the **Reminders** app and `/usr/bin/osascript` (built in). No installation or credentials needed.
- **AnythingLLM** running locally (Desktop app recommended on macOS).
- The first run may trigger a **one-time macOS Automation permission prompt** granting the host app access to "Reminders". Approve it (System Settings → Privacy & Security → Automation / Reminders), otherwise the OS blocks the script.

## Setup

1. Copy this folder into your AnythingLLM agent-skills directory:
   ```
   plugins/agent-skills/apple-reminders/
   ```
2. Reload the AnythingLLM page — the skill appears automatically (no setup args needed).
3. Enable the skill in your agent's tool list.

## Parameters

| Parameter | Type | Used by | Description |
|-----------|------|---------|-------------|
| `action` | string | all | One of `lists`, `get`, `create`, `edit`, `delete` |
| `list` | string | get / create / edit / delete | Reminder list name. Scopes reads, picks the destination on create, and helps locate the target on edit/delete |
| `name` | string | create / edit / delete | Reminder title. Required for `create`; identifies the target on edit/delete (ignored when `id` is set) |
| `id` | string | edit / delete | Exact reminder id (from `get`). The most reliable way to target one reminder |
| `notes` | string | create / edit | Notes/body text. On `edit`, empty means *leave unchanged* |
| `dueDate` | string | create / edit | `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM` (24-hour, local). No time → 09:00 local. Removing an existing due date isn't supported by the Reminders API — you can only set a new one |
| `priority` | string | create / edit | `none`, `low`, `medium`, or `high`. On `edit`, empty means *leave unchanged* |
| `completed` | string | get / edit | `true`/`false`. Filters reads; marks complete/incomplete on edit |
| `newName` | string | edit | New title when renaming |
| `scope` | string | get | `incomplete` (default), `completed`, or `all` |
| `limit` | string | get | Max reminders to return (omit/`0` = no limit) |

## Example prompts

- *"Show me my reminder lists"*
- *"What's on my Groceries list?"*
- *"Add 'Buy milk' to Groceries, due tomorrow at 5pm, high priority"*
- *"Mark 'Buy milk' on Groceries as done"*
- *"Rename 'Buy milk' to 'Buy oat milk' and add a note"*
- *"Delete the 'Buy oat milk' reminder from Groceries"*

> ℹ️ Relative dates like *"tomorrow"* are resolved by the agent into an ISO `dueDate` before the skill runs.

## Output

Each action returns JSON. `get` returns an array of reminders, each with:

```json
{
  "id": "x-apple-reminder://...",
  "name": "Buy milk",
  "notes": "barista edition",
  "completed": false,
  "dueDate": "2026-06-23T17:00:00",
  "priority": "high",
  "flagged": false,
  "list": "Groceries"
}
```

Use the returned `id` with `edit`/`delete` for unambiguous targeting.

## How it works

- All commands run via `spawn` with **no shell**, passing arguments as an array — immune to command injection.
- AppleScript receives user values through `on run argv`, so titles/notes/dates are **never concatenated into script source**.
- Dates are decomposed into year/month/day/hour/minute/second components in JS and rebuilt inside AppleScript, avoiding locale-dependent date parsing.
- Reminder rows are serialized with ASCII unit/record separators (`\u001F` / `\u001E`) and parsed back in JS.

## Security & notes

- Inputs are validated to reject null bytes and the separator control characters.
- Targeting by `name` operates on the **first** matching reminder; pass `id` (or a `list`) to disambiguate when titles repeat.
- Priority maps to Reminders/EventKit integers: `high`=1, `medium`=5, `low`=9, `none`=0.
- Removing an existing due date is **not supported** by the Reminders AppleScript API; you can only set a new due date.
- **Performance:** `get` reads each property in bulk per list, so reading one list is quick. Reading **all** lists (`get` with no `list`) on a very large library (hundreds of reminders) can take a while — scope to a `list` when possible.
- A friendly error is returned if macOS automation permission is missing or the list/reminder can't be found.
