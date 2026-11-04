# SIE-030: admission policy only

This small approved-package increment rejects unbounded or unsafe sandbox
requests before any runtime is contacted. The current policy permits Node 22
and Python 3 identifiers with explicit bounds on CPU, RAM and wall clock.
Host mounts, environment secrets and network access must be absent.

IMPORTANT: This DOES NOT create a secure sandbox. A trusted isolated broker
must enforce quotas, reject privilege escalation, disable network egress,
provide ephemeral filesystem isolation, terminate processes and retain audits.
Do not execute untrusted code with this validator alone. Actual JavaScript,
TypeScript and Python runtimes, terminal streaming, LSP, package management,
patch proposal authorization, negative escape tests and deployment remain pending.
