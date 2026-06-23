// handler.js
// Network Sniffer — AnythingLLM Custom Agent Skill
//
// Advanced network packet sniffer for macOS built on the Wireshark CLI
// (`tshark`, with `capinfos` for file summaries). Supports listing capture
// interfaces, live capture to pcap, capturing/filtering by IP or domain, a
// full-network scan, contacted-domain extraction, payload search, cleartext
// credential extraction, a PII/secrets DLP scan, and offline pcap analysis.
//
// FOR AUTHORIZED USE ONLY. Only capture traffic on networks and devices you
// own or have explicit written permission to monitor. Intercepting other
// people's communications without consent may be illegal in your jurisdiction.
//
// Requires Wireshark's CLI tools: `brew install --cask wireshark`
// (the cask also installs the ChmodBPF helper that grants packet-capture
// permission to members of the `access_bpf` group without sudo).

const os = require("os");
const path = require("path");
const fs = require("fs");
const net = require("net");
const dns = require("dns").promises;
// macOS GUI apps (like AnythingLLM Desktop) are launched without the user's
// shell PATH, so Homebrew binaries are not found by a bare `spawn("tshark")`.
// We search these directories to resolve absolute binary paths and also inject
// them into the child process PATH so tshark can locate its own `dumpcap`.
const BIN_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
];
// ── Safety bounds ─────────────────────────────────────────────────────────────
const DEFAULT_DURATION = 60; // seconds
const DEFAULT_PACKETS = 5000;
const MAX_DURATION = 600; // seconds
const MAX_PACKETS = 200000;
const SNAPLEN = 262144; // bytes per packet (tshark default "full packet")
const MAX_ROWS = 20; // cap on rows returned for list-style stats

// Heuristic thresholds for the 'threats' detection action.
const PORTSCAN_DISTINCT_PORTS = 15; // distinct dst ports from one src→dst ⇒ scan
const BEACON_MIN_SAMPLES = 6; // packets needed to call a flow periodic
const BEACON_CV_MAX = 0.15; // max interval coefficient-of-variation ⇒ regular

// Validation patterns
const HOSTNAME_RE =
  /^(?=.{1,253}$)(?!-)[a-zA-Z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-zA-Z0-9-]{1,63}(?<!-))*$/;

