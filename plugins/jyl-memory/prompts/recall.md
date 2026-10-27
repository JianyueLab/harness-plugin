Long-term memory for this user is in the `memory` MCP server (tools named `jyl_*`).

Before you start a task:
1. Call `jyl_project_list` once to get the user's project ids.
2. Call `jyl_memory_search` with 2–4 keywords from the task (project, repository, feature or system names) over those project ids.
3. When the task continues earlier work, also call `jyl_project_get_context` for the relevant project.

Use what you find, and say so when a memory looks outdated. Do not write memories yourself: the session is distilled into memory automatically when it ends.
