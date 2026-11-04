-- Runs once when the container is first created: a separate database for automated tests,
-- so running the test suite never wipes your demo data.
CREATE DATABASE gatekeeper_test OWNER gatekeeper;
