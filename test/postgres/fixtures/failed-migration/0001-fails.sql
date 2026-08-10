CREATE TABLE must_roll_back_with_failed_migration (
  id BIGINT PRIMARY KEY
);

SELECT * FROM deliberately_missing_table;
