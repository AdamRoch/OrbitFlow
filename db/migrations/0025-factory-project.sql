-- FACT-36: give clean and upgraded PostgreSQL installations one stable project
-- that the Factory Planner can discover through list_projects.
INSERT INTO projects (key, name)
VALUES ('FACT', 'Software Factory')
ON CONFLICT (key) DO NOTHING;
