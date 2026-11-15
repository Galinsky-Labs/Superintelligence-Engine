-- The integrated run engine (012) supersedes the earlier read-only queue, single-dispatch text
-- generation table, static MCP grant tables and the unused provider_models catalog table.
DROP TABLE IF EXISTS workflow_outbox, workflow_jobs, workflow_runs, text_generation_dispatches, mcp_tool_audit, mcp_tool_grants, provider_models CASCADE;
