-- SIE-018: privileged lifecycle state. Never grant provider or public database roles direct access.
CREATE TABLE media_tasks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 provider_id text NOT NULL,
 provider_task_id text NOT NULL,
 modality text NOT NULL CHECK(modality IN ('image','music','video')),
 reservation_id uuid NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','completed','failed','cancelled')),
 output jsonb,
 rights jsonb,
 actual_micro bigint CHECK(actual_micro>=0),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(provider_id,provider_task_id),
 UNIQUE(tenant_id,reservation_id),
 UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,reservation_id) REFERENCES budget_reservations(tenant_id,id)
);
CREATE TABLE media_callbacks (
 provider_id text NOT NULL,
 callback_id text NOT NULL,
 task_id uuid NOT NULL REFERENCES media_tasks(id) ON DELETE CASCADE,
 digest text NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(provider_id,callback_id)
);
CREATE TABLE media_dispatches (
 tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 dispatch_key text NOT NULL CHECK(length(dispatch_key) BETWEEN 1 AND 128),
 provider_id text NOT NULL,
 modality text NOT NULL CHECK(modality IN ('image','music','video')),
 reservation_id uuid NOT NULL,
 request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'started' CHECK(state IN ('started','registered')),
 provider_task_id text,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,dispatch_key),
 UNIQUE(tenant_id,reservation_id),
 FOREIGN KEY(tenant_id,reservation_id) REFERENCES budget_reservations(tenant_id,id)
);
CREATE TABLE media_task_assets (
 tenant_id uuid NOT NULL,
 task_id uuid NOT NULL,
 asset_id uuid NOT NULL,
 PRIMARY KEY(task_id,asset_id),
 FOREIGN KEY(tenant_id,task_id) REFERENCES media_tasks(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,asset_id) REFERENCES asset_metadata(tenant_id,id)
);
REVOKE ALL ON media_tasks,media_callbacks,media_dispatches,media_task_assets FROM PUBLIC;
ALTER TABLE media_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_tasks FORCE ROW LEVEL SECURITY;
ALTER TABLE media_callbacks ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_callbacks FORCE ROW LEVEL SECURITY;
ALTER TABLE media_dispatches ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_dispatches FORCE ROW LEVEL SECURITY;
ALTER TABLE media_task_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_task_assets FORCE ROW LEVEL SECURITY;
