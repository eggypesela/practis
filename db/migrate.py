#!/usr/bin/env python3
"""PRACTIS migration runner (spec §4.6).

Applies db/migrations/NNN_*.sql in filename order, one transaction each,
records SHA-256 checksums in schema_migrations, tracks PRAGMA user_version.

Usage:
  python3 migrate.py            # apply pending to ./data/practis.db (DB_PATH env or default)
  python3 migrate.py --check    # dry run: report pending, change nothing
"""
import hashlib
import os
import sqlite3
import sys
from pathlib import Path

DB_PATH = os.environ.get("DB_PATH", "data/practis.db")
MIGRATIONS_DIR = Path(__file__).parent / "migrations"


def list_migrations() -> list[tuple[int, Path]]:
    out = []
    for p in sorted(MIGRATIONS_DIR.glob("*.sql")):
        n = int(p.name.split("_", 1)[0])
        out.append((n, p))
    return out


def applied_checksums(con: sqlite3.Connection) -> dict[int, str]:
    try:
        rows = con.execute("SELECT migration_id, checksum FROM schema_migrations").fetchall()
        return {mid: csum for mid, csum in rows}
    except sqlite3.OperationalError:
        return {}


def split_statements(sql: str) -> list[str]:
    """Split a SQL script into complete statements.

    sqlite3.complete_statement() keeps CREATE TRIGGER bodies (BEGIN...END with
    inner semicolons) whole — a naive split(';') would corrupt them. Statements
    whose text is only `PRAGMA user_version` are dropped: the runner owns the
    version tracking, and the file must not fight it. Trailing comment-only
    buffer is tolerated.
    """
    stmts, buf = [], ""
    for line in sql.splitlines():
        buf += line + "\n"
        if sqlite3.complete_statement(buf):
            stmt = buf.strip()
            if stmt and not stmt.upper().startswith("PRAGMA USER_VERSION"):
                stmts.append(stmt)
            buf = ""
    trailing = buf.strip()
    if trailing and not all(
        not ln.strip() or ln.strip().startswith("--") for ln in trailing.splitlines()
    ):
        raise ValueError(f"incomplete SQL statement: {trailing[:80]!r}...")
    return stmts


def apply_script(con: sqlite3.Connection, sql: str) -> None:
    """Execute a migration script inside ONE transaction.

    sqlite3.executescript() implicitly commits any pending transaction before
    running, so it cannot be used for atomic migrations. Split into complete
    statements (trigger bodies stay whole) and execute each inside our own
    BEGIN/COMMIT instead.
    """
    for stmt in split_statements(sql):
        con.execute(stmt)


def main() -> int:
    check_only = "--check" in sys.argv
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_PATH)
    con.execute("PRAGMA foreign_keys = ON")

    con.execute(
        "CREATE TABLE IF NOT EXISTS schema_migrations ("
        "  migration_id INTEGER PRIMARY KEY,"
        "  checksum     TEXT NOT NULL,"
        "  applied_at   TEXT NOT NULL DEFAULT (datetime('now'))"
        ")"
    )
    all_m = list_migrations()
    done = applied_checksums(con)
    pending = [(n, p) for n, p in all_m if n not in done]
    # Verify checksums of ALL known migrations, applied or not: a file changed
    # after apply must fail even on --check, before any new apply happens.
    for n, p in all_m:
        if n in done:
            csum = hashlib.sha256(p.read_text().encode()).hexdigest()
            if done[n] != csum:
                print(f"FAIL: migration {n} checksum mismatch — file changed after apply", file=sys.stderr)
                return 1
    for n, p in pending:
        sql = p.read_text()
        csum = hashlib.sha256(sql.encode()).hexdigest()
        try:
            con.execute("BEGIN")
            apply_script(con, sql)
            con.execute(
                "INSERT INTO schema_migrations (migration_id, checksum) VALUES (?, ?)", (n, csum)
            )
            con.execute(f"PRAGMA user_version = {n}")
            con.execute("COMMIT")
            print(f"applied {p.name} (user_version={n})")
        except sqlite3.Error as e:
            if con.in_transaction:
                con.execute("ROLLBACK")
            print(f"FAIL: {p.name}: {e}", file=sys.stderr)
            return 1


if __name__ == "__main__":
    sys.exit(main())