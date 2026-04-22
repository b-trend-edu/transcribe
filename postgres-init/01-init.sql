-- Create the transcribe database if it doesn't exist.
-- The inngest database is already created by POSTGRES_DB.
SELECT 'CREATE DATABASE transcribe OWNER inngest'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'transcribe')\gexec
