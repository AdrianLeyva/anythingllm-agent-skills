// handler.js
// Apple Reminders — AnythingLLM Custom Agent Skill
//
// Reads, creates, edits, and deletes Apple Reminders on macOS entirely from the
// command line — no UI interaction. Five actions:
//   - "lists":  list every reminder list (with reminder counts).
//   - "get":    read reminders, optionally scoped to a list and filtered by
//               completion status.
//   - "create": add a new reminder (title, notes, due date, priority, list).
//   - "edit":   modify an existing reminder (rename, change notes/due/priority,
//               mark complete/incomplete).
//   - "delete": remove a reminder.
//
// The engine is AppleScript via `osascript`, talking to the built-in Reminders
// app. ALL user-supplied values (titles, notes, ids, dates) are passed as
// `on run argv` arguments and are NEVER interpolated into the script text, so
// the engine is immune to AppleScript injection.
//
// PERMISSIONS: the first run may trigger a one-time macOS prompt granting the
// host app (e.g. AnythingLLM Desktop) automation access to "Reminders". Without
// it, the OS blocks the script and this skill returns a permission error.

const os = require("os");
const path = require("path");
const fs = require("fs");

// macOS GUI apps (like AnythingLLM Desktop) are launched without the user's
// shell PATH. We search these directories to resolve the absolute osascript
// path and also inject them into the child process PATH.
const BIN_DIRS = [
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
  "/opt/homebrew/bin",
  "/usr/local/bin",
];

// Field/record separators used to serialize AppleScript output for parsing in
// JS. These ASCII control characters won't appear in normal reminder text.
const FS = "\u001F"; // unit separator (field)
const RS = "\u001E"; // record separator (reminder)

// Reminders/EventKit priority integers.
const PRIORITY_TO_INT = { none: 0, low: 9, medium: 5, high: 1 };

