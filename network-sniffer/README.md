# Network Sniffer

An AnythingLLM custom agent skill that turns the Wireshark CLI (`tshark`) into a chat-driven network packet sniffer and analyzer for macOS. List interfaces, capture live traffic, filter by IP or domain, scan the network, extract contacted domains, search payloads, pull cleartext credentials, run a PII/secrets scan, follow streams and carve transferred files, inspect HTTP transactions, surface TLS/cert intel, run threat-detection heuristics, match traffic against an IOC list, and analyze existing capture files.

> ⚠️ **Authorized use only.** Only capture traffic on networks and devices you own or have explicit written permission to monitor. Intercepting other people's communications without consent may be illegal where you live. This tool performs **passive capture and analysis only** — no packet injection, spoofing, or active attacks.

## What it does

| Action | Description |
|--------|-------------|
| `interfaces` | Lists capture interfaces (`tshark -D`) |
| `capture` | Captures live traffic to a pcap file, bounded by duration/packet count |
| `target` | Captures or filters traffic for a specific IP or domain (domains are resolved to IPs) |
| `scan` | Full-network scan: protocol hierarchy, IP conversations, and top talkers |
| `domains` | Extracts contacted domains from DNS queries, TLS SNI, and HTTP Host headers |
| `search` | Searches packet payloads for a string and/or a Wireshark display filter |
| `credentials` | Extracts cleartext credentials (FTP/HTTP/IMAP/POP/SMTP) via `-z credentials` |
| `sensitive` | PII/secrets DLP scan: emails, cards (Luhn), auth headers, tokens, passwords, SSN, IBAN |
| `http` | Lists HTTP transactions (method, host, URI, status, user-agent, content-type) |
| `tls` | TLS/certificate intel: SNI, version, cipher, cert subject/expiry, weak-protocol flags |
| `threats` | Heuristic detection: port scans, ARP anomalies, plaintext auth, periodic beaconing (possible C2) |
| `follow` | Follows a TCP stream, or carves transferred files via `extract` (http/smb/tftp/imf/dicom) |
| `ioc` | Matches captured IPs/domains against a newline-separated indicator list (`iocFile`) |
| `cleanup` | Deletes temporary captures and carved objects from the sniffer temp dir |
| `analyze` | Analyzes an existing pcap/pcapng file |

## Requirements

- **macOS** with the **Wireshark CLI** installed:
  ```sh
  brew install --cask wireshark
  ```
  The cask installs `tshark`, `capinfos`, and the **ChmodBPF** helper, which grants packet-capture permission to members of the `access_bpf` group **without sudo**. (CLI only: `brew install wireshark`.)
- **Capture permissions.** Live capture reads from `/dev/bpf*`. With ChmodBPF installed and your user in the `access_bpf` group, no sudo is needed. Otherwise the skill automatically retries with `sudo -n` (non-interactive); if no passwordless sudo is configured it returns setup guidance.
- **AnythingLLM** running locally (Desktop app recommended on macOS).

## Setup

1. Copy this folder into your AnythingLLM agent-skills directory:
   ```
   plugins/agent-skills/network-sniffer/
   ```
2. Reload the AnythingLLM page — the skill appears automatically (no setup args needed).
3. Enable the skill in your agent's tool list.

## Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | string | Yes | One of the actions in the table above |
| `interface` | string | No | Interface to capture on (e.g. `en0`); defaults to the first non-loopback interface |
| `target` | string | Conditionally | IP or domain (required for `target`) |
| `duration` | number | No | Capture seconds (default 60, max 600) |
| `packetCount` | number | No | Max packets (default 5000, max 200000) |
| `captureFilter` | string | No | libpcap/BPF capture filter, e.g. `tcp port 80` |
| `displayFilter` | string | No | Wireshark display filter, e.g. `http`. Applied by `search`, `scan`, `domains`, `http`, `tls`, `threats`, `sensitive`, `analyze` |
| `searchTerm` | string | Conditionally | Substring to search payloads for (`search`); optional extra filter for `sensitive`; stream locator for `follow` |
| `pcapFile` | string | Conditionally | File to read (`analyze`) or write/read for other actions |
| `streamIndex` | number | No | TCP stream index to follow (`follow`); defaults to the first stream matching `searchTerm`/`displayFilter` |
| `extract` | string | No | For `follow`: protocol whose files to carve (`http`, `smb`, `smb2`, `tftp`, `imf`, `dicom`) |
| `iocFile` | string | Conditionally | Path to a newline-separated indicator list (required for `ioc`) |
| `outputFormat` | string | No | `json` (default), `csv`, or `ndjson` for list-style actions (`search`, `http`, `tls`, `domains`, `ioc`) |

