---
name: viewstor
description: Use explicitly authorized Viewstor MCP capabilities when available; this stage exposes no database tools.
---

Use only the tools currently exposed by the Viewstor MCP server. Never ask the user to paste database passwords, private keys, tokens, or other credentials into chat.

If no Viewstor database tools are available, explain that the shared local-agent runtime is required and stop. Do not substitute direct database access or invent query results.

When schema or read-only data tools become available, stay within the user's approved connection, project, and capability grants. Do not attempt writes, grant changes, or access to another connection.
