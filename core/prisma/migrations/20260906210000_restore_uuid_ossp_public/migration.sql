-- Nango's upstream bootstrap migrations call uuid_generate_v4() without a
-- schema qualifier. A historical archive migration moved uuid-ossp into
-- legacy_public, which makes that function invisible to a normal connection.
-- Keep application tables in hivemind while restoring the extension's standard
-- public location for independently managed services such as Nango.
ALTER EXTENSION "uuid-ossp" SET SCHEMA public;
