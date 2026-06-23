// handler.js
// Apple Shortcuts Runner — AnythingLLM Custom Agent Skill
//
// Finds and triggers macOS Apple Shortcuts entirely from the command line, with
// no UI interaction. Three actions:
//   - "list": list every installed shortcut by name.
//   - "find": filter shortcuts whose name contains a case-insensitive substring.
//   - "run":  trigger a shortcut by name, with optional text/file input and
//             captured output.
//
// Primary engine is the built-in `shortcuts` CLI (macOS 12 Monterey+). When that
// binary is unavailable, the skill transparently falls back to AppleScript via
// `osascript` (the "Shortcuts Events" scripting target). The returned JSON always
// includes an `engine` field ("cli" or "applescript") so callers know which ran.
//
// SAFETY: shortcuts can perform real, irreversible actions (send messages, change
// settings, control devices). Only run shortcuts you trust. The AppleScript
// fallback may trigger a one-time macOS Automation permission prompt.

const os = require("os");
const path = require("path");
const fs = require("fs");

// macOS GUI apps (like AnythingLLM Desktop) are launched without the user's
// shell PATH. We search these directories to resolve absolute binary paths and
// also inject them into the child process PATH.
const BIN_DIRS = [
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
  "/opt/homebrew/bin",
  "/usr/local/bin",
];

// AppleScript scripting target for Shortcuts.
const SHORTCUTS_APP = "Shortcuts Events";