module.exports.runtime = {
  handler: async function (args) {
    const params = args || {};
    const callerId = `${this.config.name}-v${this.config.version}`;
    const act = (params.action || "").toLowerCase().trim();

    try {
      // Make sure the Wireshark CLI is actually present before doing anything.
      await this._ensureTshark(callerId);

      switch (act) {
        case "interfaces":
          return await this._listInterfaces(callerId);
        case "capture":
          return await this._capture(callerId, params);
        case "target":
          return await this._target(callerId, params);
        case "scan":
          return await this._scan(callerId, params);
        case "domains":
          return await this._domains(callerId, params);
        case "search":
          return await this._search(callerId, params);
        case "credentials":
          return await this._credentials(callerId, params);
        case "sensitive":
          return await this._sensitive(callerId, params);
        case "analyze":
          return await this._analyze(callerId, params);
        case "follow":
          return await this._follow(callerId, params);
        case "http":
          return await this._http(callerId, params);
        case "threats":
          return await this._threats(callerId, params);
        case "tls":
          return await this._tls(callerId, params);
        case "ioc":
          return await this._ioc(callerId, params);
        case "cleanup":
          return await this._cleanup(callerId);
        default:
          return (
            `Error: Unknown action "${params.action}". Supported actions: ` +
            "interfaces, capture, target, scan, domains, search, credentials, " +
            "sensitive, analyze, follow, http, threats, tls, ioc, cleanup."
          );
      }
    } catch (e) {
      this.introspect(`${callerId}: Failed — ${e.message}`);
      this.logger(`${callerId} error: ${e.message}`);

      if (e.code === "ENOTSHARK") {
        return JSON.stringify(
          {
            error: "tshark (Wireshark CLI) is not installed or not on PATH.",
            fix: "Install it with: brew install --cask wireshark",
            note:
              "The cask also installs the ChmodBPF helper that allows packet capture without sudo.",
          },
          null,
          2
        );
      }

      return `Network Sniffer error: ${e.message}`;
    }
  },

  // ── Actions ────────────────────────────────────────────────────────────────

  async _listInterfaces(callerId) {
    this.introspect(`${callerId}: Listing capture interfaces (tshark -D)...`);
    const result = await this._runTshark(["-D"]);

    // Each line looks like: "1. en0 (Wi-Fi)"
    const interfaces = result.stdout
      .split("\n")
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const m = line.match(/^(\d+)\.\s+(\S+)(?:\s+\((.+)\))?$/);
        if (!m) return { raw: line };
        return { index: Number(m[1]), name: m[2], description: m[3] || null };
      });

    return JSON.stringify(
      { action: "interfaces", interfaces, count: interfaces.length },
      null,
      2
    );
  },

  async _capture(callerId, params) {
    const { interface: iface, captureFilter } = params;
    const outFile = this._resolveOutFile(params.pcapFile);
    const bounds = this._resolveBounds(params);
    const { duration, packets } = bounds;

    const captureArgs = this._buildCaptureArgs({
      iface,
      captureFilter,
      duration,
      packets,
      outFile,
    });

    this.introspect(
      `${callerId}: Capturing on ${iface || "default interface"} ` +
        `(${this._describeStop(bounds)}) → ${outFile}...`
    );

    await this._runTshark(captureArgs, null, duration);
    const summary = await this._fileSummary(outFile);

    return JSON.stringify(
      {
        action: "capture",
        interface: iface || "(default)",
        captureFilter: captureFilter || null,
        stopAfter: this._stopAfter(bounds),
        outputFile: outFile,
        summary,
      },
      null,
      2
    );
  },

  async _target(callerId, params) {
    const target = (params.target || "").trim();
    if (!target) {
      return 'Error: "target" (an IP address or domain) is required for action "target".';
    }
    this._validateTarget(target);

    let ips = [];
    let resolvedFrom = null;
    if (net.isIP(target)) {
      ips = [target];
    } else {
      this.introspect(`${callerId}: Resolving ${target} to IP addresses...`);
      ips = await this._resolveHost(target);
      resolvedFrom = target;
      if (!ips.length) {
        return JSON.stringify(
          { error: `Could not resolve "${target}" to any IP address.` },
          null,
          2
        );
      }
    }

    const captureFilter = ips.map(ip => `host ${ip}`).join(" or ");
    const outFile = this._resolveOutFile(params.pcapFile);
    const bounds = this._resolveBounds(params);
    const { duration, packets } = bounds;

    // Read from an existing file instead of capturing, if one was supplied.
    if (params.pcapFile && fs.existsSync(params.pcapFile)) {
      this.introspect(
        `${callerId}: Filtering ${params.pcapFile} for traffic involving ${target}...`
      );
      const dfilter = ips.map(ip => `ip.addr == ${ip}`).join(" or ");
      const res = await this._runTshark([
        "-r",
        params.pcapFile,
        "-Y",
        dfilter,
        "-q",
        "-z",
        "conv,ip",
      ]);
      return JSON.stringify(
        {
          action: "target",
          target,
          resolvedFrom,
          matchedIps: ips,
          source: params.pcapFile,
          conversations: this._truncate(res.stdout),
        },
        null,
        2
      );
    }

    const captureArgs = this._buildCaptureArgs({
      iface: params.interface,
      captureFilter,
      duration,
      packets,
      outFile,
    });

    this.introspect(
      `${callerId}: Capturing traffic for ${target} (${ips.join(", ")}) ` +
        `(${this._describeStop(bounds)})...`
    );

    await this._runTshark(captureArgs, null, duration);
    const summary = await this._fileSummary(outFile);

    return JSON.stringify(
      {
        action: "target",
        target,
        resolvedFrom,
        matchedIps: ips,
        captureFilter,
        stopAfter: this._stopAfter(bounds),
        outputFile: outFile,
        summary,
      },
      null,
      2
    );
  },

  async _scan(callerId, params) {
    // Capture broadly (or read a file), then compute statistics.
    const pcap = await this._obtainPcap(callerId, params, "Full network scan");

    this.introspect(`${callerId}: Computing protocol hierarchy and top talkers...`);

    const sf = this._statFilterSuffix(params);
    const phs = await this._runTshark(["-r", pcap.file, "-q", "-z", "io,phs"]);
    const conv = await this._runTshark([
      "-r",
      pcap.file,
      "-q",
      "-z",
      `conv,ip${sf}`,
    ]);
    const endpoints = await this._runTshark([
      "-r",
      pcap.file,
      "-q",
      "-z",
      `endpoints,ip${sf}`,
    ]);

    return JSON.stringify(
      {
        action: "scan",
        source: pcap.source,
        file: pcap.file,
        protocolHierarchy: this._truncate(phs.stdout),
        ipConversations: this._truncate(conv.stdout),
        topTalkers: this._truncate(endpoints.stdout),
      },
      null,
      2
    );
  },

  async _domains(callerId, params) {
    const pcap = await this._obtainPcap(callerId, params, "Domain extraction", {
      captureFilter: params.captureFilter || "port 53 or tcp port 443 or tcp port 80",
    });

    this.introspect(`${callerId}: Extracting contacted domains (DNS / TLS SNI / HTTP Host)...`);

    const res = await this._runTshark([
      "-r",
      pcap.file,
      "-Y",
      this._andDisplayFilter(
        "dns.flags.response == 0 || tls.handshake.extensions_server_name || http.host",
        params
      ),
      "-T",
      "fields",
      "-e",
      "dns.qry.name",
      "-e",
      "tls.handshake.extensions_server_name",
      "-e",
      "http.host",
      "-E",
      "separator=,",
    ]);

    const set = new Set();
    for (const line of res.stdout.split("\n")) {
      for (const field of line.split(",")) {
        const d = field.trim().toLowerCase();
        if (d && d !== "::" && HOSTNAME_RE.test(d)) set.add(d);
      }
    }
    const domains = Array.from(set).sort();

    const base = {
      action: "domains",
      source: pcap.source,
      file: pcap.file,
      domains,
      count: domains.length,
    };
    return this._maybeFormat(
      domains.map(d => ({ domain: d })),
      params,
      base
    );
  },

  async _search(callerId, params) {
    const term = (params.searchTerm || "").trim();
    const displayFilter = (params.displayFilter || "").trim();
    if (!term && !displayFilter) {
      return 'Error: action "search" requires "searchTerm" and/or "displayFilter".';
    }

    const pcap = await this._obtainPcap(callerId, params, "Payload search");

    // Build a display filter: combine "frame contains" with any user filter.
    const parts = [];
    if (term)
      parts.push(
        `frame contains "${term.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
      );
    if (displayFilter) parts.push(`(${displayFilter})`);
    const yFilter = parts.join(" && ");

    this.introspect(`${callerId}: Searching packets matching: ${yFilter}`);

    const res = await this._runTshark([
      "-r",
      pcap.file,
      "-Y",
      yFilter,
      "-T",
      "fields",
      "-e",
      "frame.number",
      "-e",
      "frame.time",
      "-e",
      "ip.src",
      "-e",
      "ip.dst",
      "-e",
      "_ws.col.Protocol",
      "-e",
      "_ws.col.Info",
      "-E",
      "separator=|",
    ]);

    const rows = res.stdout
      .split("\n")
      .map(l => l.trim())
      .filter(Boolean)
      .map(l => {
        const [number, time, src, dst, protocol, info] = l.split("|");
        return { number, time, src, dst, protocol, info };
      });

    const base = {
      action: "search",
      searchTerm: term || null,
      displayFilter: displayFilter || null,
      source: pcap.source,
      file: pcap.file,
      matchCount: rows.length,
      matches: rows.slice(0, MAX_ROWS),
      truncated: rows.length > MAX_ROWS,
    };
    return this._maybeFormat(rows.slice(0, MAX_ROWS), params, base);
  },

  async _credentials(callerId, params) {
    const pcap = await this._obtainPcap(callerId, params, "Credential extraction");

    this.introspect(
      `${callerId}: AUTHORIZED USE ONLY — extracting cleartext credentials (tshark -z credentials)...`
    );

    const res = await this._runTshark([
      "-o",
      "tcp.desegment_tcp_streams:TRUE",
      "-r",
      pcap.file,
      "-q",
      "-z",
      "credentials",
    ]);

    const report = this._truncate(res.stdout);
    const discarded = this._discardTemp(pcap);

    return JSON.stringify(
      {
        action: "credentials",
        warning:
          "Cleartext credentials only (FTP/HTTP/IMAP/POP/SMTP). For authorized auditing only.",
        source: pcap.source,
        file: discarded ? "(temporary capture discarded)" : pcap.file,
        tempDiscarded: discarded,
        found: Boolean(report),
        report: report || null,
      },
      null,
      2
    );
  },

  async _sensitive(callerId, params) {
    const pcap = await this._obtainPcap(callerId, params, "PII / secrets DLP scan");

    this.introspect(
      `${callerId}: AUTHORIZED USE ONLY — scanning cleartext payloads for PII and secrets...`
    );

    // Pull a UTF-8 view of each packet's payload along with addressing context.
    const res = await this._runTshark([
      "-o",
      "tcp.desegment_tcp_streams:TRUE",
      "-r",
      pcap.file,
      "-Y",
      this._andDisplayFilter(
        "http || ftp || pop || imap || smtp || telnet || data-text-lines",
        params
      ),
      "-T",
      "fields",
      "-e",
      "frame.number",
      "-e",
      "ip.src",
      "-e",
      "ip.dst",
      "-e",
      "_ws.col.Protocol",
      "-e",
      "frame.protocols",
      "-e",
      "text",
      "-E",
      "separator=\u0001",
    ]);

    const extraTerm = (params.searchTerm || "").trim().toLowerCase();
    const findings = [];
    for (const line of res.stdout.split("\n")) {
      if (!line.trim()) continue;
      const [number, src, dst, protocol, , payload] = line.split("\u0001");
      const text = payload || "";
      if (!text) continue;
      if (extraTerm && !text.toLowerCase().includes(extraTerm)) continue;

      for (const hit of this._detectSensitive(text)) {
        findings.push({ frame: number, src, dst, protocol, ...hit });
      }
    }

    // Summarize counts by type.
    const byType = {};
    for (const f of findings) byType[f.type] = (byType[f.type] || 0) + 1;
    const discarded = this._discardTemp(pcap);

    return JSON.stringify(
      {
        action: "sensitive",
        warning:
          "Detects cleartext PII/secrets only. Values are redacted in previews. For authorized auditing only.",
        source: pcap.source,
        file: discarded ? "(temporary capture discarded)" : pcap.file,
        tempDiscarded: discarded,
        totalFindings: findings.length,
        byType,
        findings: findings.slice(0, MAX_ROWS),
        truncated: findings.length > MAX_ROWS,
      },
      null,
      2
    );
  },

  async _analyze(callerId, params) {
    const file = (params.pcapFile || "").trim();
    if (!file) {
      return 'Error: "pcapFile" is required for action "analyze".';
    }
    this._validatePath(file);
    if (!fs.existsSync(file)) {
      return JSON.stringify({ error: `File not found: ${file}` }, null, 2);
    }

    this.introspect(`${callerId}: Analyzing ${file}...`);

    const summary = await this._fileSummary(file);
    const sf = this._statFilterSuffix(params);
    const phs = await this._runTshark(["-r", file, "-q", "-z", "io,phs"]);
    const conv = await this._runTshark(["-r", file, "-q", "-z", `conv,ip${sf}`]);

    return JSON.stringify(
      {
        action: "analyze",
        file,
        summary,
        protocolHierarchy: this._truncate(phs.stdout),
        ipConversations: this._truncate(conv.stdout),
      },
      null,
      2
    );
  },

  async _http(callerId, params) {
    const pcap = await this._obtainPcap(callerId, params, "HTTP transaction view", {
      captureFilter: params.captureFilter || "tcp port 80 or tcp port 8080",
    });

    this.introspect(`${callerId}: Extracting HTTP transactions...`);

    const res = await this._runTshark([
      "-r",
      pcap.file,
      "-Y",
      this._andDisplayFilter("http.request || http.response", params),
      "-T",
      "fields",
      "-e",
      "frame.number",
      "-e",
      "ip.src",
      "-e",
      "ip.dst",
      "-e",
      "http.request.method",
      "-e",
      "http.host",
      "-e",
      "http.request.uri",
      "-e",
      "http.response.code",
      "-e",
      "http.user_agent",
      "-e",
      "http.content_type",
      "-E",
      "separator=\u0001",
    ]);

    const rows = res.stdout
      .split("\n")
      .map(l => l.trim())
      .filter(Boolean)
      .map(l => {
        const [number, src, dst, method, host, uri, status, userAgent, contentType] =
          l.split("\u0001");
        return { number, src, dst, method, host, uri, status, userAgent, contentType };
      });

    const base = {
      action: "http",
      source: pcap.source,
      file: pcap.file,
      count: rows.length,
      transactions: rows.slice(0, MAX_ROWS),
      truncated: rows.length > MAX_ROWS,
    };
    return this._maybeFormat(rows.slice(0, MAX_ROWS), params, base);
  },

  async _tls(callerId, params) {
    const pcap = await this._obtainPcap(callerId, params, "TLS / certificate intel", {
      captureFilter: params.captureFilter || "tcp port 443",
    });

    this.introspect(`${callerId}: Extracting TLS handshakes and certificates...`);

    const res = await this._runTshark([
      "-r",
      pcap.file,
      "-Y",
      this._andDisplayFilter(
        "tls.handshake.type == 1 || tls.handshake.type == 2 || tls.handshake.type == 11",
        params
      ),
      "-T",
      "fields",
      "-e",
      "frame.number",
      "-e",
      "ip.src",
      "-e",
      "ip.dst",
      "-e",
      "tls.handshake.extensions_server_name",
      "-e",
      "tls.handshake.version",
      "-e",
      "tls.handshake.ciphersuite",
      "-e",
      "x509sat.printableString",
      "-e",
      "x509af.notAfter",
      "-E",
      "separator=\u0001",
      "-E",
      "occurrence=f",
    ]);

    const rows = [];
    let legacy = 0;
    for (const line of res.stdout.split("\n")) {
      if (!line.trim()) continue;
      const [frame, src, dst, sni, version, cipher, certSubject, certExpiry] =
        line.split("\u0001");
      const ver = this._tlsVersion(version);
      if (ver.legacy) legacy++;
      rows.push({
        frame,
        src,
        dst,
        sni: sni || null,
        tlsVersion: ver.label,
        legacyProtocol: ver.legacy,
        cipherSuite: cipher || null,
        certSubject: certSubject || null,
        certExpiry: certExpiry || null,
      });
    }

    const base = {
      action: "tls",
      source: pcap.source,
      file: pcap.file,
      handshakeCount: rows.length,
      legacyProtocolCount: legacy,
      handshakes: rows.slice(0, MAX_ROWS),
      truncated: rows.length > MAX_ROWS,
    };
    return this._maybeFormat(rows.slice(0, MAX_ROWS), params, base);
  },

  async _threats(callerId, params) {
    const pcap = await this._obtainPcap(callerId, params, "Threat-detection heuristics");

    this.introspect(
      `${callerId}: Scanning for port scans, plaintext auth, ARP anomalies and beaconing...`
    );

    // 1) Port scans — one src hitting many distinct dst ports with SYN-only.
    const scanRes = await this._runTshark([
      "-r",
      pcap.file,
      "-Y",
      "tcp.flags.syn == 1 && tcp.flags.ack == 0",
      "-T",
      "fields",
      "-e",
      "ip.src",
      "-e",
      "ip.dst",
      "-e",
      "tcp.dstport",
      "-E",
      "separator=\u0001",
    ]);
    const scanMap = new Map();
    for (const line of scanRes.stdout.split("\n")) {
      if (!line.trim()) continue;
      const [src, dst, port] = line.split("\u0001");
      if (!src || !dst || !port) continue;
      const key = `${src}\u0001${dst}`;
      if (!scanMap.has(key)) scanMap.set(key, new Set());
      scanMap.get(key).add(port.trim());
    }
    const portScans = [];
    for (const [key, ports] of scanMap) {
      if (ports.size >= PORTSCAN_DISTINCT_PORTS) {
        const [src, dst] = key.split("\u0001");
        portScans.push({ src, dst, distinctPorts: ports.size });
      }
    }
    portScans.sort((a, b) => b.distinctPorts - a.distinctPorts);

    // 2) ARP anomalies — one IP claimed by more than one MAC (possible spoof).
    const arpRes = await this._runTshark([
      "-r",
      pcap.file,
      "-Y",
      "arp",
      "-T",
      "fields",
      "-e",
      "arp.src.proto_ipv4",
      "-e",
      "arp.src.hw_mac",
      "-E",
      "separator=\u0001",
    ]);
    const ipToMacs = new Map();
    for (const line of arpRes.stdout.split("\n")) {
      if (!line.trim()) continue;
      const [ip, mac] = line.split("\u0001");
      if (!ip || !mac) continue;
      if (!ipToMacs.has(ip)) ipToMacs.set(ip, new Set());
      ipToMacs.get(ip).add(mac.trim());
    }
    const arpAnomalies = [];
    for (const [ip, macs] of ipToMacs) {
      if (macs.size > 1) arpAnomalies.push({ ip, macs: [...macs] });
    }

    // 3) Plaintext authentication seen on the wire.
    const authFilter =
      'http.authorization || ftp.request.command == "USER" || ' +
      'ftp.request.command == "PASS" || pop.request.command == "USER" || ' +
      'pop.request.command == "PASS" || imap.request || telnet';
    const authRes = await this._runTshark([
      "-r",
      pcap.file,
      "-Y",
      authFilter,
      "-T",
      "fields",
      "-e",
      "frame.number",
      "-e",
      "ip.src",
      "-e",
      "ip.dst",
      "-e",
      "_ws.col.Protocol",
      "-E",
      "separator=\u0001",
    ]);
    const plaintextAuth = authRes.stdout
      .split("\n")
      .map(l => l.trim())
      .filter(Boolean)
      .map(l => {
        const [frame, src, dst, protocol] = l.split("\u0001");
        return { frame, src, dst, protocol };
      });

    // 4) Beaconing — flows with highly regular inter-packet timing (possible C2).
    const tRes = await this._runTshark([
      "-r",
      pcap.file,
      "-Y",
      this._andDisplayFilter("ip", params),
      "-T",
      "fields",
      "-e",
      "frame.time_epoch",
      "-e",
      "ip.src",
      "-e",
      "ip.dst",
      "-E",
      "separator=\u0001",
    ]);
    const flows = new Map();
    for (const line of tRes.stdout.split("\n")) {
      if (!line.trim()) continue;
      const [t, src, dst] = line.split("\u0001");
      const ts = parseFloat(t);
      if (!src || !dst || !Number.isFinite(ts)) continue;
      const key = `${src}\u0001${dst}`;
      if (!flows.has(key)) flows.set(key, []);
      flows.get(key).push(ts);
    }
    const beacons = [];
    for (const [key, times] of flows) {
      if (times.length < BEACON_MIN_SAMPLES + 1) continue;
      times.sort((a, b) => a - b);
      const intervals = [];
      for (let i = 1; i < times.length; i++) intervals.push(times[i] - times[i - 1]);
      const mean = intervals.reduce((s, v) => s + v, 0) / intervals.length;
      if (mean <= 0) continue;
      const variance =
        intervals.reduce((s, v) => s + (v - mean) ** 2, 0) / intervals.length;
      const cv = Math.sqrt(variance) / mean;
      if (cv <= BEACON_CV_MAX) {
        const [src, dst] = key.split("\u0001");
        beacons.push({
          src,
          dst,
          samples: times.length,
          intervalSeconds: Number(mean.toFixed(2)),
          regularity: Number((1 - cv).toFixed(3)),
        });
      }
    }
    beacons.sort((a, b) => b.regularity - a.regularity);

    return JSON.stringify(
      {
        action: "threats",
        source: pcap.source,
        file: pcap.file,
        summary: {
          portScans: portScans.length,
          arpAnomalies: arpAnomalies.length,
          plaintextAuth: plaintextAuth.length,
          beacons: beacons.length,
        },
        portScans: portScans.slice(0, MAX_ROWS),
        arpAnomalies: arpAnomalies.slice(0, MAX_ROWS),
        plaintextAuth: plaintextAuth.slice(0, MAX_ROWS),
        beaconing: beacons.slice(0, MAX_ROWS),
      },
      null,
      2
    );
  },

  async _follow(callerId, params) {
    const pcap = await this._obtainPcap(
      callerId,
      params,
      "Stream follow / object extraction"
    );

    const extract = (params.extract || "").toLowerCase().trim();
    if (extract) {
      const allowed = ["http", "smb", "smb2", "tftp", "imf", "dicom"];
      if (!allowed.includes(extract)) {
        return JSON.stringify(
          {
            error: `Unsupported extract protocol "${extract}". Allowed: ${allowed.join(
              ", "
            )}.`,
          },
          null,
          2
        );
      }
      const dir = path.join(
        os.tmpdir(),
        "anythingllm-sniffer",
        `objects-${Date.now()}`
      );
      fs.mkdirSync(dir, { recursive: true });
      this.introspect(`${callerId}: Exporting ${extract} objects to ${dir}...`);
      await this._runTshark([
        "-r",
        pcap.file,
        "-q",
        "--export-objects",
        `${extract},${dir}`,
      ]);
      let objects = [];
      try {
        objects = fs.readdirSync(dir).map(name => ({
          name,
          bytes: fs.statSync(path.join(dir, name)).size,
        }));
      } catch (_) {
        /* directory may be empty */
      }
      return JSON.stringify(
        {
          action: "follow",
          mode: "export-objects",
          protocol: extract,
          source: pcap.source,
          file: pcap.file,
          outputDir: dir,
          objectCount: objects.length,
          objects: objects.slice(0, MAX_ROWS),
          note: "Carved files may contain sensitive data. Run action 'cleanup' to remove them.",
        },
        null,
        2
      );
    }

    // Follow a single TCP stream, chosen by index or by a locator filter.
    let index = null;
    if (params.streamIndex !== undefined && `${params.streamIndex}`.trim() !== "") {
      const n = Number(params.streamIndex);
      if (!Number.isFinite(n) || n < 0) {
        return 'Error: "streamIndex" must be a non-negative number.';
      }
      index = Math.floor(n);
    } else {
      const locate = await this._runTshark([
        "-r",
        pcap.file,
        "-Y",
        this._locateFilter(params),
        "-T",
        "fields",
        "-e",
        "tcp.stream",
        "-E",
        "occurrence=f",
      ]);
      const first = locate.stdout
        .split("\n")
        .map(s => s.trim())
        .filter(Boolean)[0];
      index = first ? Number(first) : 0;
    }

    this.introspect(`${callerId}: Following TCP stream ${index}...`);
    const res = await this._runTshark([
      "-r",
      pcap.file,
      "-q",
      "-z",
      `follow,tcp,ascii,${index}`,
    ]);

    return JSON.stringify(
      {
        action: "follow",
        mode: "tcp-stream",
        streamIndex: index,
        source: pcap.source,
        file: pcap.file,
        stream: this._truncate(res.stdout) || "(empty stream)",
      },
      null,
      2
    );
  },

  async _ioc(callerId, params) {
    const iocFile = (params.iocFile || "").trim();
    if (!iocFile) {
      return 'Error: "iocFile" (path to a newline-separated indicator list) is required for action "ioc".';
    }
    this._validatePath(iocFile);
    if (!fs.existsSync(iocFile)) {
      return JSON.stringify({ error: `IOC file not found: ${iocFile}` }, null, 2);
    }

    let raw;
    try {
      raw = fs.readFileSync(iocFile, "utf8");
    } catch (e) {
      return JSON.stringify(
        { error: `Could not read IOC file: ${e.message}` },
        null,
        2
      );
    }

    const ipSet = new Set();
    const domSet = new Set();
    for (const lineRaw of raw.split(/\r?\n/)) {
      const v = lineRaw.trim().toLowerCase();
      if (!v || v.startsWith("#")) continue;
      if (net.isIP(v)) ipSet.add(v);
      else if (HOSTNAME_RE.test(v)) domSet.add(v);
    }
    if (!ipSet.size && !domSet.size) {
      return JSON.stringify(
        { error: "No valid IPs or domains found in IOC file." },
        null,
        2
      );
    }

    const pcap = await this._obtainPcap(callerId, params, "IOC matching");
    this.introspect(
      `${callerId}: Matching capture against ${ipSet.size} IP + ${domSet.size} domain indicators...`
    );

    // Observed IP addresses.
    const ipRes = await this._runTshark([
      "-r",
      pcap.file,
      "-T",
      "fields",
      "-e",
      "ip.src",
      "-e",
      "ip.dst",
      "-E",
      "separator=\u0001",
    ]);
    const seenIps = new Set();
    for (const line of ipRes.stdout.split("\n")) {
      for (const f of line.split("\u0001")) {
        const v = f.trim().toLowerCase();
        if (v) seenIps.add(v);
      }
    }

    // Observed domains (DNS queries, TLS SNI, HTTP Host).
    const domRes = await this._runTshark([
      "-r",
      pcap.file,
      "-Y",
      "dns.flags.response == 0 || tls.handshake.extensions_server_name || http.host",
      "-T",
      "fields",
      "-e",
      "dns.qry.name",
      "-e",
      "tls.handshake.extensions_server_name",
      "-e",
      "http.host",
      "-E",
      "separator=,",
    ]);
    const seenDoms = new Set();
    for (const line of domRes.stdout.split("\n")) {
      for (const f of line.split(",")) {
        const v = f.trim().toLowerCase();
        if (v && HOSTNAME_RE.test(v)) seenDoms.add(v);
      }
    }

    const matches = [];
    for (const ip of ipSet) if (seenIps.has(ip)) matches.push({ indicator: ip, type: "ip" });
    for (const dom of domSet) {
      const hit =
        seenDoms.has(dom) || [...seenDoms].some(s => s === dom || s.endsWith(`.${dom}`));
      if (hit) matches.push({ indicator: dom, type: "domain" });
    }

    const base = {
      action: "ioc",
      source: pcap.source,
      file: pcap.file,
      indicatorsLoaded: ipSet.size + domSet.size,
      matchCount: matches.length,
      matches: matches.slice(0, MAX_ROWS),
      truncated: matches.length > MAX_ROWS,
    };
    return this._maybeFormat(matches.slice(0, MAX_ROWS), params, base);
  },

  async _cleanup(callerId) {
    const dir = path.join(os.tmpdir(), "anythingllm-sniffer");
    let removed = 0;
    const errors = [];
    try {
      const entries = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
      for (const name of entries) {
        try {
          fs.rmSync(path.join(dir, name), { recursive: true, force: true });
          removed++;
        } catch (e) {
          errors.push(`${name}: ${e.message}`);
        }
      }
    } catch (e) {
      return JSON.stringify({ action: "cleanup", error: e.message }, null, 2);
    }
    this.introspect(`${callerId}: Removed ${removed} temp capture artifact(s).`);
    return JSON.stringify(
      { action: "cleanup", directory: dir, removed, errors },
      null,
      2
    );
  },

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /** ANDs the caller's optional displayFilter onto an action's base -Y filter. */
  _andDisplayFilter(base, params) {
    const df = (params.displayFilter || "").trim();
    if (!df) return base;
    this._validateFilter(df);
    return base ? `(${base}) && (${df})` : df;
  },

  /** Suffix for -z statistics that accept an optional display filter. */
  _statFilterSuffix(params) {
    const df = (params.displayFilter || "").trim();
    if (!df) return "";
    this._validateFilter(df);
    return `,${df}`;
  },

  /** Builds a locator filter (for 'follow') from searchTerm/displayFilter. */
  _locateFilter(params) {
    const term = (params.searchTerm || "").trim();
    const df = (params.displayFilter || "").trim();
    const parts = ["tcp"];
    if (term)
      parts.push(
        `frame contains "${term.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
      );
    if (df) {
      this._validateFilter(df);
      parts.push(`(${df})`);
    }
    return parts.join(" && ");
  },

  /** Returns JSON (default) or a CSV/NDJSON string per params.outputFormat. */
  _maybeFormat(rows, params, baseObj) {
    const fmt = (params.outputFormat || "json").toLowerCase().trim();
    if (fmt === "csv") return this._toCsv(rows);
    if (fmt === "ndjson") return rows.map(r => JSON.stringify(r)).join("\n");
    return JSON.stringify(baseObj, null, 2);
  },

  _toCsv(rows) {
    if (!rows.length) return "";
    const cols = Array.from(
      rows.reduce((s, r) => {
        Object.keys(r).forEach(k => s.add(k));
        return s;
      }, new Set())
    );
    const esc = v => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [cols.join(",")];
    for (const r of rows) lines.push(cols.map(c => esc(r[c])).join(","));
    return lines.join("\n");
  },

  /** Maps a tls.handshake.version value to a label + legacy (<= TLS 1.1) flag. */
  _tlsVersion(raw) {
    if (!raw) return { label: null, legacy: false };
    const n = parseInt(raw, /^0x/i.test(raw) ? 16 : 10);
    const map = {
      0x0300: "SSL 3.0",
      0x0301: "TLS 1.0",
      0x0302: "TLS 1.1",
      0x0303: "TLS 1.2",
      0x0304: "TLS 1.3",
    };
    const label = map[n] || raw;
    const legacy = Number.isFinite(n) && n > 0 && n <= 0x0302;
    return { label, legacy };
  },

  /**
   * Deletes a capture we wrote ourselves into the temp dir (used after the
   * credential/PII scans so cleartext secrets don't linger on disk). Never
   * touches user-supplied files or paths outside the sniffer temp dir.
   */
  _discardTemp(pcap) {
    if (!pcap || pcap.source !== "live" || !pcap.file) return false;
    const tmpRoot = path.join(os.tmpdir(), "anythingllm-sniffer");
    if (!pcap.file.startsWith(tmpRoot + path.sep)) return false;
    try {
      fs.rmSync(pcap.file, { force: true });
      return true;
    } catch (_) {
      return false;
    }
  },

  /**
   * Returns a pcap file to analyze: either an existing file the user supplied
   * via `pcapFile`, or a fresh live capture bounded by duration/packet count.
   */
  async _obtainPcap(callerId, params, label, opts = {}) {
    if (params.pcapFile && fs.existsSync(params.pcapFile)) {
      this._validatePath(params.pcapFile);
      return { file: params.pcapFile, source: "file" };
    }

    const outFile = this._resolveOutFile(null);
    const { duration, packets } = this._resolveBounds(params);
    const captureArgs = this._buildCaptureArgs({
      iface: params.interface,
      captureFilter: opts.captureFilter || params.captureFilter,
      duration,
      packets,
      outFile,
    });

    this.introspect(
      `${callerId}: ${label} — capturing for up to ${duration}s / ${packets} packets...`
    );
    await this._runTshark(captureArgs, null, duration);
    return { file: outFile, source: "live" };
  },

  _buildCaptureArgs({ iface, captureFilter, duration, packets, outFile }) {
    const a = [];
    if (iface) {
      this._validateInterface(iface);
      a.push("-i", iface);
    }
    a.push("-a", `duration:${duration}`);
    a.push("-c", String(packets));
    a.push("-s", String(SNAPLEN));
    if (captureFilter) {
      this._validateFilter(captureFilter);
      a.push("-f", captureFilter);
    }
    a.push("-w", outFile);
    return a;
  },

  _resolveBounds(params) {
    const durationSet = Number(params.duration) > 0;
    const packetsSet = Number(params.packetCount) > 0;
    let duration = Number(params.duration) || 0;
    let packets = Number(params.packetCount) || 0;
    if (!duration && !packets) {
      duration = DEFAULT_DURATION;
      packets = DEFAULT_PACKETS;
    } else {
      if (!duration) duration = MAX_DURATION;
      if (!packets) packets = MAX_PACKETS;
    }
    duration = Math.min(Math.max(1, Math.floor(duration)), MAX_DURATION);
    packets = Math.min(Math.max(1, Math.floor(packets)), MAX_PACKETS);
    return { duration, packets, durationSet, packetsSet };
  },

  /** Returns a stopAfter object reflecting only the bound(s) the user set. */
  _stopAfter(b) {
    if (b.durationSet && !b.packetsSet) return { seconds: b.duration };
    if (b.packetsSet && !b.durationSet) return { packets: b.packets };
    return { seconds: b.duration, packets: b.packets };
  },

  /** Human description of the active stop condition for introspection logs. */
  _describeStop(b) {
    const s = this._stopAfter(b);
    const parts = [];
    if (s.seconds != null) parts.push(`${s.seconds}s`);
    if (s.packets != null) parts.push(`${s.packets} packets`);
    return `stop after ${parts.join(" or ")}`;
  },

  _resolveOutFile(userPath) {
    if (userPath) {
      this._validatePath(userPath);
      if (!/\.(pcap|pcapng)$/i.test(userPath)) {
        throw new Error('pcapFile must end in ".pcap" or ".pcapng".');
      }
      return userPath;
    }
    const dir = path.join(os.tmpdir(), "anythingllm-sniffer");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return path.join(dir, `capture-${stamp}.pcapng`);
  },

  async _fileSummary(file) {
    try {
      const res = await this._runCommand("capinfos", [
        "-c",
        "-e",
        "-a",
        "-u",
        "-d",
        "-M",
        file,
      ]);
      const summary = {};
      for (const line of res.stdout.split("\n")) {
        const idx = line.indexOf(":");
        if (idx === -1) continue;
        const key = line.slice(0, idx).trim();
        const val = line.slice(idx + 1).trim();
        if (key) summary[key] = val;
      }
      return Object.keys(summary).length ? summary : this._truncate(res.stdout);
    } catch (e) {
      return `capinfos unavailable: ${e.message}`;
    }
  },

  /**
   * Detects cleartext PII and secrets inside a payload string. Values are
   * redacted in the returned preview so they are never echoed back in full.
   */
  _detectSensitive(text) {
    const hits = [];
    const checks = [
      {
        type: "basic_auth",
        re: /Authorization:\s*Basic\s+[A-Za-z0-9+/=]+/gi,
      },
      {
        type: "bearer_token",
        re: /Authorization:\s*Bearer\s+[A-Za-z0-9._-]+/gi,
      },
      {
        type: "jwt",
        re: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
      },
      {
        type: "password_field",
        re: /(?:password|passwd|pwd|pass)\s*[=:]\s*\S+/gi,
      },
      {
        type: "api_key",
        re: /(?:api[_-]?key|secret|token|access[_-]?key)\s*[=:]\s*\S+/gi,
      },
      { type: "email", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
      {
        type: "credit_card",
        re: /\b(?:\d[ -]?){13,19}\b/g,
        validate: this._luhn,
      },
      { type: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/g },
      { type: "iban", re: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g },
    ];

    for (const c of checks) {
      const matches = text.match(c.re);
      if (!matches) continue;
      for (const m of matches.slice(0, 5)) {
        if (c.validate && !c.validate(m)) continue;
        hits.push({ type: c.type, preview: this._redact(m) });
      }
    }
    return hits;
  },

  _luhn(value) {
    const digits = value.replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19) return false;
    let sum = 0;
    let alt = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let n = parseInt(digits[i], 10);
      if (alt) {
        n *= 2;
        if (n > 9) n -= 9;
      }
      sum += n;
      alt = !alt;
    }
    return sum % 10 === 0;
  },

  /** Masks a matched value so secrets are never echoed back in full. */
  _redact(value) {
    const s = String(value);
    if (s.length <= 8) return `*** (len ${s.length})`;
    return `${s.slice(0, 4)}***${s.slice(-2)} (len ${s.length})`;
  },

  _truncate(str, max = 6000) {
    if (!str) return str;
    return str.length > max
      ? str.slice(0, max) + `\n... [truncated ${str.length - max} chars]`
      : str;
  },

  async _resolveHost(host) {
    const ips = [];
    try {
      ips.push(...(await dns.resolve4(host)));
    } catch (_) {
      /* ignore */
    }
    try {
      ips.push(...(await dns.resolve6(host)));
    } catch (_) {
      /* ignore */
    }
    return Array.from(new Set(ips));
  },

  // ── Validation ──────────────────────────────────────────────────────────────

  _validateTarget(target) {
    if (net.isIP(target) || HOSTNAME_RE.test(target)) {
      return;
    }
    throw new Error(
      `Invalid target "${target}" — must be an IPv4/IPv6 address or a hostname.`
    );
  },

  _validateInterface(iface) {
    if (!/^[A-Za-z0-9._:-]+$/.test(iface)) {
      throw new Error(`Invalid interface name "${iface}".`);
    }
  },

  _validateFilter(filter) {
    // No shell is used, so this is defense-in-depth against control characters.
    if (/[\u0000\n\r]/.test(filter)) {
      throw new Error("Filter contains illegal control characters.");
    }
  },

  _validatePath(p) {
    if (/[\u0000]/.test(p)) {
      throw new Error("Path contains a null byte.");
    }
  },

  // ── Process execution ────────────────────────────────────────────────────────

  /**
   * Runs tshark. On a permission error it transparently retries via `sudo -n`
   * (non-interactive). If that also fails, throws a guidance error.
   */
  async _runTshark(args, stdinData = null, captureSeconds = 0) {
    const timeoutMs = (captureSeconds ? captureSeconds + 20 : 60) * 1000;
    try {
      return await this._runCommand("tshark", args, stdinData, timeoutMs);
    } catch (e) {
      if (this._isPermissionError(e)) {
        try {
          // Pass tshark's absolute path: sudo's secure_path won't include Homebrew.
          return await this._runCommand(
            "sudo",
            ["-n", this._resolveBin("tshark"), ...args],
            stdinData,
            timeoutMs
          );
        } catch (sudoErr) {
          throw new Error(
            "Packet capture requires elevated privileges and no passwordless " +
              "sudo is available. Fix: install Wireshark via " +
              "'brew install --cask wireshark' (adds the ChmodBPF helper so the " +
              "'access_bpf' group can capture without sudo), then ensure your " +
              `user is in that group. Original error: ${e.message}`
          );
        }
      }
      throw e;
    }
  },

  _isPermissionError(e) {
    const msg = (e.message || "").toLowerCase();
    return /permission|are you root|root privileg|access_bpf|\/dev\/bpf|operation not permitted|you don'?t have permission/.test(
      msg
    );
  },

  async _ensureTshark(callerId) {
    try {
      await this._runCommand("tshark", ["-v"], null, 10000);
    } catch (e) {
      if (e.code === 127 || /not found|enoent/i.test(e.message || "")) {
        const err = new Error("tshark not found");
        err.code = "ENOTSHARK";
        throw err;
      }
      // tshark exists but `-v` failed for another reason — let it proceed.
    }
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

  /** Builds a child env whose PATH includes the Homebrew/system bin dirs. */
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
        env: this._childEnv(),
      });

      let stdout = "";
      let stderr = "";
      let killedByTimeout = false;

      const timer = setTimeout(() => {
        killedByTimeout = true;
        child.kill("SIGTERM"); // graceful — lets tshark flush the pcap
      }, timeoutMs);

      child.stdout.on("data", c => (stdout += c.toString()));
      child.stderr.on("data", c => (stderr += c.toString()));

      child.on("error", err => {
        clearTimeout(timer);
        reject(err);
      });

      child.on("close", code => {
        clearTimeout(timer);
        // A timeout-terminated capture is expected to have written its file.
        if (code === 0 || code === null || killedByTimeout) {
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
