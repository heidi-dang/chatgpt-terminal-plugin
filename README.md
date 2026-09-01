# ⚡ ChatGPT Terminal Plugin

<div align="center">

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.0.0-green.svg?logo=node.js&logoColor=white)](https://nodejs.org/)
[![MCP Specification](https://img.shields.io/badge/MCP-v2.0-purple.svg)](https://modelcontextprotocol.io/)
[![pnpm](https://img.shields.io/badge/pnpm-10.15.0-orange.svg?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![Vitest](https://img.shields.io/badge/tested%20with-vitest-yellow.svg?logo=vitest&logoColor=white)](https://vitest.dev/)
[![React 19](https://img.shields.io/badge/UI-React%2019%20%2B%20xterm.js-61DAFB.svg?logo=react&logoColor=black)](https://react.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-brightgreen.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

**Turn ChatGPT into an interactive terminal for your local development machines — with real persistent shells, secure zero-inbound tunnels, and a live xterm.js UI.**

[Quickstart](#-quickstart) • [How It Works](#-how-it-works) • [Installation](#-step-by-step-setup-guide) • [Usage Guide](#-usage-guide) • [Tools Reference](#-mcp-tools-reference) • [Deployment](#-production-deployment) • [Contributing](#-contributing)

</div>

---

## 🌟 Overview

**ChatGPT Terminal Plugin** connects ChatGPT (or any Model Context Protocol client) to your local workstations, servers, or cloud VMs.

Unlike simple "run command and return text" wrappers, this plugin gives ChatGPT a **genuine persistent pseudo-terminal (PTY)**:
- 🔄 **Preserves Shell State**: Working directories (`cd`), environment variables, virtualenvs, shell history, and background jobs persist across conversational turns.
- 🔒 **Zero Inbound Ports**: Your computer connects *outward* to the MCP server via an encrypted WebSocket tunnel. No open firewall ports, SSH exposure, or public IPs needed on your machine.
- 🖥️ **Live Interactive UI**: Includes a built-in **MCP App** widget powered by `xterm.js` that renders real-time terminal output in ChatGPT with dark/light theme syncing and smooth streaming.
- 🛡️ **Zero-Trust Security**: End-to-end device authorization using Ed25519 challenge-response signatures, granular workspace launch policies, and capability-isolated SSE streams.
- ⚡ **Seamless Reconnection**: Bounded monotonic event buffers let you resume seamlessly across network hiccups without losing cursors or duplicating output.

---

## 🏗️ Architecture

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                           ChatGPT Web / Client                          │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │ OAuth 2.1 / JWT Bearer
                                     │ MCP Streamable HTTP (/mcp)
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         Public MCP Server / Gateway                     │
│  ┌─────────────────────────┐   ┌─────────────────────────────────────┐  │
│  │   MCP Tool Handlers     │   │   Device Registry (SQLite / WAL)    │  │
│  │  - terminal_start       │   ├─────────────────────────────────────┤  │
│  │  - terminal_write       │   │   Live Session & Event Store        │  │
│  │  - terminal_read        │   │   (In-Memory or Shared Redis)       │  │
│  └────────────┬────────────┘   └──────────────────┬──────────────────┘  │
│               │                                   │                     │
│               │ Issue short-lived SSE stream capability                 │
│               ▼                                   │                     │
│  ┌─────────────────────────┐                      │                     │
│  │   MCP App Terminal UI   │◄─────────────────────┘                     │
│  │   (xterm.js in iframe)  │  Watch-only SSE Stream                     │
│  └─────────────────────────┘                                            │
└────────────────────────────────────▲────────────────────────────────────┘
                                     │
                                     │ Outbound WebSocket (/agent)
                                     │ Ed25519 Challenge-Response Auth
                                     │ (Zero inbound firewall ports on agent)
                                     │
┌────────────────────────────────────┴────────────────────────────────────┐
│                       Local Terminal Agent Machine                      │
│                                                                         │
│  ┌────────────────────────┐         ┌────────────────────────────────┐  │
│  │ Ed25519 Key Identity   │         │ Launch Root Workspace Policy   │  │
│  └───────────┬────────────┘         └───────────────┬────────────────┘  │
│              │                                      │                   │
│              ▼                                      ▼                   │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │                       node-pty Shell Engine                       │  │
│  │              (bash  /  zsh  /  PowerShell  /  WSL)                │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

### Model vs. UI Stream Separation

To ensure rock-solid stability and prevent context pollution:
1. **Model Context (`terminal_read`)**: Authoritative, strictly bounded by byte limits (`max_bytes`), and driven by monotonic cursors so ChatGPT receives exactly what it needs to reason.
2. **Human Viewer (MCP App Widget)**: Direct high-frequency SSE stream using an isolated, short-lived token. The browser widget never sees or stores your MCP OAuth credentials.

---

## 📦 Monorepo Packages

| Package | Path | Description |
|---|---|---|
| **`@terminal/protocol`** | [`packages/protocol`](packages/protocol) | Shared Zod schemas, event models, monotonic cursors, and gateway wire protocol. |
| **`@terminal/local-agent`** | [`packages/local-agent`](packages/local-agent) | Agent daemon: Ed25519 identity, outbound gateway connection, PTY lifecycle, workspace root enforcement. |
| **`@terminal/mcp-server`** | [`packages/mcp-server`](packages/mcp-server) | MCP HTTP server, OAuth/JWT verification, device registry, SSE streaming, audit logs, and transcript redaction. |
| **`@terminal/terminal-ui`** | [`packages/terminal-ui`](packages/terminal-ui) | React 19 + xterm.js terminal widget bundled as a single-file MCP App resource (`ui://terminal/v3.html`). |

---

## 🚀 Quickstart

Get up and running locally in under 3 minutes!

### Prerequisites

- **Node.js**: `v22.0.0` or newer
- **pnpm**: `v10.15.0` (managed automatically via Corepack)
- **Shell**: `bash` / `zsh` on Linux/macOS, or `PowerShell` / `WSL` on Windows

### 1. Clone and Install

```bash
git clone https://github.com/heidi-dang/chatgpt-terminal-plugin.git
cd chatgpt-terminal-plugin

# Enable Corepack and install dependencies
corepack enable
pnpm install
```

### 2. Verify Your Environment

Run the full verification suite (typecheck, lint, unit tests, and build):

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

### 3. Run Everything in Development Mode

Run the MCP server, local agent, and UI dev server concurrently with one command:

```bash
pnpm dev
```

---

## 🛠️ Step-by-Step Setup Guide

Follow this guide to set up the plugin for real-world use with ChatGPT.

### Step 1: Configure the MCP Server

Create your server environment file from the provided template:

```bash
cp deploy/server-environment.example .env.server
```

Key configuration options in `.env.server`:

```env
NODE_ENV=production
MCP_HOST=127.0.0.1
MCP_PORT=8787
MCP_PUBLIC_URL=https://terminal.example.com/mcp

# Durable SQLite device registry
AGENT_DEVICE_REGISTRY_PATH=/var/lib/chatgpt-terminal/devices.sqlite

# One-time bootstrap secret used for initial device enrollment
AGENT_ENROLLMENT_TOKEN=generate-a-strong-random-token-here

# Secret used to sign short-lived UI SSE stream capabilities (min 32 bytes)
STREAM_TOKEN_SECRET=generate-a-32-byte-random-secret-here

# Authentication mode ('jwt' or 'cloudflare-access')
MCP_AUTH_MODE=jwt
OAUTH_ISSUER=https://auth.example.com
OAUTH_JWKS_URL=https://auth.example.com/.well-known/jwks.json
OAUTH_AUDIENCE=terminal-mcp
```

### Step 2: Configure the Local Agent

On each computer you wish to control, create the agent environment file:

```bash
cp deploy/local-agent-environment.example .env.agent
```

Configure `.env.agent`:

```env
# URL pointing to your MCP server gateway
AGENT_GATEWAY_URL=wss://terminal.example.com/agent
AGENT_IDENTITY_PATH=/home/user/.config/chatgpt-terminal/device.json
AGENT_DISPLAY_NAME=MacBook Pro - Workstation

# Execution boundary: developer mode restricts PTY launch to these folders
EXECUTION_PROFILE=developer
ALLOWED_WORKSPACE_ROOTS=/home/user/projects,/home/user/work

# Initial enrollment settings (remove AGENT_ENROLLMENT_TOKEN after first run)
AGENT_ENROLLMENT_URL=https://terminal.example.com/agent/enroll
AGENT_OWNER_ID=your-oauth-user-id
AGENT_ENROLLMENT_TOKEN=generate-a-strong-random-token-here
```

### Step 3: First-Time Agent Enrollment

Start the agent once to enroll its cryptographic identity:

```bash
pnpm start:agent
```

On first startup:
1. The agent automatically generates an **Ed25519 keypair** and stores the private key securely in `AGENT_IDENTITY_PATH` (with `0600` permissions).
2. It sends its public key, `device_id`, and `agent_id` to the server using the `AGENT_ENROLLMENT_TOKEN`.
3. The server registers the device in SQLite.
4. **Security Best Practice**: Once enrolled, remove `AGENT_ENROLLMENT_TOKEN` from your agent's `.env.agent`. All subsequent connections authenticate using Ed25519 challenge-response signatures!

### Step 4: Connect to ChatGPT

1. In **ChatGPT Web**, go to **Settings** (or **Workspace Settings** on Business/Enterprise/Edu) → **Apps** → **Create**.
2. Set the MCP Endpoint URL (e.g., `https://terminal.example.com/mcp`).
3. Select **OAuth Authentication** and click **Scan Tools**.
4. Authorize via your OAuth provider.
5. Review the discovered tools and click **Create**.
6. Open a new chat with your Terminal App enabled! 🎉

---

## 💻 Usage Guide

### Human-Friendly Example Prompts

Once connected, you can converse naturally with ChatGPT:

| What you want to do | Example prompt |
|---|---|
| **Check available machines** | *"Which of my computers are currently online?"* |
| **Open a workspace** | *"Open a terminal in `/home/user/projects/web-app` on my workstation."* |
| **Run a build & test** | *"Run `pnpm test` and tell me if anything fails."* |
| **Navigate and edit** | *"Check git status, switch to the `feature-login` branch, and pull the latest changes."* |
| **Interrupt long jobs** | *"Stop the running process with Ctrl+C."* |
| **Clean up** | *"Close the active terminal session."* |

---

## 🔧 MCP Tools Reference

The server exposes 9 dedicated tools designed for precision model interaction:

| Tool Name | Parameters | Description |
|---|---|---|
| `terminal_list_agents` | *None* | Lists all enrolled online computers belonging to your authenticated account. |
| `terminal_start` | `agent_id`, `cwd?`, `shell?`, `command?`, `cols?`, `rows?` | Spawns a new persistent PTY session and returns the initial output and interactive UI widget. |
| `terminal_read` | `session_id`, `after`, `max_bytes?`, `wait_ms?` | Reads bounded terminal events starting after a sequence cursor. |
| `terminal_write` | `session_id`, `input` | Writes text/commands into the active PTY (preserving shell state). |
| `terminal_resize` | `session_id`, `cols`, `rows` | Adjusts the terminal window dimensions for responsive rendering. |
| `terminal_interrupt` | `session_id` | Sends `SIGINT` (Ctrl+C) to interrupt foreground commands. |
| `terminal_status` | `session_id` | Checks session status, agent connection health, and current cursor. |
| `terminal_stream_refresh` | `session_id`, `after` | Issues a new short-lived SSE capability token for the UI. |
| `terminal_close` | `session_id` | Terminates the PTY process and releases session resources. |

---

## 🛡️ Security & Execution Profiles

Security is built into every layer of the design.

### Execution Profiles

| Profile | Behavior | Best Used For |
|---|---|---|
| **`read-only`** | Allows listing devices and reading status. Rejects all PTY creation and write mutations. | Monitoring & auditing. |
| **`developer`** *(Default)* | Allows terminal operations, but strictly requires the initial working directory to resolve inside `ALLOWED_WORKSPACE_ROOTS` (with symlink traversal protection). | Standard daily engineering. |
| **`owner-full`** | Unrestricted launch paths on the agent machine (subject to normal OS user permissions). | Full system administration. |

> ℹ️ **Note**: The effective profile is always the **more restrictive** between what your server token permits and what the agent daemon is configured with.

### Security Highlights

- 🔑 **Ed25519 Gateway Auth**: Outbound agent connections authenticate against an expiring, single-use cryptographic challenge.
- 🪟 **Iframe & Token Isolation**: The browser widget receives an HMAC-signed token valid only for its specific session and SSE endpoint. It never touches your OAuth access token.
- 🧹 **Audit & Transcript Redaction**: Automatic pattern-based redaction filters out API keys, bearer tokens, and passwords from persistent logs.
- ⏰ **Automatic Cleanup**: Unused sessions are reclaimed after idle timeouts, and closed session records are pruned automatically.

---

## 🌐 Production Deployment

### 1. Reverse Proxy (Caddy Example)

Use Caddy to handle automatic HTTPS and WebSocket proxying:

```caddy
terminal.example.com {
    reverse_proxy 127.0.0.1:8787 {
        header_up Host {host}
        header_up X-Real-IP {remote}
        # Disable response buffering so SSE events stream instantly
        flush_interval -1
    }
}
```

### 2. Systemd Service

Example systemd unit files are provided in [`deploy/systemd/`](deploy/systemd):
- `chatgpt-terminal-mcp.service.example` — Server daemon
- `chatgpt-terminal-agent.service.example` — Local agent daemon

### 3. Multi-Node Scaling (Redis)

By default, the server runs in-memory. For horizontal scaling across multiple instances, set:
```env
REDIS_URL=redis://127.0.0.1:6379
```
This enables distributed session tracking, agent presence synchronization, and cross-node command routing.

---

## 🧪 Testing & Quality Assurance

We maintain high test coverage across unit, protocol, and end-to-end flows.

```bash
# Run unit & integration tests
pnpm test

# Run End-to-End test (Spawns a real MCP v2 client, server, agent & node-pty)
pnpm test:e2e

# Run linter
pnpm lint

# Run TypeScript type check
pnpm typecheck
```

---

## 🤝 Contributing

We love contributions! Whether you're fixing bugs, adding new shell integrations, improving the UI, or polishing docs, here's how to jump in:

### Development Workflow

1. **Fork the Repository** on GitHub.
2. **Clone your fork** and install dependencies:
   ```bash
   git clone https://github.com/YOUR_USERNAME/chatgpt-terminal-plugin.git
   cd chatgpt-terminal-plugin
   corepack enable
   pnpm install
   ```
3. **Create a Feature Branch**:
   ```bash
   git checkout -b feature/amazing-idea
   ```
4. **Make your changes** and verify tests pass:
   ```bash
   pnpm typecheck
   pnpm lint
   pnpm test
   pnpm test:e2e
   ```
5. **Commit with clear commit messages** and push to your fork.
6. **Open a Pull Request** describing what you built and why!

### 💡 Ideas & Good First Issues

- 🎨 **UI Customization**: Add new xterm.js color schemes and font configuration options.
- 🪟 **Windows Enhancements**: Improve PowerShell / WSL auto-detection and profile handling.
- 📊 **Telemetry & Metrics**: Add optional Prometheus metrics for gateway latency and event counts.
- 📑 **Session History Tab**: Enhance the MCP App with a tabbed interface for multiple active terminals.

---

## 📄 License

This project is open-source software licensed under the **[MIT License](LICENSE)**.

---

<div align="center">
Built with ❤️ for the open-source and AI developer community. If you find this project useful, please star ⭐ the repo!
</div>
