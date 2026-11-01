-- Used only when the isolated development volume is first initialized.
-- These fixed passwords are intentionally disposable local credentials.
CREATE ROLE oneshot_dev LOGIN PASSWORD 'oneshot_dev_local_only';
CREATE DATABASE oneshot_dev OWNER oneshot_dev;
REVOKE ALL ON DATABASE oneshot_dev FROM PUBLIC;

CREATE ROLE oneshot_indexer_test LOGIN PASSWORD 'oneshot_test_local_only';
CREATE DATABASE oneshot_indexer_test OWNER oneshot_indexer_test;
REVOKE ALL ON DATABASE oneshot_indexer_test FROM PUBLIC;