module.exports.runtime = {
  handler: async function (args) {
    const params = args || {};
    const callerId = `${this.config.name}-v${this.config.version}`;
    const act = (params.action || "").toLowerCase().trim();

    try {
      switch (act) {
        case "lists":
        case "list-lists":
          return await this._lists(callerId);
        case "get":
        case "list":
        case "read":
          return await this._get(callerId, params);
        case "create":
        case "add":
        case "new":
          return await this._create(callerId, params);
        case "edit":
        case "update":
          return await this._edit(callerId, params);
        case "delete":
        case "remove":
          return await this._delete(callerId, params);
        default:
          return (
            `Error: Unknown action "${params.action}". Supported actions: ` +
            "lists, get, create, edit, delete."
          );
      }
    } catch (e) {
      this.introspect(`${callerId}: Failed — ${e.message}`);
      this.logger(`${callerId} error: ${e.message}`);

      if (this._isMissingBinary(e)) {
        return JSON.stringify(
          {
            error: "Could not find 'osascript' to control the Reminders app.",
            fix: "This skill requires macOS with AppleScript (osascript) available at /usr/bin/osascript.",
          },
          null,
          2
        );
      }

      const friendly = this._friendlyError(e.message);
      if (friendly) return JSON.stringify(friendly, null, 2);

      return `Apple Reminders error: ${e.message}`;
    }
  },

  // ── Actions ────────────────────────────────────────────────────────────────

  async _lists(callerId) {
    this.introspect(`${callerId}: Listing reminder lists...`);
    const script =
      'tell application "Reminders"\n' +
      "  set out to \"\"\n" +
      "  repeat with l in lists\n" +
      `    set out to out & (name of l) & "${FS}" & (count of reminders of l) & "${RS}"\n` +
      "  end repeat\n" +
      "  return out\n" +
      "end tell\n";

    const { stdout } = await this._runOsa(script, []);
    const lists = this._splitRecords(stdout).map(rec => {
      const [name, count] = rec.split(FS);
      return { name, count: Number(count) || 0 };
    });

    return JSON.stringify(
      { action: "lists", lists, count: lists.length },
      null,
      2
    );
  },

  async _get(callerId, params) {
    const list = this._clean(params.list);
    const limit = this._toInt(params.limit, 0);

    // `completed` (true/false) takes precedence over `scope` when set.
    let scope = (this._clean(params.scope) || "incomplete").toLowerCase();
    const comp = this._toBool(params.completed);
    if (comp === true) scope = "completed";
    else if (comp === false && !this._clean(params.scope)) scope = "incomplete";
    if (!["all", "incomplete", "completed"].includes(scope)) scope = "incomplete";

    this.introspect(
      `${callerId}: Getting ${scope} reminders${list ? ` from "${list}"` : ""}...`
    );

    const script =
      "on isoDate(d)\n" +
      "  if d is missing value then return \"\"\n" +
      "  set y to (year of d) as integer\n" +
      "  set mo to (month of d) as integer\n" +
      "  set dd to (day of d) as integer\n" +
      "  set hh to (hours of d) as integer\n" +
      "  set mi to (minutes of d) as integer\n" +
      "  set se to (seconds of d) as integer\n" +
      '  return (my pad(y, 4)) & "-" & (my pad(mo, 2)) & "-" & (my pad(dd, 2)) & "T" & (my pad(hh, 2)) & ":" & (my pad(mi, 2)) & ":" & (my pad(se, 2))\n' +
      "end isoDate\n\n" +
      "on pad(n, w)\n" +
      "  set s to n as text\n" +
      "  repeat while (length of s) < w\n" +
      '    set s to "0" & s\n' +
      "  end repeat\n" +
      "  return s\n" +
      "end pad\n\n" +
      "on run argv\n" +
      "  set listName to item 1 of argv\n" +
      "  set scopeFlag to item 2 of argv\n" +
      "  set maxN to (item 3 of argv) as integer\n" +
      '  set out to ""\n' +
      "  set cnt to 0\n" +
      '  tell application "Reminders"\n' +
      '    if listName is "" then\n' +
      "      set theLists to lists\n" +
      "    else\n" +
      "      set theLists to {list listName}\n" +
      "    end if\n" +
      "    repeat with l in theLists\n" +
      "      set lname to name of l\n" +
      // Bulk-fetch each property as a list (one Apple Event per property per
      // list) instead of per-reminder round-trips — dramatically faster. The
      // specifier `X of reminders of l` must be used directly; assigning the
      // collection to a variable first collapses it into a plain list.
      "      set rids to id of reminders of l\n" +
      "      set n to count of rids\n" +
      "      if n > 0 then\n" +
      "        set rnames to name of reminders of l\n" +
      "        set rdone to completed of reminders of l\n" +
      "        set rdue to due date of reminders of l\n" +
      "        set rprio to priority of reminders of l\n" +
      "        set rbodies to {}\n" +
      "        try\n" +
      "          set rbodies to body of reminders of l\n" +
      "        end try\n" +
      "        set rflags to {}\n" +
      "        try\n" +
      "          set rflags to flagged of reminders of l\n" +
      "        end try\n" +
      "        repeat with i from 1 to n\n" +
      "          set isDone to item i of rdone\n" +
      '          set keepIt to (scopeFlag is "all") or (scopeFlag is "completed" and isDone) or (scopeFlag is "incomplete" and (not isDone))\n' +
      "          if keepIt then\n" +
      "            set dval to item i of rdue\n" +
      "            if dval is missing value then\n" +
      '              set dueStr to ""\n' +
      "            else\n" +
      "              set dueStr to my isoDate(dval)\n" +
      "            end if\n" +
      '            set bd to ""\n' +
      "            try\n" +
      "              set bdRaw to item i of rbodies\n" +
      "              if bdRaw is not missing value then set bd to bdRaw\n" +
      "            end try\n" +
      "            set fl to false\n" +
      "            try\n" +
      "              set flRaw to item i of rflags\n" +
      "              if flRaw is not missing value then set fl to flRaw\n" +
      "            end try\n" +
      `            set out to out & (item i of rids) & "${FS}" & (item i of rnames) & "${FS}" & bd & "${FS}" & (isDone as text) & "${FS}" & dueStr & "${FS}" & ((item i of rprio) as text) & "${FS}" & (fl as text) & "${FS}" & lname & "${RS}"\n` +
      "            set cnt to cnt + 1\n" +
      "            if maxN > 0 and cnt is greater than or equal to maxN then exit repeat\n" +
      "          end if\n" +
      "        end repeat\n" +
      "      end if\n" +
      "      if maxN > 0 and cnt is greater than or equal to maxN then exit repeat\n" +
      "    end repeat\n" +
      "  end tell\n" +
      "  return out\n" +
      "end run\n";

    const { stdout } = await this._runOsa(script, [list, scope, String(limit)]);
    const reminders = this._splitRecords(stdout).map(rec => {
      const f = rec.split(FS);
      return {
        id: f[0] || null,
        name: f[1] || "",
        notes: f[2] || "",
        completed: f[3] === "true",
        dueDate: f[4] || null,
        priority: this._intToPriority(f[5]),
        flagged: f[6] === "true",
        list: f[7] || null,
      };
    });

    return JSON.stringify(
      {
        action: "get",
        list: list || "(all lists)",
        scope,
        reminders,
        count: reminders.length,
      },
      null,
      2
    );
  },

  async _create(callerId, params) {
    const list = this._clean(params.list);
    const name = this._clean(params.name);
    const notes = params.notes != null ? String(params.notes) : "";
    if (!name) return 'Error: "name" (reminder title) is required for action "create".';

    const prio = this._resolvePriority(params.priority);
    const due = this._resolveDueDate(params.dueDate);
    if (due.error) return `Error: ${due.error}`;

    const argv = [
      list,
      name,
      notes,
      prio.set ? "1" : "0",
      String(prio.value),
      due.set ? "1" : "0",
      ...due.components, // year month day hour minute second (or six "0"s)
    ];

    const script =
      "on buildDate(argv, i)\n" +
      "  set d to current date\n" +
      "  set day of d to 1\n" +
      "  set year of d to (item i of argv as integer)\n" +
      "  set month of d to (item (i + 1) of argv as integer)\n" +
      "  set day of d to (item (i + 2) of argv as integer)\n" +
      "  set hours of d to (item (i + 3) of argv as integer)\n" +
      "  set minutes of d to (item (i + 4) of argv as integer)\n" +
      "  set seconds of d to (item (i + 5) of argv as integer)\n" +
      "  return d\n" +
      "end buildDate\n\n" +
      "on run argv\n" +
      "  set listName to item 1 of argv\n" +
      '  tell application "Reminders"\n' +
      "    set props to {name:(item 2 of argv)}\n" +
      '    if (item 3 of argv) is not "" then set props to props & {body:(item 3 of argv)}\n' +
      '    if (item 4 of argv) is "1" then set props to props & {priority:((item 5 of argv) as integer)}\n' +
      '    if (item 6 of argv) is "1" then set props to props & {due date:(my buildDate(argv, 7))}\n' +
      '    if listName is "" then\n' +
      "      set newR to make new reminder with properties props\n" +
      "    else\n" +
      "      tell list listName\n" +
      "        set newR to make new reminder with properties props\n" +
      "      end tell\n" +
      "    end if\n" +
      "    return id of newR\n" +
      "  end tell\n" +
      "end run\n";

    this.introspect(
      `${callerId}: Creating reminder "${name}"${list ? ` in "${list}"` : ""}...`
    );
    const { stdout } = await this._runOsa(script, argv);

    return JSON.stringify(
      {
        action: "create",
        created: true,
        reminder: {
          id: stdout.trim() || null,
          name,
          list: list || "(default list)",
          notes: notes || null,
          dueDate: due.set ? due.iso : null,
          priority: prio.set ? this._intToPriority(prio.value) : "none",
        },
      },
      null,
      2
    );
  },

  async _edit(callerId, params) {
    const id = this._clean(params.id);
    const list = this._clean(params.list);
    const name = this._clean(params.name);
    if (!id && !name) {
      return 'Error: provide "id" (preferred) or "name" to identify the reminder to edit.';
    }

    const newName = this._clean(params.newName);
    const changeBody = params.notes != null && String(params.notes).trim() !== "";
    const newBody = changeBody ? String(params.notes) : "";

    const prio = this._resolvePriority(params.priority);

    // dueDate: empty = no change, otherwise set a new due date.
    let dueMode = "0"; // 0 = no change, 1 = set
    let dueComponents = ["0", "0", "0", "0", "0", "0"];
    let dueIso = null;
    const rawDue = this._clean(params.dueDate);
    if (rawDue) {
      if (/^(clear|none|remove)$/i.test(rawDue)) {
        return (
          'Error: clearing a due date is not supported by the Reminders ' +
          "AppleScript API. Set a new due date instead."
        );
      }
      const due = this._resolveDueDate(rawDue);
      if (due.error) return `Error: ${due.error}`;
      dueMode = "1";
      dueComponents = due.components;
      dueIso = due.iso;
    }

    const comp = this._toBool(params.completed);
    const changeCompleted = comp === true || comp === false;

    const argv = [
      id,
      list,
      name,
      newName ? "1" : "0",
      newName,
      changeBody ? "1" : "0",
      newBody,
      prio.set ? "1" : "0",
      String(prio.value),
      dueMode,
      ...dueComponents,
      changeCompleted ? "1" : "0",
      comp === true ? "1" : "0",
    ];

    const script =
      "on buildDate(argv, i)\n" +
      "  set d to current date\n" +
      "  set day of d to 1\n" +
      "  set year of d to (item i of argv as integer)\n" +
      "  set month of d to (item (i + 1) of argv as integer)\n" +
      "  set day of d to (item (i + 2) of argv as integer)\n" +
      "  set hours of d to (item (i + 3) of argv as integer)\n" +
      "  set minutes of d to (item (i + 4) of argv as integer)\n" +
      "  set seconds of d to (item (i + 5) of argv as integer)\n" +
      "  return d\n" +
      "end buildDate\n\n" +
      "on run argv\n" +
      "  set targetId to item 1 of argv\n" +
      "  set listName to item 2 of argv\n" +
      "  set targetName to item 3 of argv\n" +
      '  tell application "Reminders"\n' +
      "    with timeout of 300 seconds\n" +
      '      if targetId is not "" then\n' +
      "        set theR to reminder id targetId\n" +
      '      else if listName is not "" then\n' +
      "        set matches to (reminders of list listName whose name is targetName)\n" +
      '        if (count of matches) is 0 then error "No matching reminder found." number -1719\n' +
      "        set theR to item 1 of matches\n" +
      "      else\n" +
      "        set theR to missing value\n" +
      "        repeat with l in lists\n" +
      "          set matches to (reminders of l whose name is targetName)\n" +
      "          if (count of matches) > 0 then\n" +
      "            set theR to item 1 of matches\n" +
      "            exit repeat\n" +
      "          end if\n" +
      "        end repeat\n" +
      '        if theR is missing value then error "No matching reminder found." number -1719\n' +
      "      end if\n" +
      '      if (item 4 of argv) is "1" then set name of theR to (item 5 of argv)\n' +
      '      if (item 6 of argv) is "1" then set body of theR to (item 7 of argv)\n' +
      '      if (item 8 of argv) is "1" then set priority of theR to ((item 9 of argv) as integer)\n' +
      "      set dueMode to item 10 of argv\n" +
      '      if dueMode is "1" then\n' +
      "        set due date of theR to my buildDate(argv, 11)\n" +
      "      end if\n" +
      '      if (item 17 of argv) is "1" then set completed of theR to ((item 18 of argv) is "1")\n' +
      `      return (id of theR) & "${FS}" & (name of theR)\n` +
      "    end timeout\n" +
      "  end tell\n" +
      "end run\n";

    this.introspect(
      `${callerId}: Editing reminder ${id ? `id ${id}` : `"${name}"`}...`
    );
    const { stdout } = await this._runOsa(script, argv);
    const [rid, rname] = stdout.split(FS);

    return JSON.stringify(
      {
        action: "edit",
        edited: true,
        reminder: {
          id: (rid || "").trim() || null,
          name: (rname || "").trim() || newName || name,
        },
        changes: {
          renamedTo: newName || null,
          notesUpdated: changeBody,
          priority: prio.set ? this._intToPriority(prio.value) : null,
          dueDate: dueMode === "1" ? dueIso : null,
          completed: changeCompleted ? comp : null,
        },
      },
      null,
      2
    );
  },

  async _delete(callerId, params) {
    const id = this._clean(params.id);
    const list = this._clean(params.list);
    const name = this._clean(params.name);
    if (!id && !name) {
      return 'Error: provide "id" (preferred) or "name" to identify the reminder to delete.';
    }

    const script =
      "on run argv\n" +
      "  set targetId to item 1 of argv\n" +
      "  set listName to item 2 of argv\n" +
      "  set targetName to item 3 of argv\n" +
      '  tell application "Reminders"\n' +
      "    with timeout of 300 seconds\n" +
      '      if targetId is not "" then\n' +
      "        set theR to reminder id targetId\n" +
      '      else if listName is not "" then\n' +
      "        set matches to (reminders of list listName whose name is targetName)\n" +
      '        if (count of matches) is 0 then error "No matching reminder found." number -1719\n' +
      "        set theR to item 1 of matches\n" +
      "      else\n" +
      "        set theR to missing value\n" +
      "        repeat with l in lists\n" +
      "          set matches to (reminders of l whose name is targetName)\n" +
      "          if (count of matches) > 0 then\n" +
      "            set theR to item 1 of matches\n" +
      "            exit repeat\n" +
      "          end if\n" +
      "        end repeat\n" +
      '        if theR is missing value then error "No matching reminder found." number -1719\n' +
      "      end if\n" +
      "      set rid to id of theR\n" +
      "      set rname to name of theR\n" +
      "      delete theR\n" +
      `      return rid & "${FS}" & rname\n` +
      "    end timeout\n" +
      "  end tell\n" +
      "end run\n";

    this.introspect(
      `${callerId}: Deleting reminder ${id ? `id ${id}` : `"${name}"`}...`
    );
    const { stdout } = await this._runOsa(script, [id, list, name]);
    const [rid, rname] = stdout.split(FS);

    return JSON.stringify(
      {
        action: "delete",
        deleted: true,
        reminder: { id: (rid || "").trim() || null, name: (rname || "").trim() || name },
      },
      null,
      2
    );
  },

  // ── Value resolution ─────────────────────────────────────────────────────────

  _resolvePriority(value) {
    const p = (value == null ? "" : String(value)).toLowerCase().trim();
    if (!p) return { set: false, value: 0 };
    if (Object.prototype.hasOwnProperty.call(PRIORITY_TO_INT, p)) {
      return { set: true, value: PRIORITY_TO_INT[p] };
    }
    // Accept a raw integer too.
    const n = parseInt(p, 10);
    if (!Number.isNaN(n)) return { set: true, value: Math.max(0, Math.min(9, n)) };
    return { set: false, value: 0 };
  },

  _intToPriority(value) {
    const n = Number(value) || 0;
    if (n === 0) return "none";
    if (n <= 4) return "high";
    if (n === 5) return "medium";
    return "low";
  },

  /**
   * Parses an ISO-ish date string into local wall-clock components for
   * AppleScript. Accepts "YYYY-MM-DD" or "YYYY-MM-DD[ T]HH:MM[:SS]". When no
   * time is given, defaults to 09:00:00 local.
   */
  _resolveDueDate(value) {
    const raw = this._clean(value);
    if (!raw) return { set: false, components: ["0", "0", "0", "0", "0", "0"], iso: null };

    const m = raw.match(
      /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
    );
    if (!m) {
      return {
        error: `Could not parse dueDate "${raw}". Use ISO format YYYY-MM-DD or YYYY-MM-DDTHH:MM.`,
      };
    }

    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    const hasTime = m[4] != null;
    const hour = hasTime ? Number(m[4]) : 9;
    const minute = hasTime ? Number(m[5]) : 0;
    const second = m[6] != null ? Number(m[6]) : 0;

    if (
      month < 1 || month > 12 || day < 1 || day > 31 ||
      hour > 23 || minute > 59 || second > 59
    ) {
      return { error: `dueDate "${raw}" has an out-of-range component.` };
    }

    const pad = (n, w = 2) => String(n).padStart(w, "0");
    const iso = `${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}`;

    return {
      set: true,
      components: [year, month, day, hour, minute, second].map(String),
      iso,
    };
  },

  // ── Helpers ──────────────────────────────────────────────────────────────────

  _clean(value) {
    const s = value == null ? "" : String(value).trim();
    if (/[\u0000\u001E\u001F]/.test(s)) {
      throw new Error("Input contains illegal control characters.");
    }
    return s;
  },

  _toInt(value, fallback) {
    const n = parseInt(String(value == null ? "" : value).trim(), 10);
    return Number.isNaN(n) ? fallback : n;
  },

  _toBool(value) {
    if (value === true || value === false) return value;
    const s = String(value == null ? "" : value).trim().toLowerCase();
    if (s === "") return null;
    if (["true", "yes", "1", "done", "complete", "completed"].includes(s)) return true;
    if (["false", "no", "0", "incomplete", "open"].includes(s)) return false;
    return null;
  },

  _splitRecords(stdout) {
    return String(stdout || "")
      .split(RS)
      .map(r => r.replace(/\n+$/g, ""))
      .filter(r => r.length > 0);
  },

  _friendlyError(message) {
    const msg = (message || "").toLowerCase();
    if (/not authoriz|not allowed|-1743|don'?t have permission|access/.test(msg)) {
      return {
        error: "macOS denied automation access to the Reminders app.",
        fix: "Grant access in System Settings → Privacy & Security → Automation (or Reminders), then retry.",
        detail: message,
      };
    }
    if (/can'?t get|invalid index|-1719|-1728/.test(msg)) {
      return {
        error: "Reminder or list not found.",
        fix: "Check the list name / reminder title, or pass the exact 'id' from the 'get' action.",
        detail: message,
      };
    }
    return null;
  },

  _isMissingBinary(e) {
    return (
      e &&
      (e.code === 127 ||
        e.code === "ENOENT" ||
        /not found|enoent|command not found/i.test(e.message || ""))
    );
  },

  // ── Process execution ──────────────────────────────────────────────────────────

  /** Runs an AppleScript via osascript, passing args as `on run argv`. */
  _runOsa(script, argv) {
    const scriptArgs = ["-", ...argv.map(a => String(a))];
    return this._runCommand("osascript", scriptArgs, script);
  },

  /**
   * Resolves a command name to an absolute path by scanning known bin dirs.
   * Falls back to the bare name (letting PATH/spawn handle it) if not found.
   */
  _resolveBin(name) {
    if (name.includes("/")) return name;
    const fromPath = (process.env.PATH || "").split(":").filter(Boolean);
    for (const dir of [...BIN_DIRS, ...fromPath]) {
      const candidate = path.join(dir, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch (_) {
        /* keep looking */
      }
    }
    return name;
  },

  /** Builds a child env whose PATH includes the system/Homebrew bin dirs. */
  _childEnv() {
    const merged = [...BIN_DIRS, ...(process.env.PATH || "").split(":")].filter(
      Boolean
    );
    return { ...process.env, PATH: Array.from(new Set(merged)).join(":") };
  },

  /**
   * Spawns a child process safely (no shell, immune to command injection) and
   * resolves with { stdout, stderr }. Rejects on non-zero exit or timeout.
   */
  _runCommand(command, args, stdinData = null, timeoutMs = 120000) {
    const { spawn } = require("child_process");
    const bin = this._resolveBin(command);

    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, {
        shell: false,
        timeout: timeoutMs,
        env: this._childEnv(),
      });

      let stdout = "";
      let stderr = "";
      let killedByTimeout = false;

      const timer = setTimeout(() => {
        killedByTimeout = true;
        child.kill("SIGTERM");
      }, timeoutMs);

      child.stdout.on("data", c => (stdout += c.toString()));
      child.stderr.on("data", c => (stderr += c.toString()));

      child.on("error", err => {
        clearTimeout(timer);
        reject(err);
      });

      child.on("close", code => {
        clearTimeout(timer);
        if (killedByTimeout) {
          reject(new Error(`Command "${command}" timed out after ${timeoutMs}ms.`));
          return;
        }
        if (code === 0 || code === null) {
          resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
        } else {
          const msg =
            stderr.trim() || stdout.trim() || `Process exited with code ${code}`;
          const err = new Error(msg);
          err.code = code;
          reject(err);
        }
      });

      if (stdinData !== null) child.stdin.write(stdinData);
      child.stdin.end();
    });
  },
};
