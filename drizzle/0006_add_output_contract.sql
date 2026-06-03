-- Add per-agent output contract (JSON Schema) for deliverable validation

ALTER TABLE "agents" ADD COLUMN "output_contract" jsonb;
