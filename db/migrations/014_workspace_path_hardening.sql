-- Workspace paths may never address a Git directory (prevents planting .git/config in materialized trees).
DELETE FROM workspace_files WHERE path ~* '(^|/)\.git(/|$)';
ALTER TABLE workspace_files ADD CONSTRAINT workspace_files_no_git CHECK (path !~* '(^|/)\.git(/|$)');
