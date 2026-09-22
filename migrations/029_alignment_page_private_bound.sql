-- D032 §1: the page size Meeting enforces is the gateway's WIRE page bound,
-- and the private bigint-tagged re-encoding of a wire page needs its own,
-- larger bound.
--
-- Migration 021 stored a page under a 32768-byte CHECK, the same number the
-- gateway caps a WIRE page at. The private encoding tags every integer that
-- may exceed 2^53 as {"bigint":...,"decimal":"..."} and runs about 1.4x the
-- wire bytes, so a full wire page could never be stored: any capture past
-- roughly twenty frames failed its alignment traversal with `read_failed`,
-- and every artifact build behind it failed with `alignment_failed`.
--
-- The bound becomes two wire pages. No page is ever truncated to fit: a page
-- whose encoding exceeds it is refused in the same transaction as the rest of
-- the attempt, exactly as before.
--
-- SQLite cannot alter a CHECK in place, so the table is rebuilt. Stored rows
-- all satisfied the old, stricter bound and are carried over unchanged.

CREATE TABLE recording_alignment_pages_029 (
  attempt_id TEXT NOT NULL REFERENCES recording_alignment_attempts(attempt_id),
  page_index INTEGER NOT NULL CHECK(page_index BETWEEN 0 AND 249999),
  entry_count INTEGER NOT NULL CHECK(entry_count BETWEEN 1 AND 64),
  payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) BETWEEN 1 AND 65536),
  PRIMARY KEY(attempt_id,page_index)
) STRICT;

INSERT INTO recording_alignment_pages_029(attempt_id,page_index,entry_count,payload)
  SELECT attempt_id,page_index,entry_count,payload FROM recording_alignment_pages;

DROP TABLE recording_alignment_pages;
ALTER TABLE recording_alignment_pages_029 RENAME TO recording_alignment_pages;
