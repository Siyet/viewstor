# Viewstor for Codex

This is a non-promoted local Codex package. It validates repository-marketplace installation, updates, and MCP startup. The current adapter exposes no database tools and has no broker connection.

This package is not listed in the public Codex and ChatGPT universal plugin directory.

## Install from the Git-backed repository marketplace

```bash
codex plugin marketplace add Siyet/viewstor --ref trunk
codex plugin add viewstor@viewstor
```

Restart Codex after installation, then start a new thread.

## Update

```bash
codex plugin marketplace upgrade viewstor
```

Restart Codex so the update is loaded by a new `app-server`, then start a new thread. Hot reload of an existing session is not covered by the smoke test.

The install and update smoke was verified with Codex CLI 0.172.0. It covers Git-backed CLI installation and fresh `app-server` sessions, not local-directory marketplaces, ChatGPT Desktop, or other Codex versions.