**Capture bounds:** if neither `duration` nor `packetCount` is given, capture stops after **60s or 5000 packets**, whichever comes first. Captures are written to `os.tmpdir()/anythingllm-sniffer/` unless you provide `pcapFile`.

## Example prompts

- *"List my network capture interfaces"*
- *"Capture 200 packets on en0"*
- *"Capture all traffic to and from example.com for 30 seconds"*
- *"Run a full network scan for 60 seconds"*
- *"Which domains is my machine contacting?"*
- *"Search captured traffic for the word password"*
- *"Look for cleartext credentials on the network"*
- *"Scan the network for passwords and personal data"*
- *"List the HTTP requests in /tmp/dump.pcap"*
- *"Show TLS certificates and any weak protocol versions"*
- *"Run threat-detection heuristics on this capture"*
- *"Carve the HTTP files transferred in /tmp/dump.pcap"*
- *"Match this capture against my indicators in /tmp/iocs.txt"*
- *"Delete the temporary capture files"*
- *"Analyze the capture file at /tmp/dump.pcap"*

## Output format

All actions return JSON. Example (`domains`):

```json
{
  "action": "domains",
  "source": "live",
  "file": "/var/folders/.../anythingllm-sniffer/capture-2026-06-18T12-00-00-000Z.pcapng",
  "domains": ["api.github.com", "example.com", "ocsp.apple.com"],
  "count": 3
}
```

Example (`sensitive`) — detected values are **redacted** in previews:

```json
{
  "action": "sensitive",
  "totalFindings": 2,
  "byType": { "basic_auth": 1, "email": 1 },
  "findings": [
    { "frame": "42", "src": "10.0.0.5", "dst": "93.184.216.34", "protocol": "HTTP", "type": "basic_auth", "preview": "Auth***0= (len 34)" }
  ]
}
```

## Security & limitations

- **No shell is used.** All commands run via `spawn` with `shell: false`, so interface names, targets, and filters cannot trigger command injection. Targets are validated as IP/hostname; pcap write paths are restricted to `.pcap`/`.pcapng`.
- **Encrypted traffic stays encrypted.** `credentials` and `sensitive` only see cleartext (HTTP, FTP, POP/IMAP/SMTP, Telnet). Modern HTTPS/TLS payloads are not readable without TLS key material, so results are limited to plaintext protocols plus metadata (DNS names, TLS SNI).
- **Privacy.** The `sensitive` and `credentials` actions can surface real personal data. Redacted previews are returned, but the underlying pcap is not. To limit exposure, when these actions capture live they **auto-delete** the temporary pcap afterward (`tempDiscarded: true`); user-supplied `pcapFile`s are never deleted. Carved files from `follow --extract` and any other temp captures can be removed with the `cleanup` action.
- Live captures always self-terminate via `-a duration:N -c COUNT`, so they can't run forever or fill the disk.
- **Detection is heuristic.** `threats` flags port scans, ARP inconsistencies, plaintext auth and *regular* beaconing timing; treat results as leads, not proof. `tls` infers the protocol version from the handshake's legacy version field.

## Tips

- Run `interfaces` first to get the exact interface name (e.g. `en0` for Wi‑Fi).
- Use `captureFilter` (BPF, capture-time, efficient) to narrow what's recorded; use `displayFilter` (Wireshark syntax, read-time, richer) to narrow what's analyzed.
- Point any analysis action at an existing capture by passing `pcapFile` to skip live capture.
