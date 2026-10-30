-- REN-4950 OFFLINE ONLY. Not registered as a migration, not applied to any database.
-- Explicit DBA/security review and an authority adapter are required before activation.
CREATE TABLE review_preflight_company_locks (
  company_id uuid PRIMARY KEY REFERENCES companies(id)
);

CREATE TABLE review_preflight_reservations (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 200),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{16,128}$'),
  sha text NOT NULL CHECK (sha ~ '^[0-9a-f]{40}$'),
  base_sha text NOT NULL CHECK (base_sha ~ '^[0-9a-f]{40}$'),
  tree_sha text NOT NULL CHECK (tree_sha ~ '^[0-9a-f]{40}$'),
  bundle_hash text NOT NULL CHECK (bundle_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'hold')),
  evidence jsonb,
  CONSTRAINT review_preflight_idempotency UNIQUE (company_id, actor_id, idempotency_key),
  CONSTRAINT review_preflight_expiry CHECK (expires_at = created_at + interval '1 hour'),
  CONSTRAINT review_preflight_evidence_state CHECK
    ((status = 'pending' AND evidence IS NULL) OR (status = 'hold' AND evidence IS NOT NULL))
);

CREATE UNIQUE INDEX review_preflight_one_pending_per_company
  ON review_preflight_reservations (company_id) WHERE status = 'pending';
CREATE INDEX review_preflight_recent_per_company
  ON review_preflight_reservations (company_id, created_at DESC);

-- Keep idempotency tombstones and uncertain pending work through restart and timeout.
-- No cleanup job or DELETE grant is part of this offline proposal.
CREATE FUNCTION review_preflight_preserve_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'review_preflight_retention_hold';
  END IF;
  IF (OLD.id, OLD.company_id, OLD.actor_id, OLD.idempotency_key,
      OLD.sha, OLD.base_sha, OLD.tree_sha, OLD.bundle_hash,
      OLD.created_at, OLD.expires_at) IS DISTINCT FROM
     (NEW.id, NEW.company_id, NEW.actor_id, NEW.idempotency_key,
      NEW.sha, NEW.base_sha, NEW.tree_sha, NEW.bundle_hash,
      NEW.created_at, NEW.expires_at) THEN
    RAISE EXCEPTION 'review_preflight_identity_immutable';
  END IF;
  IF OLD.status = 'hold' THEN
    RAISE EXCEPTION 'review_preflight_single_publication';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER review_preflight_preserve_identity_trigger
  BEFORE UPDATE OR DELETE ON review_preflight_reservations
  FOR EACH ROW EXECUTE FUNCTION review_preflight_preserve_identity();
