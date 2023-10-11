-- Type: UNDO
-- Name: add_default_value_to_updated_at
-- Description: Add default = now() to updated_at field in profile, labels and highlight table

BEGIN;

ALTER TABLE omnivore.user_profile ALTER COLUMN updated_at DROP NOT NULL;

ALTER TABLE omnivore.labels ALTER COLUMN updated_at DROP NOT NULL;

ALTER TABLE omnivore.highlight ALTER COLUMN updated_at DROP NOT NULL;

COMMIT;