module.exports.runtime = {
  handler: async function (args) {
    const params = args || {};
    const callerId = `${this.config.name}-v${this.config.version}`;
    const act = (params.action || "").toLowerCase().trim();

    try {
      switch (act) {
        case "list":
          return await this._list(callerId);
        case "find":
        case "search":
          return await this._find(callerId, params);
        case "run":
        case "trigger":
          return await this._run(callerId, params);
        default:
          return (
            `Error: Unknown action "${params.action}". Supported actions: ` +
            "list, find, run."
          );
      }
    } catch (e) {
      this.introspect(`${callerId}: Failed — ${e.message}`);
      this.logger(`${callerId} error: ${e.message}`);

      if (e.code === "ENOSHORTCUTS") {
        return JSON.stringify(
          {
            error:
              "No way to control Apple Shortcuts was found (neither the " +
              "'shortcuts' CLI nor 'osascript').",
            fix:
              "This skill requires macOS 12 (Monterey) or later with the " +
              "Shortcuts app installed.",
          },
          null,
          2
        );
      }

      return `Apple Shortcuts Runner error: ${e.message}`;
    }
  },

  // ── Actions ────────────────────────────────────────────────────────────────

  async _list(callerId) {
    this.introspect(`${callerId}: Listing installed shortcuts...`);
    const { shortcuts, engine } = await this._getShortcuts(callerId);
    return JSON.stringify(
      { action: "list", engine, shortcuts, count: shortcuts.length },
      null,
      2
    );
  },

  async _find(callerId, params) {
    const query = (params.query || "").trim();
    if (!query) {
      return 'Error: "query" is required for action "find".';
    }
    this._validateName(query);

    this.introspect(`${callerId}: Searching shortcuts matching "${query}"...`);
    const { shortcuts, engine } = await this._getShortcuts(callerId);

    const needle = query.toLowerCase();
    const matches = shortcuts.filter(n => n.toLowerCase().includes(needle));

    return JSON.stringify(
      { action: "find", engine, query, matches, count: matches.length },
      null,
      2
    );
  },

  async _run(callerId, params) {
    const name = (params.name || "").trim();
    if (!name) {
      return 'Error: "name" is required for action "run".';
    }
    this._validateName(name);

    const inputPath = (params.inputPath || "").trim();
    const outputPath = (params.outputPath || "").trim();
    const inputText = params.input != null ? String(params.input) : "";

    if (inputPath) this._validatePath(inputPath);
    if (outputPath) this._validatePath(outputPath);

    // Confirm the shortcut exists; if not, suggest close matches instead of
    // blindly invoking it.
    const { shortcuts, engine } = await this._getShortcuts(callerId);
    if (!shortcuts.some(n => n === name)) {
      const lower = name.toLowerCase();
      const suggestions = shortcuts
        .filter(n => n.toLowerCase().includes(lower) || lower.includes(n.toLowerCase()))
        .slice(0, 10);
      return JSON.stringify(
        {
          action: "run",
          engine,
          ran: false,
          error: `No shortcut named "${name}" was found.`,
          suggestions,
        },
        null,
        2
      );
    }

    // Run via AppleScript (osascript) as the primary engine. The CLI is still
    // used for listing/suggestions above, but execution goes through osascript
    // because it runs shortcuts in the interactive user session.
    return await this._runViaAppleScript(callerId, {
      name,
      inputText,
      inputPath,
      outputPath,
    });
  },

  // ── Engine: shortcuts CLI ────────────────────────────────────────────────────

  async _listViaCli() {
    const res = await this._runCommand("shortcuts", ["list"]);
    return res.stdout
      .split("\n")
      .map(l => l.trim())
      .filter(Boolean);
  },

  async _runViaCli(callerId, { name, inputText, inputPath, outputPath }) {
    const cliArgs = ["run", name];

    // Resolve the input source: an explicit file path wins over inline text.
    let resolvedInputPath = null;
    let tempInput = null;
    if (inputPath) {
      if (!fs.existsSync(inputPath)) {
        return JSON.stringify(
          { action: "run", engine: "cli", ran: false, error: `inputPath not found: ${inputPath}` },
          null,
          2
        );
      }
      resolvedInputPath = inputPath;
    } else if (inputText) {
      tempInput = this._tempFile("input", "txt");
      fs.writeFileSync(tempInput, inputText, "utf8");
      resolvedInputPath = tempInput;
    }
    if (resolvedInputPath) cliArgs.push("--input-path", resolvedInputPath);

    // Always capture output to a file so we can read it back.
    const outFile = outputPath || this._tempFile("output", "out");
    cliArgs.push("--output-path", outFile);

    this.introspect(`${callerId}: Running shortcut "${name}" via the shortcuts CLI...`);
    try {
      await this._runCommand("shortcuts", cliArgs);
    } catch (e) {
      if (tempInput) this._safeUnlink(tempInput);
      if (!outputPath) this._safeUnlink(outFile);
      // The CLI runs shortcuts in a sandboxed background context where some
      // actions (notably HomeKit "Control device" steps) fail with "a required
      // app is missing." Retry by letting the Shortcuts app run it instead.
      if (this._isBackgroundUnsupportedError(e)) {
        this.introspect(
          `${callerId}: CLI can't run "${name}" in the background (${e.message}). ` +
            "Retrying through the Shortcuts app URL scheme..."
        );
        return await this._runViaUrlScheme(callerId, {
          name,
          inputText,
          reason: e.message,
        });
      }
      throw e;
    }

    let output = null;
    try {
      output = this._truncate(fs.readFileSync(outFile, "utf8"));
    } catch (_) {
      output = null;
    } finally {
      if (tempInput) this._safeUnlink(tempInput);
      if (!outputPath) this._safeUnlink(outFile);
    }

    return JSON.stringify(
      {
        action: "run",
        engine: "cli",
        ran: true,
        name,
        input: inputPath ? `(file) ${inputPath}` : inputText || null,
        outputFile: outputPath || null,
        output: output || "(no output)",
      },
      null,
      2
    );
  },

  // ── Engine: AppleScript fallback ─────────────────────────────────────────────

  async _listViaAppleScript() {
    // `name of every shortcut` returns a comma-separated AppleScript list.
    const script =
      'on run argv\n' +
      `  tell application "${SHORTCUTS_APP}" to set theNames to name of every shortcut\n` +
      "  set AppleScript's text item delimiters to linefeed\n" +
      "  return theNames as text\n" +
      "end run\n";
    const res = await this._runCommand("osascript", ["-"], script);
    return res.stdout
      .split("\n")
      .map(l => l.trim())
      .filter(Boolean);
  },

  async _runViaAppleScript(callerId, { name, inputText, inputPath, outputPath }) {
    // User values are passed as argv — never interpolated into the script text —
    // so this is immune to AppleScript injection.
    const useFileInput = Boolean(inputPath);
    if (useFileInput && !fs.existsSync(inputPath)) {
      return JSON.stringify(
        {
          action: "run",
          engine: "applescript",
          ran: false,
          error: `inputPath not found: ${inputPath}`,
        },
        null,
        2
      );
    }
    const useTextInput = !useFileInput && Boolean(inputText);

    let inputClause = "";
    if (useFileInput) {
      inputClause = " with input (POSIX file (item 2 of argv))";
    } else if (useTextInput) {
      inputClause = " with input (item 2 of argv)";
    }

    const script =
      "on run argv\n" +
      "  set theName to item 1 of argv\n" +
      `  tell application "${SHORTCUTS_APP}" to set theResult to run shortcut theName${inputClause}\n` +
      "  if theResult is missing value then return \"\"\n" +
      "  return theResult as text\n" +
      "end run\n";

    const scriptArgs = ["-", name];
    if (useFileInput) scriptArgs.push(inputPath);
    else if (useTextInput) scriptArgs.push(inputText);

    this.introspect(`${callerId}: Running shortcut "${name}" via AppleScript (osascript)...`);
    let res;
    try {
      res = await this._runCommand("osascript", scriptArgs, script);
    } catch (e) {
      // Some actions (notably HomeKit "Control device" steps) fail in a
      // non-interactive context — defer to the Shortcuts app URL scheme.
      if (this._isBackgroundUnsupportedError(e)) {
        this.introspect(
          `${callerId}: AppleScript can't run "${name}" here ` +
            `(${e.message}). Retrying through the Shortcuts app URL scheme...`
        );
        return await this._runViaUrlScheme(callerId, {
          name,
          inputText,
          reason: e.message,
        });
      }
      throw e;
    }
    const output = this._truncate(res.stdout) || "(no output)";

    // The AppleScript engine returns the result inline; honor outputPath if given.
    let outputFile = null;
    if (outputPath) {
      try {
        fs.writeFileSync(outputPath, res.stdout, "utf8");
        outputFile = outputPath;
      } catch (e) {
        this.logger(`${callerId}: failed writing outputPath — ${e.message}`);
      }
    }

    return JSON.stringify(
      {
        action: "run",
        engine: "applescript",
        ran: true,
        name,
        input: inputPath ? `(file) ${inputPath}` : inputText || null,
        outputFile,
        output,
      },
      null,
      2
    );
  },

  // ── Engine: Shortcuts app URL scheme (foreground-capable fallback) ───────────

  /**
   * Runs a shortcut by handing it to the Shortcuts app via its
   * `shortcuts://run-shortcut` URL scheme. Unlike the CLI/AppleScript engines,
   * the app runs the shortcut with full app access (HomeKit, etc.), so this is
   * used as a fallback when those engines report a missing/unsupported app.
   * `open -g` runs it in the background without bringing the app to the front.
   * Trade-off: the URL scheme does not return the shortcut's output.
   */
  async _runViaUrlScheme(callerId, { name, inputText, reason }) {
    let url = `shortcuts://run-shortcut?name=${encodeURIComponent(name)}`;
    if (inputText) {
      url += `&input=text&text=${encodeURIComponent(inputText)}`;
    }

    this.introspect(`${callerId}: Launching "${name}" via the Shortcuts app (open -g)...`);
    await this._runCommand("open", ["-g", url]);

    return JSON.stringify(
      {
        action: "run",
        engine: "url",
        ran: true,
        name,
        input: inputText || null,
        output: null,
        note:
          "Ran through the Shortcuts app via its URL scheme because the " +
          "shortcut could not run in the background" +
          (reason ? ` (${reason})` : "") +
          ". This engine cannot capture the shortcut's output.",
      },
      null,
      2
    );
  },

  _isBackgroundUnsupportedError(e) {
    const msg = (e && e.message ? e.message : "").toLowerCase();
    return /required app is missing|cannot be run|could ?n.t be run|could not be run|not supported|unable to run|no app/.test(
      msg
    );
  },

  // ── Engine selection ─────────────────────────────────────────────────────────

  /**
   * Lists shortcuts using the best available engine. Tries the `shortcuts` CLI
   * first; on a missing-binary error falls back to AppleScript. Throws
   * ENOSHORTCUTS when neither engine is available.
   */
  async _getShortcuts(callerId) {
    try {
      const shortcuts = await this._listViaCli();
      return { shortcuts, engine: "cli" };
    } catch (cliErr) {
      if (!this._isMissingBinary(cliErr)) throw cliErr;
      this.introspect(
        `${callerId}: 'shortcuts' CLI unavailable — falling back to AppleScript...`
      );
      try {
        const shortcuts = await this._listViaAppleScript();
        return { shortcuts, engine: "applescript" };
      } catch (asErr) {
        if (this._isMissingBinary(asErr)) {
          const err = new Error("No shortcuts engine available.");
          err.code = "ENOSHORTCUTS";
          throw err;
        }
        throw asErr;
      }
    }
  },

  _isMissingBinary(e) {
    return (
      e &&
      (e.code === 127 ||
        e.code === "ENOENT" ||
        /not found|enoent|command not found/i.test(e.message || ""))
    );
  },

  // ── Helpers ──────────────────────────────────────────────────────────────────

  _tempFile(label, ext) {
    const dir = path.join(os.tmpdir(), "anythingllm-shortcuts");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const rand = Math.random().toString(36).slice(2, 8);
    return path.join(dir, `${label}-${stamp}-${rand}.${ext}`);
  },

  _safeUnlink(p) {
    try {
      fs.unlinkSync(p);
    } catch (_) {
      /* ignore */
    }
  },

  _truncate(str, max = 6000) {
    if (!str) return str;
    const s = String(str).trim();
    return s.length > max
      ? s.slice(0, max) + `\n... [truncated ${s.length - max} chars]`
      : s;
  },

  // ── Validation ────────────────────────────────────────────────────────────────

  _validateName(name) {
    if (/[\u0000\n\r]/.test(name)) {
      throw new Error("Shortcut name/query contains illegal control characters.");
    }
  },

  _validatePath(p) {
    if (/[\u0000\n\r]/.test(p)) {
      throw new Error("Path contains illegal control characters.");
    }
  },

  // ── Process execution ──────────────────────────────────────────────────────────

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
  _runCommand(command, args, stdinData = null, timeoutMs = 60000) {
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
