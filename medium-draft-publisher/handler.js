// handler.js
// Medium Draft Publisher — AnythingLLM Custom Agent Skill
//
// Creates draft posts on Medium using the Medium API
// (https://github.com/Medium/medium-api-docs). Two actions:
//   - "me":    verify the integration token and return the authenticated user.
//   - "draft": create a post (draft by default) on the user's profile, or
//              under a publication when "publicationId" is supplied.
//
// The Medium integration token is read from the skill's setup args
// (MEDIUM_API_TOKEN) and is NEVER hardcoded. Generate a token at
// https://medium.com/me/settings under "Integration tokens" and paste it into
// this skill's configuration in AnythingLLM. Treat it like a password.

const API_BASE = "https://api.medium.com/v1";

const VALID_FORMATS = ["markdown", "html"];
const VALID_STATUSES = ["draft", "public", "unlisted"];

module.exports.runtime = {
  handler: async function (args) {
    const params = args || {};
    const callerId = `${this.config.name}-v${this.config.version}`;
    const act = (params.action || "").toLowerCase().trim();

    try {
      const token = this._getToken();

      switch (act) {
        case "me":
          return await this._me(callerId, token);
        case "draft":
        case "create":
        case "post":
          return await this._draft(callerId, token, params);
        default:
          return (
            `Error: Unknown action "${params.action}". Supported actions: ` +
            "me, draft."
          );
      }
    } catch (e) {
      this.introspect(`${callerId}: Failed — ${e.message}`);
      this.logger(`${callerId} error: ${e.message}`);

      if (e.code === "ENOTOKEN") {
        return JSON.stringify(
          {
            error: "Medium integration token is not configured.",
            fix:
              "Open this skill's settings in AnythingLLM and paste your Medium " +
              "integration token into the MEDIUM_API_TOKEN field.",
            getToken:
              "Generate one at https://medium.com/me/settings under 'Integration tokens'.",
          },
          null,
          2
        );
      }

      return `Medium Draft Publisher error: ${e.message}`;
    }
  },

  // ── Actions ────────────────────────────────────────────────────────────────

  async _me(callerId, token) {
    this.introspect(`${callerId}: Verifying token and fetching account (GET /me)...`);
    const user = await this._fetchUser(token);
    return JSON.stringify({ action: "me", user }, null, 2);
  },

  async _draft(callerId, token, params) {
    const title = (params.title || "").trim();
    const content = params.content != null ? String(params.content) : "";

    if (!title) {
      return 'Error: "title" is required for action "draft".';
    }
    if (!content.trim()) {
      return 'Error: "content" is required for action "draft".';
    }

    const contentFormat = this._resolveFormat(params.contentFormat);
    const publishStatus = this._resolveStatus(params.publishStatus);
    const tags = this._resolveTags(params.tags);
    const canonicalUrl = (params.canonicalUrl || "").trim();
    const publicationId = (params.publicationId || "").trim();

    const body = {
      title,
      contentFormat,
      content,
      publishStatus,
    };
    if (tags.length) body.tags = tags;
    if (canonicalUrl) body.canonicalUrl = canonicalUrl;

    let endpoint;
    if (publicationId) {
      endpoint = `${API_BASE}/publications/${encodeURIComponent(publicationId)}/posts`;
      this.introspect(
        `${callerId}: Creating ${publishStatus} post "${title}" under publication ${publicationId}...`
      );
    } else {
      this.introspect(`${callerId}: Resolving author id (GET /me)...`);
      const user = await this._fetchUser(token);
      endpoint = `${API_BASE}/users/${encodeURIComponent(user.id)}/posts`;
      this.introspect(
        `${callerId}: Creating ${publishStatus} post "${title}" on ${user.username || user.id}'s profile...`
      );
    }

    const res = await this._request(endpoint, {
      method: "POST",
      token,
      body,
    });

    const post = (res && res.data) || {};
    return JSON.stringify(
      {
        action: "draft",
        created: true,
        post: {
          id: post.id || null,
          title: post.title || title,
          authorId: post.authorId || null,
          publicationId: post.publicationId || publicationId || null,
          publishStatus: post.publishStatus || publishStatus,
          url: post.url || null,
          tags: post.tags || tags,
          canonicalUrl: post.canonicalUrl || canonicalUrl || null,
        },
      },
      null,
      2
    );
  },

  // ── Helpers ──────────────────────────────────────────────────────────────

  _getToken() {
    const token =
      (this.runtimeArgs && this.runtimeArgs.MEDIUM_API_TOKEN) || "";
    const trimmed = String(token).trim();
    if (!trimmed) {
      const err = new Error("Missing Medium API token.");
      err.code = "ENOTOKEN";
      throw err;
    }
    return trimmed;
  },

  _resolveFormat(value) {
    const f = (value || "").toLowerCase().trim();
    return VALID_FORMATS.includes(f) ? f : "markdown";
  },

  _resolveStatus(value) {
    const s = (value || "").toLowerCase().trim();
    return VALID_STATUSES.includes(s) ? s : "draft";
  },

  _resolveTags(value) {
    if (!value) return [];
    let list;
    if (Array.isArray(value)) {
      list = value;
    } else {
      list = String(value).split(",");
    }
    return list
      .map(t => String(t).trim())
      .filter(Boolean)
      .slice(0, 3);
  },

  async _fetchUser(token) {
    const res = await this._request(`${API_BASE}/me`, { method: "GET", token });
    const user = res && res.data;
    if (!user || !user.id) {
      throw new Error("Medium did not return a user id for this token.");
    }
    return user;
  },

  async _request(url, { method, token, body }) {
    if (typeof fetch !== "function") {
      throw new Error(
        "Global fetch is unavailable in this runtime; cannot reach the Medium API."
      );
    }

    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Accept-Charset": "utf-8",
    };
    const init = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    let response;
    try {
      response = await fetch(url, init);
    } catch (e) {
      throw new Error(`Network request to Medium failed: ${e.message}`);
    }

    const text = await response.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch (_) {
        parsed = null;
      }
    }

    if (!response.ok) {
      const apiMsg =
        parsed && parsed.errors && parsed.errors[0] && parsed.errors[0].message;
      const detail = apiMsg || (text ? text.slice(0, 300) : "no response body");
      throw new Error(`Medium API ${response.status} ${response.statusText}: ${detail}`);
    }

    return parsed;
  },
};
