# Medium Draft Publisher

An AnythingLLM custom agent skill that creates **draft** posts on [Medium](https://medium.com) from a chat prompt, using the Medium API. It can verify your integration token, create a draft (or optionally public/unlisted) post on your profile, or post under a publication. Supports Markdown or HTML content, tags, and a canonical URL.

> 🔐 **Treat your integration token like a password.** It grants the ability to publish on your behalf. Store it only in this skill's settings field (it is never written into the code), and revoke it any time at [medium.com/me/settings](https://medium.com/me/settings).

> ⚠️ **Heads up:** Medium's API is officially deprecated and no longer actively supported. Existing **integration tokens** generally still work for creating posts, but Medium may change or disable this at any time.

## What it does

| Action | Description |
|--------|-------------|
| `me` | Verifies the token and returns the authenticated Medium user (id, username, name, URL) |
| `draft` | Creates a post — **draft by default** — on your profile or under a publication |

## Requirements

- A **Medium integration token**. Generate one at [medium.com/me/settings](https://medium.com/me/settings) under **Integration tokens**, give it a description (e.g. "AnythingLLM"), and copy the value.
- **AnythingLLM** running locally (Desktop app recommended).
- A runtime with global `fetch` (AnythingLLM Desktop's bundled Node/Electron provides this).

## Setup

1. Copy this folder into your AnythingLLM agent-skills directory:
   ```
   plugins/agent-skills/medium-draft-publisher/
   ```
2. Reload the AnythingLLM page — the skill appears in your agent skills.
3. Open the skill's settings and paste your token into the **MEDIUM_API_TOKEN** field, then save.
4. Enable the skill in your agent's tool list.

## Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | string | Yes | `me` or `draft` |
| `title` | string | For `draft` | Post title (used for SEO/listings; include it in `content` too if you want it visible in the body). Titles over 100 chars are ignored by Medium |
| `content` | string | For `draft` | Post body, interpreted per `contentFormat` |
| `contentFormat` | string | No | `markdown` (default) or `html` |
| `tags` | string | No | Comma-separated (`nodejs, javascript`) or an array. Only the first 3 are used; tags over 25 chars are ignored |
| `canonicalUrl` | string | No | Original URL if first published elsewhere |
| `publishStatus` | string | No | `draft` (default), `public`, or `unlisted` |
| `publicationId` | string | No | Create the post under a publication instead of your profile |

## Example prompts

- *"Verify my Medium token and show my account"*
- *"Create a Medium draft titled 'Hello World' with the body 'My first draft.'"*
- *"Draft a Medium post titled 'Async in Node' in markdown tagged nodejs, javascript"*
- *"Save an HTML draft titled 'Release Notes' with a canonical URL to my blog"*

## Output format

All actions return JSON.

Example (`me`):

```json
{
  "action": "me",
  "user": {
    "id": "5303d74c64f66366f00cb9b2a94f3251bf5",
    "username": "majelbstoat",
    "name": "Jamie Talbot",
    "url": "https://medium.com/@majelbstoat",
    "imageUrl": "https://images.medium.com/0*fkfQiTzT7TlUGGyI.png"
  }
}
```

Example (`draft`):

```json
{
  "action": "draft",
  "created": true,
  "post": {
    "id": "e6f36a",
    "title": "Hello World",
    "authorId": "5303d74c64f66366f00cb9b2a94f3251bf5",
    "publicationId": null,
    "publishStatus": "draft",
    "url": "https://medium.com/@majelbstoat/hello-world-e6f36a",
    "tags": [],
    "canonicalUrl": null
  }
}
```

A draft does not have a `publishedAt` date and is only visible to you in your Medium drafts until you publish it from the Medium editor.

## How it works

- The token is read from the skill's `setup_args` (`MEDIUM_API_TOKEN`) at runtime via `this.runtimeArgs` — it is **not** stored in the code.
- For `draft` on your profile, the skill first calls `GET /v1/me` to resolve your author id, then `POST /v1/users/{authorId}/posts`.
- When `publicationId` is supplied, it calls `POST /v1/publications/{publicationId}/posts` directly. (Writers may only create drafts under a publication; editors can use any status.)
- All requests go to `https://api.medium.com/v1` over HTTPS with `Authorization: Bearer <token>`.

## Security & limitations

- **Token safety.** The token is sent only to `api.medium.com` over HTTPS and is never logged or echoed back in responses. Revoke it at any time from your Medium settings.
- **No publishing surprises.** `publishStatus` defaults to `draft`; you must explicitly pass `public` or `unlisted` to publish.
- **Deprecated API.** Functionality depends on Medium continuing to honor integration tokens; this is outside the skill's control.
- **Images.** Medium side-loads images referenced by `<img src="...">` in your content. Local image upload is not implemented by this skill.

## Troubleshooting

| Error | Cause / fix |
|-------|-------------|
| `Medium integration token is not configured` | Paste your token into the skill's MEDIUM_API_TOKEN setting and save |
| `Medium API 401 ...` | Token is invalid or revoked — generate a new one |
| `Medium API 403 ...` | The token lacks permission, or the `publicationId` isn't one you can post to |
| `Global fetch is unavailable` | Your runtime lacks global `fetch`; use a Node 18+ / current Electron runtime |
